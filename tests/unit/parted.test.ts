// A file past the part size is cached as parts and an index (`src/parted.ts`); the part size is
// learned from a part the cache refuses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CACHE_NAME, StaleCache, fetchFile, fetchRange, streamFile, type FetchOptions, type Hasher, type StreamOptions } from "../../src/hub";
import { ModelsError } from "../../src/errors";
import { MIN_PART_BYTES, PART_BYTES, PART_POLICY_URL, PART_PROBE_REFUSED_URL, PART_PROBE_URL, indexUrl, partBytesFor, partUrl } from "../../src/parted";
import { FakeCache, FakeCaches, FakeFetch } from "./fake-fetch";

const BASE = "http://hub.test";
const URL_A = `${BASE}/org/model/resolve/main/model.gguf`;
const PART = MIN_PART_BYTES;
/** Four parts and a fifth of 100 bytes, every byte telling its offset. */
const SIZE = 4 * PART + 100;
const BYTES = new Uint8Array(SIZE).map((_, i) => (i * 31 + (i >> 8)) & 0xff);
const SHA = createHash("sha256").update(BYTES).digest("hex");

/** Whether two byte arrays are equal (a deep-equality matcher walks 256 KiB an element at a time). */
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

let ff: FakeFetch;
let caches: FakeCaches;
let cache: FakeCache;

const opts = (extra: Partial<FetchOptions> = {}): FetchOptions => ({ hubBaseUrl: BASE, offline: false, ...extra });
/** How many hashers a call made: one per pass over the bytes. */
let hashers = 0;
const nodeHasher = (): Hasher => {
  hashers += 1;
  const h = createHash("sha256");
  return { update: (b) => void h.update(b), finish: () => h.digest("hex") };
};
/** Streams the file, returning the call's answer and the bytes delivered, placed at their offsets. */
async function stream(extra: Partial<StreamOptions> = {}) {
  const got = new Uint8Array(SIZE);
  let delivered = 0;
  const onChunk = (b: Uint8Array, at: number) => {
    got.set(b, at);
    delivered += b.byteLength;
  };
  const r = await streamFile("org/model", "main", "model.gguf", { ...opts(), hasher: nodeHasher, onChunk, ...extra });
  return { r, got, delivered };
}
async function rejection(p: Promise<unknown>): Promise<ModelsError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelsError);
    return e as ModelsError;
  }
  throw new Error("expected a rejection");
}
/** The body in three network chunks that straddle the part boundaries, with or without its length. */
const serve = (length = true) =>
  ff.routes.set(URL_A, {
    chunks: [BYTES.slice(0, PART - 7), BYTES.slice(PART - 7, 3 * PART + 5), BYTES.slice(3 * PART + 5)],
    headers: length ? { "content-length": String(SIZE) } : {},
  });
const setPartBytes = (n: number) => cache.put(PART_POLICY_URL, new Response(String(n)));
/** A probe refused at `n` bytes, as this browser (`agent`: another's) would have left it. */
const setProbeRefused = (n: number, agent = navigator.userAgent) => cache.put(PART_PROBE_REFUSED_URL, new Response(JSON.stringify({ bytes: n, agent })));
const probeRefused = async () => {
  const hit = cache.entries.get(PART_PROBE_REFUSED_URL);
  return hit ? ((await hit.clone().json()) as { bytes: number; agent: string }) : null;
};
/** The cache's keys for the file, the policy and probe entries aside. */
const keys = () => [...cache.entries.keys()].filter((k) => k !== PART_POLICY_URL && k !== PART_PROBE_REFUSED_URL).sort();
const partKeys = (n: number, count: number) => Array.from({ length: count }, (_, i) => partUrl(URL_A, n, i));

beforeEach(async () => {
  ff = new FakeFetch();
  caches = new FakeCaches();
  vi.stubGlobal("fetch", ff.fetch);
  vi.stubGlobal("caches", caches);
  cache = await caches.open(CACHE_NAME);
  await setPartBytes(PART);
  // A browser whose cap is just past one part, known: no probe runs unless a test removes this.
  await setProbeRefused(2 * PART);
});
afterEach(() => vi.unstubAllGlobals());

describe("streamFile past the part size", () => {
  it("writes_parts_and_an_index_and_no_whole_entry_and_a_second_call_streams_them_with_no_request", async () => {
    serve();
    const first = await stream();
    expect(first.r).toEqual({ source: "network", verified: false, cached: true, loaded: SIZE });
    expect(same(first.got, BYTES)).toBe(true);
    expect(keys()).toEqual([indexUrl(URL_A), ...partKeys(PART, 5)].sort());
    const lengths = await Promise.all(partKeys(PART, 5).map(async (k) => (await cache.entries.get(k)!.clone().arrayBuffer()).byteLength));
    expect(lengths).toEqual([PART, PART, PART, PART, 100]);
    const index = cache.entries.get(indexUrl(URL_A))!.headers;
    expect([index.get("x-caldrix-bytes"), index.get("x-caldrix-part-bytes"), index.get("x-caldrix-parts"), index.get("x-caldrix-verified")]).toEqual([
      String(SIZE),
      String(PART),
      "5",
      "0",
    ]);

    const second = await stream();
    expect(second.r).toEqual({ source: "cache", verified: false, cached: true, loaded: SIZE });
    expect(same(second.got, BYTES)).toBe(true);
    expect(ff.calls).toHaveLength(1);
  });

  it("a_pinned_file_is_hashed_from_its_parts_then_delivered_and_a_wrong_pin_drops_them_and_fetches_again", async () => {
    serve();
    expect((await stream({ sha256: SHA })).r).toEqual({ source: "network", verified: true, cached: true, loaded: SIZE });
    const hit = await stream({ sha256: SHA });
    expect(hit.r).toEqual({ source: "cache", verified: true, cached: true, loaded: SIZE });
    expect(same(hit.got, BYTES)).toBe(true);
    expect(ff.calls).toHaveLength(1);

    // A part that is not the file's: the pin fails before a byte is delivered, and the file is fetched.
    await cache.put(partUrl(URL_A, PART, 2), new Response(new Uint8Array(PART)));
    const again = await stream({ sha256: SHA });
    expect(again.r.source).toBe("network");
    expect(same(again.got, BYTES)).toBe(true);
    expect(again.delivered).toBe(SIZE);
    expect(ff.calls).toHaveLength(2);
    // Offline, the same copy is refused as the alias's pin failing.
    await cache.put(partUrl(URL_A, PART, 2), new Response(new Uint8Array(PART)));
    const e = await rejection(stream({ sha256: SHA, offline: true }));
    expect(e.message).toBe("model.gguf: the cached copy fails the alias's sha256 pin and offline is set");
    expect(keys()).toEqual([]);
  });

  it("a_body_of_no_declared_length_is_written_as_parts_and_one_within_the_part_size_as_one_entry", async () => {
    serve(false);
    expect((await stream()).r.cached).toBe(true);
    expect(keys()).toContain(indexUrl(URL_A));
    expect(keys()).not.toContain(URL_A);

    cache.entries.clear();
    await setPartBytes(PART_BYTES);
    serve();
    expect((await stream()).r.cached).toBe(true);
    expect(keys()).toEqual([URL_A]);
    expect((await stream()).r.source).toBe("cache");
  });

  it("a_missing_part_is_no_cached_copy_the_file_is_fetched_again_and_offline_it_is_uncached", async () => {
    for (const pin of [{}, { sha256: SHA }]) {
      cache.entries.clear();
      await setPartBytes(PART);
      await setProbeRefused(2 * PART);
      ff.calls.length = 0;
      serve();
      await stream(pin);
      cache.entries.delete(partUrl(URL_A, PART, 3));
      const again = await stream(pin);
      expect(again.r.source).toBe("network");
      expect(again.delivered).toBe(SIZE);
      expect(same(again.got, BYTES)).toBe(true);
      expect(ff.calls).toHaveLength(2);
      expect(keys()).toHaveLength(6);

      cache.entries.delete(partUrl(URL_A, PART, 0));
      const e = await rejection(stream({ ...pin, offline: true }));
      expect([e.kind, e.missing]).toEqual(["fetch", "offline-uncached"]);
      expect(keys()).toEqual([]);
    }
  });

  it("a_part_shorter_than_the_index_says_is_a_missing_part", async () => {
    serve();
    await stream({ sha256: SHA });
    await cache.put(partUrl(URL_A, PART, 1), new Response(BYTES.slice(PART, PART + 10)));
    expect((await stream({ sha256: SHA })).r.source).toBe("network");
  });

  it("an_index_that_does_not_add_up_is_ignored", async () => {
    serve();
    await stream();
    const good = cache.entries.get(indexUrl(URL_A))!;
    for (const [name, value] of [
      ["x-caldrix-parts", "4"],
      ["x-caldrix-bytes", "-1"],
      ["x-caldrix-part-bytes", "0"],
    ]) {
      const headers = new Headers(good.headers);
      headers.set(name, value);
      cache.entries.set(indexUrl(URL_A), new Response(null, { headers }));
      const e = await rejection(stream({ offline: true }));
      expect([name, e.missing]).toEqual([name, "offline-uncached"]);
    }
  });

  it("a_failed_check_leaves_no_part_and_never_removes_a_whole_entry_it_did_not_write", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "content-length": String(SIZE), "x-linked-etag": "0".repeat(64) } });
    const e = await rejection(stream());
    expect(e.kind).toBe("digest");
    expect(keys()).toEqual([]);

    // Another writer's whole copy, committed while this call streams a body that fails its check.
    const got: number[] = [];
    const onChunk = async (b: Uint8Array) => {
      await cache.put(URL_A, new Response(BYTES, { headers: { "x-caldrix-verified": "1" } }));
      got.push(b.byteLength);
    };
    await rejection(streamFile("org/model", "main", "model.gguf", { ...opts(), hasher: nodeHasher, onChunk }));
    expect(keys()).toEqual([URL_A]);
  });

  it("an_abort_mid_stream_leaves_no_part", async () => {
    const ac = new AbortController();
    serve();
    let seen = 0;
    const onChunk = (b: Uint8Array) => {
      seen += b.byteLength;
      if (seen > 2 * PART) ac.abort();
    };
    const e = await rejection(streamFile("org/model", "main", "model.gguf", { ...opts({ signal: ac.signal }), hasher: nodeHasher, onChunk }));
    expect(e.kind).toBe("fetch");
    expect(keys()).toEqual([]);
  });
});

describe("the part size is learned from a part the cache refuses", () => {
  it("a_refused_part_halves_the_size_the_load_goes_on_uncached_and_a_later_load_caches_at_a_size_it_takes", async () => {
    await setPartBytes(4 * PART);
    cache.maxEntryBytes = PART + 1; // the browser's cap, which nothing announces
    serve();
    const first = await stream();
    expect(first.r).toEqual({ source: "network", verified: false, cached: false, loaded: SIZE });
    expect(same(first.got, BYTES)).toBe(true);
    expect(keys()).toEqual([]);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(2 * PART);

    expect((await stream()).r.cached).toBe(false);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(PART);

    const third = await stream();
    expect(third.r.cached).toBe(true);
    expect(keys()).toEqual([indexUrl(URL_A), ...partKeys(PART, 5)].sort());
    const fourth = await stream();
    expect(fourth.r.source).toBe("cache");
    expect(same(fourth.got, BYTES)).toBe(true);
    expect(ff.calls).toHaveLength(3);
  });

  it("a_refusal_at_the_smallest_size_is_not_answered_by_a_smaller_one_and_a_full_disk_teaches_nothing", async () => {
    cache.maxEntryBytes = 10;
    serve();
    expect((await stream()).r.cached).toBe(false);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(MIN_PART_BYTES);
    expect(keys()).toEqual([]);

    await setPartBytes(4 * PART);
    cache.maxEntryBytes = PART;
    cache.capError = "QuotaExceededError";
    expect((await stream()).r.cached).toBe(false);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(4 * PART);
  });

  it("a_refused_whole_entry_brings_the_size_below_the_files_and_the_next_write_is_parts", async () => {
    // Within the remembered size the file is one entry, which this cache refuses.
    await setPartBytes(32 * PART);
    cache.maxEntryBytes = PART + 1;
    serve();
    const first = await stream();
    expect(first.r).toEqual({ source: "network", verified: false, cached: false, loaded: SIZE });
    expect(same(first.got, BYTES)).toBe(true);
    expect(keys()).toEqual([]);
    // 16 and 8 parts' worth would still hold the file whole: the largest halving below it is 4.
    expect(await partBytesFor(cache as unknown as Cache)).toBe(4 * PART);

    expect((await stream()).r.cached).toBe(false);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(2 * PART);
    expect((await stream()).r.cached).toBe(false);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(PART);
    expect((await stream()).r.cached).toBe(true);
    expect(keys()).toEqual([indexUrl(URL_A), ...partKeys(PART, 5)].sort());
  });

  it("fetchFile_learns_from_a_refused_whole_entry_too", async () => {
    await setPartBytes(8 * PART);
    cache.maxEntryBytes = PART + 1;
    serve();
    const f = await fetchFile("org/model", "main", "model.gguf", opts());
    expect(f.cached).toBe(false);
    expect(same(f.bytes, BYTES)).toBe(true);
    expect(keys()).toEqual([]);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(4 * PART);
  });

  it("a_refused_whole_entry_no_larger_than_the_smallest_part_and_a_full_disk_teach_nothing", async () => {
    const small = BYTES.slice(0, PART);
    const url = `${BASE}/org/model/resolve/main/small.bin`;
    ff.routes.set(url, { chunks: [small], headers: { "content-length": String(small.byteLength) } });
    await setPartBytes(8 * PART);
    cache.maxEntryBytes = 10;
    expect((await fetchFile("org/model", "main", "small.bin", opts())).cached).toBe(false);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(8 * PART);

    cache.maxEntryBytes = PART + 1;
    cache.capError = "QuotaExceededError";
    serve();
    expect((await stream()).r.cached).toBe(false);
    expect((await fetchFile("org/model", "main", "model.gguf", opts())).cached).toBe(false);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(8 * PART);
  });

  it("the_size_starts_at_PART_BYTES_and_a_remembered_size_outside_its_bounds_is_ignored", async () => {
    cache.entries.clear();
    expect(await partBytesFor(cache as unknown as Cache)).toBe(PART_BYTES);
    for (const bad of ["12", String(PART_BYTES * 2), "many", ""]) {
      await cache.put(PART_POLICY_URL, new Response(bad));
      expect([bad, await partBytesFor(cache as unknown as Cache)]).toEqual([bad, PART_BYTES]);
    }
    cache.failMatch = new Error("no cache");
    expect(await partBytesFor(cache as unknown as Cache)).toBe(PART_BYTES);
  });

  it("a_named_start_is_the_size_with_none_learned_and_the_most_a_learned_one_may_be", async () => {
    cache.entries.clear();
    expect(await partBytesFor(cache as unknown as Cache, 4 * PART_BYTES)).toBe(4 * PART_BYTES);
    await cache.put(PART_POLICY_URL, new Response(String(2 * PART_BYTES)));
    expect(await partBytesFor(cache as unknown as Cache, 4 * PART_BYTES)).toBe(2 * PART_BYTES);
    // The package's own loads name no start: a size past PART_BYTES is not theirs.
    expect(await partBytesFor(cache as unknown as Cache)).toBe(PART_BYTES);
  });

  it("a_write_at_a_new_size_removes_the_parts_an_earlier_size_left", async () => {
    serve();
    await stream();
    cache.entries.delete(indexUrl(URL_A)); // a set without its index: a write that was cut short
    await setPartBytes(2 * PART);
    await stream();
    expect(keys()).toEqual([indexUrl(URL_A), ...partKeys(2 * PART, 3)].sort());
  });
});

describe("fetchFile and fetchRange over parts", () => {
  const get = (extra: Partial<FetchOptions> = {}) => fetchFile("org/model", "main", "model.gguf", opts(extra));

  it("fetchFile_writes_a_body_past_the_part_size_as_parts_and_reads_it_back_whole", async () => {
    serve();
    const first = await get({ sha256: SHA });
    expect([first.source, first.verified, first.cached]).toEqual(["network", true, true]);
    expect(keys()).toEqual([indexUrl(URL_A), ...partKeys(PART, 5)].sort());
    const second = await get({ sha256: SHA });
    expect([second.source, second.verified, second.cached]).toEqual(["cache", true, true]);
    expect(same(second.bytes, BYTES)).toBe(true);
    // Unpinned, the index's verified mark is the answer.
    expect((await get()).verified).toBe(true);
    expect(ff.calls).toHaveLength(1);

    cache.entries.delete(partUrl(URL_A, PART, 4));
    expect((await get({ sha256: SHA })).source).toBe("network");
    expect(ff.calls).toHaveLength(2);
  });

  it("fetchFile_fetches_again_when_a_part_is_no_longer_the_bytes_cached_and_no_pin_applies", async () => {
    serve();
    await get();
    expect(cache.entries.get(indexUrl(URL_A))!.headers.get("x-caldrix-sha256")).toBe(SHA);
    // One part's body changed, its length kept: the index's digest tells.
    const bad = new Uint8Array(await cache.entries.get(partUrl(URL_A, PART, 2))!.clone().arrayBuffer());
    bad[7] ^= 0xff;
    cache.entries.set(partUrl(URL_A, PART, 2), new Response(bad));
    const again = await get();
    expect([again.source, again.cached]).toEqual(["network", true]);
    expect(same(again.bytes, BYTES)).toBe(true);
    expect(ff.calls).toHaveLength(2);
    expect((await get()).source).toBe("cache");
    expect(ff.calls).toHaveLength(2);
  });

  it("fetchFile_learns_from_a_refused_part_and_leaves_nothing", async () => {
    await setPartBytes(2 * PART);
    cache.maxEntryBytes = PART;
    serve();
    const r = await get();
    expect([r.source, r.cached]).toEqual(["network", false]);
    expect(same(r.bytes, BYTES)).toBe(true);
    expect(keys()).toEqual([]);
    expect(await partBytesFor(cache as unknown as Cache)).toBe(PART);
    expect((await get()).cached).toBe(true);
  });

  it("fetchRange_reads_an_extent_from_the_parts_that_hold_it_and_asks_the_hub_when_one_is_missing", async () => {
    serve();
    await stream();
    const range = (length: number, start: number) => fetchRange("org/model", "main", "model.gguf", length, opts(), start);
    for (const [start, length] of [
      [0, 16],
      [PART - 3, 9], // across a boundary
      [PART - 1, 2 * PART + 2], // across three parts
      [SIZE - 100, 100], // the last part, whole
      [SIZE - 5, 5],
    ]) {
      expect([start, same(await range(length, start), BYTES.slice(start, start + length))]).toEqual([start, true]);
    }
    expect(ff.calls).toHaveLength(1);

    cache.entries.delete(partUrl(URL_A, PART, 1));
    ff.routes.set(URL_A, { status: 206, chunks: [BYTES.slice(PART - 3, PART + 6)] });
    expect([...(await range(9, PART - 3))]).toEqual([...BYTES.slice(PART - 3, PART + 6)]);
    expect(ff.calls).toHaveLength(2);
    // An extent the parts that remain hold is still served from them.
    expect([...(await range(4, 0))]).toEqual([...BYTES.slice(0, 4)]);
    expect(ff.calls).toHaveLength(2);
  });
});

describe("a lowered part size is probed back up once a file is cached", () => {
  /** The most a probe grows the size to in these tests (the package's own is PART_BYTES). */
  const START = 8 * PART;
  beforeEach(() => void cache.entries.delete(PART_PROBE_REFUSED_URL));

  it("a_cache_that_takes_every_size_brings_the_size_back_to_the_start_and_leaves_no_scratch_entry", async () => {
    serve();
    const first = await stream({ startPartBytes: START });
    expect(first.r.cached).toBe(true);
    expect(keys()).toEqual([indexUrl(URL_A), ...partKeys(PART, 5)].sort());
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(START);
    expect(cache.entries.has(PART_PROBE_URL)).toBe(false);
    expect(await probeRefused()).toBeNull();
  });

  it("the_start_is_probed_first_so_a_cache_that_takes_it_is_back_after_one_scratch_write", async () => {
    const put = vi.spyOn(cache, "put");
    serve();
    expect((await stream({ startPartBytes: START })).r.cached).toBe(true);
    expect(put.mock.calls.filter(([url]) => url === PART_PROBE_URL)).toHaveLength(1);
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(START);
  });

  it("a_cache_that_takes_every_doubling_below_the_start_remembers_the_start_as_refused", async () => {
    cache.maxEntryBytes = 4 * PART + 1;
    const put = vi.spyOn(cache, "put");
    serve();
    expect((await stream({ startPartBytes: START })).r.cached).toBe(true);
    // The start, then 2 and 4 parts' worth; the start is not written a second time.
    expect(put.mock.calls.filter(([url]) => url === PART_PROBE_URL)).toHaveLength(3);
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(4 * PART);
    expect(await probeRefused()).toEqual({ bytes: START, agent: navigator.userAgent });
    expect(cache.entries.has(PART_PROBE_URL)).toBe(false);
  });

  it("the_first_size_the_cache_refuses_ends_the_probes_and_is_remembered_with_the_browser_and_not_probed_again", async () => {
    cache.maxEntryBytes = 2 * PART + 1;
    serve();
    expect((await stream({ startPartBytes: START })).r.cached).toBe(true);
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(2 * PART);
    expect(await probeRefused()).toEqual({ bytes: 4 * PART, agent: navigator.userAgent });
    expect(cache.entries.has(PART_PROBE_URL)).toBe(false);

    // The cap gone, the remembered refusal still holds: the next cached file probes nothing.
    cache.maxEntryBytes = undefined;
    cache.entries.delete(indexUrl(URL_A));
    expect((await stream({ startPartBytes: START })).r.cached).toBe(true);
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(2 * PART);
  });

  it("a_refusal_another_browser_left_is_not_this_ones_and_a_full_disk_is_not_remembered", async () => {
    await setProbeRefused(2 * PART, "another browser");
    serve();
    expect((await stream({ startPartBytes: START })).r.cached).toBe(true);
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(START);

    await setPartBytes(PART);
    cache.entries.delete(PART_PROBE_REFUSED_URL);
    cache.entries.delete(indexUrl(URL_A));
    cache.maxEntryBytes = PART;
    cache.capError = "QuotaExceededError";
    expect((await stream({ startPartBytes: START })).r.cached).toBe(true);
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(PART);
    expect(await probeRefused()).toBeNull();
  });

  it("fetchFile_probes_too_and_a_size_at_the_start_or_a_file_cached_whole_probes_nothing", async () => {
    serve();
    expect((await fetchFile("org/model", "main", "model.gguf", opts({ startPartBytes: 2 * PART }))).cached).toBe(true);
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(2 * PART);

    // A file within the size is one whole entry, and probes nothing: a probe here would be refused, and remembered.
    cache.entries.clear();
    await setPartBytes(6 * PART);
    cache.maxEntryBytes = 7 * PART;
    expect((await stream({ startPartBytes: START })).r.cached).toBe(true);
    expect(keys()).toEqual([URL_A]);
    expect(await probeRefused()).toBeNull();
    expect(await partBytesFor(cache as unknown as Cache, START)).toBe(6 * PART);
  });
});

describe("a cached copy under a pin read once (singlePass)", () => {
  const once = { sha256: SHA, singlePass: true };

  it("is_hashed_as_it_is_delivered_one_pass_where_the_default_makes_two", async () => {
    serve();
    await stream(once);
    hashers = 0;
    const hit = await stream(once);
    expect(hit.r).toEqual({ source: "cache", verified: true, cached: true, loaded: SIZE });
    expect(same(hit.got, BYTES)).toBe(true);
    expect(hashers).toBe(1);
    expect(ff.calls).toHaveLength(1);

    hashers = 0;
    expect((await stream({ sha256: SHA })).r.source).toBe("cache");
    expect(hashers).toBe(2);
  });

  it("a_copy_that_fails_the_pin_is_dropped_after_its_bytes_were_delivered_and_the_next_call_fetches", async () => {
    serve();
    await stream(once);
    await cache.put(partUrl(URL_A, PART, 2), new Response(new Uint8Array(PART)));
    let delivered = 0;
    const e = await rejection(stream({ ...once, onChunk: (b) => void (delivered += b.byteLength) }));
    expect(e).toBeInstanceOf(StaleCache);
    expect(e.kind).toBe("digest");
    expect(delivered).toBe(SIZE);
    expect(keys()).toEqual([]);
    expect(ff.calls).toHaveLength(1);

    const again = await stream(once);
    expect(again.r).toEqual({ source: "network", verified: true, cached: true, loaded: SIZE });
    expect(same(again.got, BYTES)).toBe(true);
    expect(ff.calls).toHaveLength(2);
  });

  it("a_part_gone_is_a_stale_copy_too_and_offline_the_refusal_is_the_pins", async () => {
    serve();
    await stream(once);
    cache.entries.delete(partUrl(URL_A, PART, 3));
    // The index says a part the cache has not got: no cached copy, so the file is fetched (nothing was delivered).
    expect((await stream(once)).r.source).toBe("network");

    await cache.put(partUrl(URL_A, PART, 2), new Response(new Uint8Array(PART)));
    const e = await rejection(stream({ ...once, offline: true }));
    expect(e).not.toBeInstanceOf(StaleCache);
    expect([e.kind, e.missing, e.message]).toEqual(["fetch", "offline-uncached", "model.gguf: the cached copy fails the alias's sha256 pin and offline is set"]);
    expect(keys()).toEqual([]);
  });

  it("a_failure_of_the_callers_own_is_the_callers_and_leaves_the_copy", async () => {
    serve();
    await stream(once);
    const mine = new Error("the caller's");
    const failing = streamFile("org/model", "main", "model.gguf", { ...opts(once), hasher: nodeHasher, singlePass: true, onChunk: () => Promise.reject(mine) });
    await expect(failing).rejects.toBe(mine);
    expect(keys()).toEqual([indexUrl(URL_A), ...partKeys(PART, 5)].sort());
    expect((await stream(once)).r.source).toBe("cache");
  });
});
