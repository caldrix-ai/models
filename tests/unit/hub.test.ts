import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { BodyPastSize, CACHE_NAME, LISTING_CAP, fetchFile, fetchListing, fetchRange, listingUrl, streamFile, type FetchOptions, type Hasher, type StreamOptions } from "../../src/hub";
import { ModelsError } from "../../src/errors";
import { PART_POLICY_URL } from "../../src/parted";
import { FakeCaches, FakeFetch } from "./fake-fetch";

const BASE = "http://hub.test";
const URL_A = `${BASE}/org/model/resolve/main/model.safetensors`;
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

async function sha256Hex(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

let ff: FakeFetch;
let caches: FakeCaches;

function opts(extra: Partial<FetchOptions> = {}): FetchOptions {
  return { hubBaseUrl: BASE, offline: false, ...extra };
}
const get = () => fetchFile("org/model", "main", "model.safetensors", opts());

async function rejection(p: Promise<unknown>): Promise<ModelsError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelsError);
    return e as ModelsError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  ff = new FakeFetch();
  caches = new FakeCaches();
  vi.stubGlobal("fetch", ff.fetch);
  vi.stubGlobal("caches", caches);
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchFile", () => {
  it("a_second_fetch_is_served_from_the_cache", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    const first = await get();
    expect(first.source).toBe("network");
    expect(first.bytes).toEqual(BYTES);
    const second = await get();
    expect(second.source).toBe("cache");
    expect(second.bytes).toEqual(BYTES);
    expect(ff.calls).toHaveLength(1);
    expect(caches.stores.has(CACHE_NAME)).toBe(true);
  });

  it("a_cached_copy_that_is_no_longer_the_bytes_cached_is_fetched_again", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    await get();
    const cache = await caches.open(CACHE_NAME);
    const entry = caches.stores.get(CACHE_NAME)!.entries.get(URL_A)!;
    expect(entry.headers.get("x-caldrix-sha256")).toBe(await sha256Hex(BYTES));
    // The same entry, its body changed: one byte, the length kept.
    const bad = BYTES.slice();
    bad[3] ^= 0xff;
    await cache.put(URL_A, new Response(bad, { headers: entry.headers }));
    // Offline, a changed copy is refused by name and dropped; nothing is asked of the network.
    const off = await rejection(fetchFile("org/model", "main", "model.safetensors", opts({ offline: true })));
    expect([off.kind, off.missing, off.message]).toEqual(["fetch", "offline-uncached", "model.safetensors: the cached copy is not the bytes that were cached and offline is set"]);
    expect(ff.calls).toHaveLength(1);
    await cache.put(URL_A, new Response(bad, { headers: entry.headers }));
    const again = await get();
    expect([again.source, again.cached]).toEqual(["network", true]);
    expect(again.bytes).toEqual(BYTES);
    expect(ff.calls).toHaveLength(2);
    expect((await get()).source).toBe("cache");
    expect(ff.calls).toHaveLength(2);
  });

  it("a_copy_cached_before_the_digest_was_written_is_used_as_stored", async () => {
    await (await caches.open(CACHE_NAME)).put(URL_A, new Response(BYTES, { headers: { "x-caldrix-verified": "0" } }));
    const hit = await fetchFile("org/model", "main", "model.safetensors", opts({ offline: true }));
    expect([hit.source, hit.verified]).toEqual(["cache", false]);
    expect(hit.bytes).toEqual(BYTES);
  });

  it("offline_with_a_miss_is_refused_by_name", async () => {
    const e = await rejection(
      fetchFile("org/model", "main", "model.safetensors", opts({ offline: true })),
    );
    expect(e.kind).toBe("fetch");
    expect(e.message).toContain("model.safetensors");
    expect(e.message).toContain("is not in the cache and offline is set");
    expect(ff.calls).toHaveLength(0);
  });

  it("the_two_absent_paths_set_the_missing_field", async () => {
    const off = await rejection(
      fetchFile("org/model", "main", "model.safetensors", opts({ offline: true })),
    );
    expect(off.missing).toBe("offline-uncached");
    ff.routes.set(URL_A, { status: 404, chunks: [] });
    const nf = await rejection(get());
    expect(nf.missing).toBe("not-found");
    ff.routes.set(URL_A, { status: 500, chunks: [] });
    expect((await rejection(get())).missing).toBeUndefined();
  });

  it("an_optional_files_404_is_remembered_online_and_offline", async () => {
    ff.routes.set(URL_A, { status: 404, chunks: [] });
    const optional = (offline: boolean) =>
      fetchFile("org/model", "main", "model.safetensors", opts({ offline, rememberAbsent: true }));
    expect((await rejection(optional(false))).missing).toBe("not-found");
    expect(ff.calls).toHaveLength(1);
    const again = await rejection(optional(false));
    expect(again).toMatchObject({ kind: "fetch", missing: "not-found" });
    expect(again.message).toContain("remembered from an earlier load");
    expect((await rejection(optional(true))).missing).toBe("not-found");
    expect(ff.calls).toHaveLength(1);
  });

  it("a_required_files_404_is_not_remembered", async () => {
    ff.routes.set(URL_A, { status: 404, chunks: [] });
    expect((await rejection(get())).missing).toBe("not-found");
    expect(caches.size()).toBe(0);
    await rejection(get());
    expect(ff.calls).toHaveLength(2);
  });

  it("a_remembered_absence_does_not_answer_a_required_fetch", async () => {
    ff.routes.set(URL_A, { status: 404, chunks: [] });
    await rejection(fetchFile("org/model", "main", "model.safetensors", opts({ rememberAbsent: true })));
    ff.routes.set(URL_A, { chunks: [BYTES] });
    const r = await get();
    expect(r).toMatchObject({ source: "network", bytes: BYTES });
    expect(ff.calls).toHaveLength(2);
  });

  it("offline_serves_a_cached_file", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    await get();
    const r = await fetchFile("org/model", "main", "model.safetensors", opts({ offline: true }));
    expect(r.source).toBe("cache");
    expect(ff.calls).toHaveLength(1);
  });

  it("progress_reports_loaded_and_total_or_null", async () => {
    const parts = [BYTES.slice(0, 4), BYTES.slice(4)];
    ff.routes.set(URL_A, { chunks: parts, headers: { "content-length": "10" } });
    const seen: { file: string; loaded: number; total: number | null }[] = [];
    await fetchFile("org/model", "main", "model.safetensors", opts({ onProgress: (p) => seen.push(p) }));
    expect(seen.map((p) => p.loaded)).toEqual([4, 10, 10]);
    expect(seen.every((p) => p.total === 10 && p.file === "model.safetensors")).toBe(true);

    caches = new FakeCaches();
    vi.stubGlobal("caches", caches);
    ff.routes.set(URL_A, { chunks: parts });
    const noLen: { loaded: number; total: number | null }[] = [];
    await fetchFile("org/model", "main", "model.safetensors", opts({ onProgress: (p) => noLen.push(p) }));
    expect(noLen.map((p) => p.loaded)).toEqual([4, 10, 10]);
    expect(noLen.every((p) => p.total === null)).toBe(true);
  });

  it("a_digest_mismatch_is_refused_and_not_cached", async () => {
    const wrong = "0".repeat(64);
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "x-linked-etag": `"${wrong}"` } });
    const e = await rejection(get());
    expect(e.kind).toBe("digest");
    expect(e.message).toContain("model.safetensors");
    expect(e.message).toContain(wrong);
    expect(e.message).toContain(await sha256Hex(BYTES));
    expect(caches.size()).toBe(0);
  });

  it("a_matching_digest_is_verified", async () => {
    const hex = (await sha256Hex(BYTES)).toUpperCase();
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "x-linked-etag": `"${hex}"` } });
    expect((await get()).verified).toBe(true);
    // a cached hit reports what was recorded at write time
    const again = await get();
    expect(again.source).toBe("cache");
    expect(again.verified).toBe(true);
  });

  it("no_linked_etag_means_unverified", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    expect((await get()).verified).toBe(false);
    expect((await get()).verified).toBe(false);
  });

  it("a_failed_download_keeps_no_cache_entry", async () => {
    const e404 = await rejection(get());
    expect(e404.kind).toBe("fetch");
    expect(e404.message).toContain("model.safetensors");
    expect(e404.message).toContain("404");
    expect(caches.size()).toBe(0);

    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 3)], failAfter: new Error("connection reset") });
    const eMid = await rejection(get());
    expect(eMid.kind).toBe("fetch");
    expect(eMid.message).toContain("model.safetensors");
    expect(eMid.message).toContain("connection reset");
    expect(caches.size()).toBe(0);
  });

  it("an_abort_is_a_fetch_error_naming_the_file", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    const ac = new AbortController();
    ac.abort();
    const e = await rejection(
      fetchFile("org/model", "main", "model.safetensors", opts({ signal: ac.signal })),
    );
    expect(e.kind).toBe("fetch");
    expect(e.message).toContain("model.safetensors");
    expect(ff.calls[0]?.signal).toBe(ac.signal);
    expect(caches.size()).toBe(0);
  });

  it("the_url_is_the_hubs_resolve_url", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    await get();
    expect(ff.calls.map((c) => c.url)).toEqual([
      "http://hub.test/org/model/resolve/main/model.safetensors",
    ]);
  });

  it("a_trailing_slash_on_the_hub_base_is_stripped_once_in_the_url_and_the_key", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    const slashed = () => fetchFile("org/model", "main", "model.safetensors", opts({ hubBaseUrl: `${BASE}/` }));
    expect((await slashed()).source).toBe("network");
    expect(ff.calls.map((c) => c.url)).toEqual([URL_A]);
    expect([...caches.stores.get(CACHE_NAME)!.entries.keys()]).toEqual([URL_A]);
    // the same file under either spelling is one cache entry
    expect((await get()).source).toBe("cache");
    expect((await slashed()).source).toBe("cache");
    expect(ff.calls).toHaveLength(1);
  });
});

describe("fetchFile hardening", () => {
  const ENC = (f: string) => `${BASE}/org/model/resolve/main/${f}`;
  const call = (file: string, o: Partial<FetchOptions> = {}) =>
    fetchFile("org/model", "main", file, opts(o));

  it.each(["a?b", "a#b", "%2e%2e", "a%20b", ".", "..", "", "a/b", "a\\b", "a\nb"])(
    "a_file_name_%j_is_refused_as_validate",
    async (name) => {
      const e = await rejection(call(name));
      expect(e.kind).toBe("validate");
      expect(e.message).toContain("file");
      expect(ff.calls).toHaveLength(0);
    },
  );

  it("repo_and_revision_parts_are_validated", async () => {
    for (const [repo, rev, part] of [
      ["org/..", "main", "repo"],
      ["org/model", "a?b", "revision"],
      ["org//model", "main", "repo"],
    ] as const) {
      const e = await rejection(fetchFile(repo, rev, "f.bin", opts()));
      expect([e.kind, e.message.startsWith(part)]).toEqual(["validate", true]);
    }
  });

  it("a_space_and_non_ascii_name_are_encoded_in_the_url_and_the_key", async () => {
    for (const name of ["my file.bin", "modèle.bin"]) {
      const url = ENC(encodeURIComponent(name));
      ff.routes.set(url, { chunks: [BYTES] });
      expect((await call(name)).source).toBe("network");
      expect((await call(name)).source).toBe("cache");
      expect(ff.calls.at(-1)?.url).toBe(url);
      expect(caches.stores.get(CACHE_NAME)?.entries.has(url)).toBe(true);
    }
  });

  it("a_missing_caches_api_is_backend_naming_a_secure_context", async () => {
    vi.stubGlobal("caches", undefined);
    const e = await rejection(call("f.bin"));
    expect(e.kind).toBe("backend");
    expect(e.message).toContain("caches");
    expect(e.message).toContain("secure context");
  });

  it("a_missing_crypto_subtle_is_backend_naming_a_secure_context", async () => {
    ff.routes.set(ENC("f.bin"), { chunks: [BYTES], headers: { "x-linked-etag": "abc" } });
    vi.stubGlobal("crypto", {});
    const e = await rejection(call("f.bin"));
    expect(e.kind).toBe("backend");
    expect(e.message).toContain("crypto.subtle");
    expect(e.message).toContain("secure context");
    expect(caches.size()).toBe(0);
  });

  it("cache_open_and_match_failures_are_backend_naming_the_operation", async () => {
    caches.failOpen = new Error("denied");
    const o = await rejection(call("f.bin"));
    expect([o.kind, o.message.includes("opening"), o.message.includes("denied")]).toEqual(["backend", true, true]);
    caches.failOpen = undefined;
    (await caches.open(CACHE_NAME)).failMatch = new Error("broken");
    const m = await rejection(call("f.bin"));
    expect([m.kind, m.message.includes("reading"), m.message.includes("broken")]).toEqual(["backend", true, true]);
    expect(ff.calls).toHaveLength(0);
  });

  it("a_failed_cache_write_still_returns_the_verified_bytes_uncached", async () => {
    const hex = await sha256Hex(BYTES);
    ff.routes.set(ENC("f.bin"), { chunks: [BYTES], headers: { "x-linked-etag": hex } });
    (await caches.open(CACHE_NAME)).failPut = new DOMException("quota", "QuotaExceededError");
    const r = await call("f.bin");
    expect([r.source, r.verified, r.cached]).toEqual(["network", true, false]);
    expect(r.bytes).toEqual(BYTES);
    expect(caches.size()).toBe(0);
  });

  it("an_abort_mid_stream_is_fetch_naming_the_file_and_not_cached", async () => {
    const ac = new AbortController();
    ff.routes.set(ENC("f.bin"), {
      chunks: [BYTES.slice(0, 5), BYTES.slice(5)],
      afterChunk: (i) => {
        if (i === 1) ac.abort();
      },
    });
    const e = await rejection(call("f.bin", { signal: ac.signal }));
    expect([e.kind, e.message.includes("f.bin"), e.message.includes("aborted")]).toEqual(["fetch", true, true]);
    expect(caches.size()).toBe(0);
  });

  it("a_content_length_disagreeing_with_the_body_is_refused_and_not_cached", async () => {
    ff.routes.set(ENC("f.bin"), { chunks: [BYTES], headers: { "content-length": "12" } });
    const e = await rejection(call("f.bin"));
    expect(e.kind).toBe("fetch");
    expect(e.message).toContain("f.bin");
    expect(e.message).toContain("12");
    expect(e.message).toContain("10");
    expect(caches.size()).toBe(0);
  });

  it("an_onprogress_throw_is_the_callers_error_and_nothing_is_cached", async () => {
    ff.routes.set(ENC("f.bin"), { chunks: [BYTES] });
    const boom = new Error("ui broke");
    await expect(
      call("f.bin", {
        onProgress: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(caches.size()).toBe(0);
  });
});

describe("the alias's pinned sha256", () => {
  const pinned = (sha256: string, extra: Partial<FetchOptions> = {}) =>
    fetchFile("org/model", "main", "model.safetensors", opts({ sha256, ...extra }));

  it("a_digest_refusal_names_the_listing_when_the_listing_pinned_it", async () => {
    const sha = await sha256Hex(BYTES);
    const want = "ab".repeat(32);
    ff.routes.set(URL_A, { chunks: [BYTES] });
    const e = await rejection(pinned(want, { pinnedBy: "listing" }));
    expect(e.message).toBe(`model.safetensors: sha256 is ${sha} but the listing pins ${want}`);
  });

  it("a_pinned_sha256_is_checked_whatever_the_etag_and_a_mismatch_is_not_cached", async () => {
    const sha = await sha256Hex(BYTES);
    const want = "ab".repeat(32);
    // The Hub's etag agrees with the body, the pin does not: the pin decides.
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "x-linked-etag": `"${sha}"` } });
    const e = await rejection(pinned(want));
    expect([e.kind, e.message]).toEqual(["digest", `model.safetensors: sha256 is ${sha} but the alias pins ${want}`]);
    expect(caches.size()).toBe(0);
    // No etag at all: the pin is still checked.
    ff.routes.set(URL_A, { chunks: [BYTES] });
    expect((await rejection(pinned(want))).message).toContain("the alias pins");
    // A wrong etag and a wrong pin: the pin is checked first.
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "x-linked-etag": `"${"0".repeat(64)}"` } });
    expect((await rejection(pinned(want))).message).toContain("the alias pins");
    expect(caches.size()).toBe(0);
    // A matching pin with no etag is verified and cached.
    ff.routes.set(URL_A, { chunks: [BYTES] });
    expect(await pinned(sha)).toMatchObject({ source: "network", verified: true, cached: true, bytes: BYTES });
    expect(caches.size()).toBe(1);
  });

  it("a_cached_file_that_fails_its_pin_is_dropped_and_refetched", async () => {
    const bad = new Uint8Array([9, 9, 9]);
    ff.routes.set(URL_A, { chunks: [bad] });
    await get();
    const sha = await sha256Hex(BYTES);
    // Offline: the bad entry is dropped and the load is the offline refusal.
    const off = await rejection(pinned(sha, { offline: true }));
    expect([off.kind, off.missing, off.message]).toEqual([
      "fetch",
      "offline-uncached",
      "model.safetensors: the cached copy fails the alias's sha256 pin and offline is set",
    ]);
    expect(caches.size()).toBe(0);
    await get();
    // Online: dropped and fetched again; the good bytes are cached and served from the cache, re-hashed.
    ff.routes.set(URL_A, { chunks: [BYTES] });
    expect(await pinned(sha)).toMatchObject({ source: "network", verified: true, bytes: BYTES });
    expect(ff.calls).toHaveLength(3);
    expect(await pinned(sha)).toMatchObject({ source: "cache", verified: true, bytes: BYTES });
    expect(ff.calls).toHaveLength(3);
  });

  it("a_body_longer_than_the_alias_bytes_is_refused_mid_stream_and_not_cached", async () => {
    const sha = await sha256Hex(BYTES);
    const long = { chunks: [BYTES.slice(0, 6), BYTES.slice(6), BYTES, BYTES] };
    ff.routes.set(URL_A, long);
    const e = await rejection(pinned(sha, { bytes: BYTES.byteLength }));
    expect([e.kind, e.message]).toEqual(["fetch", "model.safetensors: the body passed its pinned size, 10 bytes"]);
    // Marked structurally, with the size it passed, so a caller tells it apart without its words.
    expect(e).toBeInstanceOf(BodyPastSize);
    expect(e).toBeInstanceOf(ModelsError);
    expect((e as BodyPastSize).bytes).toBe(BYTES.byteLength);
    // Refused at the chunk that passed the size: the rest of the body is cancelled, not read.
    expect((long as { cancelled?: boolean }).cancelled).toBe(true);
    expect(caches.size()).toBe(0);
    // An exact-length body passes and is cached.
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 6), BYTES.slice(6)] });
    expect(await pinned(sha, { bytes: BYTES.byteLength })).toMatchObject({ source: "network", verified: true, cached: true, bytes: BYTES });
    expect(caches.size()).toBe(1);
  });
});

describe("fetchListing", () => {
  const LURL = `${BASE}/api/models/org/model?blobs=true`;
  const JSON_BYTES = new TextEncoder().encode('{"siblings":[]}');
  const list = (extra: Partial<FetchOptions> = {}) =>
    fetchListing("org/model", null, { hubBaseUrl: BASE, offline: false, ...extra });

  it("the_listing_url_asks_for_blobs_and_encodes_a_revision_as_one_segment", () => {
    expect(listingUrl("org/model", null, BASE + "/")).toBe(`${BASE}/api/models/org/model?blobs=true`);
    expect(listingUrl("org/model", "refs/pr/1", BASE)).toBe(
      `${BASE}/api/models/org/model/revision/refs%2Fpr%2F1?blobs=true`,
    );
    expect(() => listingUrl("org/..", null, BASE)).toThrow(expect.objectContaining({ kind: "validate" }));
  });

  it("online_always_asks_the_hub_and_caches_the_answer", async () => {
    ff.routes.set(LURL, { chunks: [JSON_BYTES] });
    expect(await list()).toMatchObject({ source: "network", bytes: JSON_BYTES });
    expect(await list()).toMatchObject({ source: "network", bytes: JSON_BYTES });
    expect(ff.calls).toHaveLength(2);
    expect(caches.size()).toBe(1);
    expect(caches.stores.get(CACHE_NAME)?.entries.has(LURL)).toBe(true);
  });

  it("offline_reads_the_cached_listing_and_refuses_without_one", async () => {
    ff.routes.set(LURL, { chunks: [JSON_BYTES] });
    await list();
    expect(await list({ offline: true })).toMatchObject({ source: "cache", bytes: JSON_BYTES });
    expect(ff.calls).toHaveLength(1);
    caches = new FakeCaches();
    vi.stubGlobal("caches", caches);
    const e = await rejection(list({ offline: true }));
    expect([e.kind, e.missing]).toEqual(["fetch", "offline-uncached"]);
    expect(e.message).toContain("org/model");
  });

  it("a_401_names_both_readings_and_the_cli", async () => {
    ff.routes.set(LURL, { status: 401 });
    const e = await rejection(list());
    expect([e.kind, e.missing]).toEqual(["fetch", "not-found"]);
    expect(e.message).toContain("does not exist, or it is private");
    expect(e.message).toContain("caldrix CLI");
  });

  it("a_404_and_other_statuses_are_named", async () => {
    const miss = await rejection(fetchListing("org/model", "v1", { hubBaseUrl: BASE, offline: false }));
    expect([miss.missing, miss.message]).toEqual([
      "not-found",
      "org/model@v1: no such repo or revision on the Hub (HTTP 404)",
    ]);
    ff.routes.set(LURL, { status: 503 });
    const e = await rejection(list());
    expect([e.kind, e.missing, e.message]).toEqual([
      "fetch",
      undefined,
      "fetching the Hub listing of org/model failed: HTTP 503",
    ]);
  });

  it("a_body_past_the_cap_is_refused_mid_stream_and_not_cached", async () => {
    const route = { chunks: [new Uint8Array(LISTING_CAP), new Uint8Array(1), new Uint8Array(1)] };
    ff.routes.set(LURL, route);
    const e = await rejection(list());
    expect(e.kind).toBe("validate");
    expect(e.message).toBe("the Hub listing of org/model passed the 256 KiB (262144-byte) cap");
    expect((route as { cancelled?: boolean }).cancelled).toBe(true);
    expect(caches.size()).toBe(0);
  });

  it("a_redirect_off_the_hub_origin_is_refused", async () => {
    ff.routes.set(LURL, { chunks: [JSON_BYTES], url: "https://evil.test/api/models/org/model" });
    const e = await rejection(list());
    expect(e.kind).toBe("fetch");
    expect(e.message).toContain("evil.test");
    expect(caches.size()).toBe(0);
    ff.routes.set(LURL, { chunks: [JSON_BYTES], url: LURL });
    expect(await list()).toMatchObject({ source: "network" });
  });

  it("an_abort_reads_was_aborted_and_a_failed_cache_write_does_not_fail", async () => {
    const ac = new AbortController();
    ac.abort();
    ff.routes.set(LURL, { chunks: [JSON_BYTES] });
    expect((await rejection(list({ signal: ac.signal }))).message).toContain("was aborted");
    (await caches.open(CACHE_NAME)).failPut = new Error("quota");
    expect(await list()).toMatchObject({ source: "network", bytes: JSON_BYTES });
  });
});

describe("fetchRange", () => {
  const range = (length: number, extra: Partial<FetchOptions> = {}) =>
    fetchRange("org/model", "main", "model.safetensors", length, opts(extra));

  it("fetchRange_asks_for_bytes_0_to_n_minus_1_and_is_never_cached", async () => {
    ff.routes.set(URL_A, { status: 206, chunks: [BYTES.slice(0, 4)] });
    expect(await range(4)).toEqual(BYTES.slice(0, 4));
    expect(ff.calls.map((c) => [c.url, c.range])).toEqual([[URL_A, "bytes=0-3"]]);
    expect(caches.size()).toBe(0);
    await range(4);
    expect(ff.calls).toHaveLength(2);
  });

  it("fetchRange_cuts_a_200_to_the_asked_length_and_cancels_the_body", async () => {
    const route = { chunks: [BYTES.slice(0, 3), BYTES.slice(3, 6), BYTES.slice(6)] };
    ff.routes.set(URL_A, route);
    expect(await range(4)).toEqual(BYTES.slice(0, 4));
    expect((route as { cancelled?: boolean }).cancelled).toBe(true);
    expect(caches.size()).toBe(0);
    // A 200 shorter than the asked length is refused naming both counts.
    ff.routes.set(URL_A, { chunks: [BYTES] });
    const e = await rejection(range(12));
    expect(e.kind).toBe("fetch");
    expect(e.message).toContain("10");
    expect(e.message).toContain("12");
  });

  it("fetchRange_refuses_a_206_of_the_wrong_length", async () => {
    for (const [body, says] of [
      [BYTES.slice(0, 3), "carried 3 bytes, not the 4 asked for"],
      [BYTES.slice(0, 5), "carried more than the 4 bytes asked for"],
    ] as const) {
      ff.routes.set(URL_A, { status: 206, chunks: [body] });
      const e = await rejection(range(4));
      expect(e.kind).toBe("fetch");
      expect(e.message).toContain("model.safetensors");
      expect(e.message).toContain(says);
    }
    ff.routes.set(URL_A, { status: 500, chunks: [] });
    expect((await rejection(range(4))).message).toContain("HTTP 500");
    expect(caches.size()).toBe(0);
  });

  it("fetchRange_from_an_offset_asks_for_exactly_that_extent", async () => {
    ff.routes.set(URL_A, { status: 206, chunks: [BYTES.slice(5, 8)] });
    expect(await fetchRange("org/model", "main", "model.safetensors", 3, opts(), 5)).toEqual(BYTES.slice(5, 8));
    expect(ff.calls.map((c) => [c.url, c.range])).toEqual([[URL_A, "bytes=5-7"]]);
    expect(caches.size()).toBe(0);
  });

  it("fetchRange_from_an_offset_refuses_a_200_and_reads_none_of_it", async () => {
    const route = { chunks: [BYTES] };
    ff.routes.set(URL_A, route);
    const e = await rejection(fetchRange("org/model", "main", "model.safetensors", 3, opts(), 5));
    expect(e.kind).toBe("fetch");
    expect(e.message).toContain("3 bytes from byte 5 of model.safetensors");
    expect(e.message).toContain("HTTP 200");
    expect((route as { cancelled?: boolean }).cancelled).toBe(true);
  });

  it("fetchRange_from_an_offset_serves_a_whole_cached_files_slice", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    await get();
    expect(await fetchRange("org/model", "main", "model.safetensors", 3, opts({ offline: true }), 5)).toEqual(BYTES.slice(5, 8));
    expect(ff.calls).toHaveLength(1);
  });

  it("fetchRange_serves_a_whole_cached_files_prefix_without_a_request", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    await get();
    expect(await range(4)).toEqual(BYTES.slice(0, 4));
    expect(await range(4, { offline: true })).toEqual(BYTES.slice(0, 4));
    expect(ff.calls).toHaveLength(1);
    // Offline and not cached: the offline refusal, with no request.
    caches = new FakeCaches();
    vi.stubGlobal("caches", caches);
    const e = await rejection(range(4, { offline: true }));
    expect([e.kind, e.missing]).toEqual(["fetch", "offline-uncached"]);
    expect(ff.calls).toHaveLength(1);
  });
});

describe("streamFile", () => {
  const nodeHasher = (): Hasher => {
    const h = createHash("sha256");
    return { update: (b) => void h.update(b), finish: () => h.digest("hex") };
  };
  /** A stream into an array of `[offset, bytes]`; `slow` makes each delivery take a macrotask. */
  function sink(slow = false) {
    const got: [number, number[]][] = [];
    let inFlight = 0;
    let overlap = false;
    const onChunk = async (bytes: Uint8Array, offset: number) => {
      if (++inFlight > 1) overlap = true;
      if (slow) await new Promise((r) => setTimeout(r, 1));
      got.push([offset, [...bytes]]);
      inFlight--;
    };
    return { got, onChunk, overlap: () => overlap, bytes: () => got.flatMap(([, b]) => b) };
  }
  const stream = (s: ReturnType<typeof sink>, extra: Partial<StreamOptions> = {}, file = "model.safetensors") =>
    streamFile("org/model", "main", file, { ...opts(extra), hasher: nodeHasher, onChunk: s.onChunk });
  const entry = () => caches.stores.get(CACHE_NAME)?.entries.get(URL_A);

  it("chunks_arrive_in_order_at_their_offsets_and_each_is_awaited", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 4), BYTES.slice(4, 7), BYTES.slice(7)], headers: { "content-length": "10" } });
    const s = sink(true);
    expect(await stream(s)).toEqual({ source: "network", verified: false, cached: true, loaded: 10 });
    expect(s.got.map(([o]) => o)).toEqual([0, 4, 7]);
    expect(s.bytes()).toEqual([...BYTES]);
    expect(s.overlap()).toBe(false);
    // The committed entry is the whole body, recorded unverified.
    expect(new Uint8Array(await entry()!.arrayBuffer())).toEqual(BYTES);
    expect(entry()!.headers.get("x-caldrix-verified")).toBe("0");
  });

  it("a_cache_hit_streams_the_entry_with_no_request", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "x-linked-etag": await sha256Hex(BYTES) } });
    expect(await stream(sink())).toMatchObject({ source: "network", verified: true, cached: true });
    const s = sink();
    expect(await stream(s, { offline: true })).toEqual({ source: "cache", verified: true, cached: true, loaded: 10 });
    expect(s.bytes()).toEqual([...BYTES]);
    expect(ff.calls).toHaveLength(1);
  });

  it("progress_is_reported_per_chunk_and_once_at_the_end", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 4), BYTES.slice(4)], headers: { "content-length": "10" } });
    const seen: number[] = [];
    await stream(sink(), { onProgress: (p) => seen.push(p.loaded) });
    expect(seen).toEqual([4, 10, 10]);
  });

  it("a_pinned_digest_mismatch_is_fetchFiles_refusal_and_leaves_no_entry", async () => {
    const sha = await sha256Hex(BYTES);
    const want = "ab".repeat(32);
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 5), BYTES.slice(5)] });
    const e = await rejection(stream(sink(), { sha256: want }));
    expect([e.kind, e.message]).toEqual(["digest", `model.safetensors: sha256 is ${sha} but the alias pins ${want}`]);
    expect(caches.size()).toBe(0);
    // The Hub's etag, when no pin applies: fetchFile's text, nothing cached.
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "x-linked-etag": `"${"0".repeat(64)}"` } });
    const etag = await rejection(stream(sink()));
    expect([etag.kind, etag.message]).toEqual(["digest", `model.safetensors: sha256 is ${sha} but the Hub's X-Linked-Etag is ${"0".repeat(64)}`]);
    expect(caches.size()).toBe(0);
  });

  it("a_stream_with_cache_false_writes_nothing_to_cache_storage", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 4), BYTES.slice(4)], headers: { "content-length": "10" } });
    const sha = await sha256Hex(BYTES);
    const s = sink();
    expect(await stream(s, { cache: false, sha256: sha })).toEqual({ source: "network", verified: true, cached: false, loaded: 10 });
    expect(s.got.map(([o]) => o)).toEqual([0, 4]);
    expect(s.bytes()).toEqual([...BYTES]);
    // Nor the browser's HTTP cache: the request asks it to keep nothing.
    expect(ff.calls.map((c) => c.cache)).toEqual(["no-store"]);
    // Cache Storage was never opened, let alone written.
    expect(caches.stores.size).toBe(0);
    // A copy in the cache is not read either: the network is asked again.
    await (await caches.open(CACHE_NAME)).put(URL_A, new Response(BYTES, { headers: { "x-caldrix-verified": "1" } }));
    expect(await stream(sink(), { cache: false })).toMatchObject({ source: "network", cached: false });
    expect(ff.calls).toHaveLength(2);
    // The pin still holds: a body that is not the sha256 is a digest refusal.
    const e = await rejection(stream(sink(), { cache: false, sha256: "ab".repeat(32) }));
    expect(e.kind).toBe("digest");
    // The size pin too, and offline refuses (there is no copy it may use).
    const big = await rejection(stream(sink(), { cache: false, bytes: 4 }));
    expect(big.kind).toBe("fetch");
    const off = await rejection(stream(sink(), { cache: false, offline: true }));
    expect(off.missing).toBe("offline-uncached");
    expect(caches.stores.get(CACHE_NAME)!.entries.size).toBe(1);
  });

  it("a_failed_call_never_removes_an_entry_it_did_not_replace", async () => {
    // Another writer commits a good copy while this call streams a body that then fails its check.
    const good = new Response(BYTES, { headers: { "x-caldrix-verified": "1" } });
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "x-linked-etag": "0".repeat(64) } });
    const s = sink();
    const onChunk = async (b: Uint8Array, at: number) => {
      await (await caches.open(CACHE_NAME)).put(URL_A, good.clone());
      await s.onChunk(b, at);
    };
    await rejection(streamFile("org/model", "main", "model.safetensors", { ...opts(), hasher: nodeHasher, onChunk }));
    expect(new Uint8Array(await entry()!.arrayBuffer())).toEqual(BYTES);
    expect(caches.size()).toBe(1);
  });

  it("an_abort_mid_stream_is_fetch_naming_the_file_and_leaves_no_entry", async () => {
    const ac = new AbortController();
    ff.routes.set(URL_A, {
      chunks: [BYTES.slice(0, 3), BYTES.slice(3, 6), BYTES.slice(6)],
      afterChunk: (i) => {
        if (i === 2) ac.abort();
      },
    });
    const e = await rejection(stream(sink(), { signal: ac.signal }));
    expect([e.kind, e.message]).toEqual(["fetch", "fetching model.safetensors was aborted"]);
    expect(caches.size()).toBe(0);
  });

  it("a_body_past_the_pinned_size_is_refused_before_its_chunk_is_delivered", async () => {
    const sha = await sha256Hex(BYTES);
    const long = { chunks: [BYTES.slice(0, 6), BYTES.slice(6), BYTES, BYTES] };
    ff.routes.set(URL_A, long);
    const s = sink();
    const e = await rejection(stream(s, { sha256: sha, bytes: BYTES.byteLength }));
    expect(e).toBeInstanceOf(BodyPastSize);
    expect([e.kind, e.message]).toEqual(["fetch", "model.safetensors: the body passed its pinned size, 10 bytes"]);
    expect(s.bytes()).toEqual([...BYTES]);
    expect((long as { cancelled?: boolean }).cancelled).toBe(true);
    expect(caches.size()).toBe(0);
  });

  it("a_short_body_fails_its_content_length_and_leaves_no_entry", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "content-length": "12" } });
    const e = await rejection(stream(sink()));
    expect([e.kind, e.message]).toEqual(["fetch", "fetching model.safetensors failed: Content-Length is 12 but 10 bytes arrived"]);
    expect(caches.size()).toBe(0);
    // A body cut by the connection: fetchFile's text, nothing cached.
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 3)], failAfter: new Error("connection reset") });
    expect((await rejection(stream(sink()))).message).toBe("fetching model.safetensors failed: connection reset");
    expect(caches.size()).toBe(0);
  });

  it("a_throwing_onchunk_is_the_callers_error_is_never_called_again_and_leaves_no_entry", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 3), BYTES.slice(3, 6), BYTES.slice(6)] });
    const boom = new Error("host refused");
    let calls = 0;
    const onChunk = () => {
      calls++;
      throw boom;
    };
    await expect(streamFile("org/model", "main", "model.safetensors", { ...opts(), hasher: nodeHasher, onChunk })).rejects.toBe(boom);
    expect(calls).toBe(1);
    expect(caches.size()).toBe(0);
  });

  it("a_failed_put_reports_cached_false_and_the_load_completes", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 5), BYTES.slice(5)], headers: { "x-linked-etag": await sha256Hex(BYTES) } });
    (await caches.open(CACHE_NAME)).failPut = new DOMException("quota", "QuotaExceededError");
    const s = sink();
    expect(await stream(s)).toEqual({ source: "network", verified: true, cached: false, loaded: 10 });
    expect(s.bytes()).toEqual([...BYTES]);
    expect(caches.size()).toBe(0);
  });

  it("a_put_failing_mid_stream_lets_the_load_go_on_uncached", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 3), BYTES.slice(3, 6), BYTES.slice(6)] });
    const cache = await caches.open(CACHE_NAME);
    cache.failPut = new DOMException("quota", "QuotaExceededError");
    let open!: () => void;
    cache.putGate = new Promise((r) => (open = r));
    const s = sink();
    const onChunk = async (b: Uint8Array, at: number) => {
      open(); // the put fails while the first chunk's write waits on it
      await s.onChunk(b, at);
    };
    const r = await streamFile("org/model", "main", "model.safetensors", { ...opts(), hasher: nodeHasher, onChunk });
    expect(r).toEqual({ source: "network", verified: false, cached: false, loaded: 10 });
    expect(s.bytes()).toEqual([...BYTES]);
    expect(caches.size()).toBe(0);
  });

  it("a_slow_cache_write_holds_the_read_back", async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => BYTES.slice(i, i + 1));
    let pulled = 0;
    ff.routes.set(URL_A, { chunks, afterChunk: (i) => (pulled = i) });
    let open!: () => void;
    (await caches.open(CACHE_NAME)).putGate = new Promise((r) => (open = r));
    const s = sink();
    const done = stream(s);
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(pulled).toBeLessThan(4);
    expect(s.got.length).toBeLessThan(2);
    open();
    expect(await done).toMatchObject({ cached: true, loaded: 10 });
    expect(s.bytes()).toEqual([...BYTES]);
  });

  it("onend_runs_after_the_checks_and_before_the_entry_is_committed_and_its_throw_leaves_no_entry", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES.slice(0, 4), BYTES.slice(4)] });
    const seen: string[] = [];
    const s = sink();
    const onEnd = () => {
      seen.push(`end:${s.bytes().length}:${entry() === undefined ? "uncommitted" : "committed"}`);
    };
    expect(await stream(s, { onEnd } as Partial<FetchOptions>)).toMatchObject({ source: "network", cached: true });
    expect(seen).toEqual(["end:10:uncommitted"]);
    // A refusal at the end (a fill left incomplete): the call fails with it and nothing is cached.
    caches = new FakeCaches();
    vi.stubGlobal("caches", caches);
    const short = new Error("the download ended before fill 0 was complete");
    const e = streamFile("org/model", "main", "model.safetensors", {
      ...opts(),
      hasher: nodeHasher,
      onChunk: sink().onChunk,
      onEnd: () => {
        throw short;
      },
    });
    await expect(e).rejects.toBe(short);
    expect(caches.size()).toBe(0);
    // A cache hit runs it too, after the delivery and its check.
    ff.routes.set(URL_A, { chunks: [BYTES] });
    const sha = await sha256Hex(BYTES);
    await stream(sink(), { sha256: sha });
    const ends: number[] = [];
    const hit = sink();
    await streamFile("org/model", "main", "model.safetensors", { ...opts({ sha256: sha }), hasher: nodeHasher, onChunk: hit.onChunk, onEnd: () => void ends.push(hit.bytes().length) });
    expect(ends).toEqual([10]);
  });

  it("a_pinned_cache_hit_hashes_the_bytes_it_delivers_and_refuses_a_second_read_that_differs", async () => {
    const sha = await sha256Hex(BYTES);
    ff.routes.set(URL_A, { chunks: [BYTES], headers: { "content-length": "10" } });
    await stream(sink(), { sha256: sha });
    // The entry passes its pin on the first read; the read that delivers it gives other bytes.
    const cache = await caches.open(CACHE_NAME);
    const bad = new Uint8Array([9, 9, 9]);
    const read = cache.match.bind(cache);
    let reads = 0;
    cache.match = async (url: string) => (++reads === 2 ? new Response(bad, { headers: { "x-caldrix-verified": "1" } }) : read(url));
    const s = sink();
    const e = await rejection(stream(s, { sha256: sha }));
    expect([e.kind, e.message]).toEqual(["digest", `model.safetensors: sha256 is ${await sha256Hex(bad)} but the alias pins ${sha}`]);
    expect(reads).toBe(2);
    expect(s.bytes()).toEqual([...bad]);
    // The entry is dropped: the next load fetches the file again.
    expect(caches.size()).toBe(0);
  });

  it("a_cached_copy_failing_its_pin_is_dropped_before_a_byte_is_delivered_and_fetched_again", async () => {
    const bad = new Uint8Array([9, 9, 9]);
    ff.routes.set(URL_A, { chunks: [bad] });
    await stream(sink());
    const sha = await sha256Hex(BYTES);
    const off = sink();
    const e = await rejection(stream(off, { sha256: sha, offline: true }));
    expect([e.kind, e.missing, e.message]).toEqual([
      "fetch",
      "offline-uncached",
      "model.safetensors: the cached copy fails the alias's sha256 pin and offline is set",
    ]);
    expect(off.got).toEqual([]);
    expect(caches.size()).toBe(0);
    await stream(sink());
    ff.routes.set(URL_A, { chunks: [BYTES] });
    const on = sink();
    expect(await stream(on, { sha256: sha })).toEqual({ source: "network", verified: true, cached: true, loaded: 10 });
    expect(on.got.map(([o]) => o)).toEqual([0]);
    expect(on.bytes()).toEqual([...BYTES]);
    expect(ff.calls).toHaveLength(3);
    // The good copy is served from the cache, checked against the pin again.
    expect(await stream(sink(), { sha256: sha })).toEqual({ source: "cache", verified: true, cached: true, loaded: 10 });
    expect(ff.calls).toHaveLength(3);
  });

  it("offline_and_the_absent_marker_are_fetchFiles", async () => {
    const off = await rejection(stream(sink(), { offline: true }));
    expect([off.missing, off.message]).toEqual(["offline-uncached", "model.safetensors is not in the cache and offline is set"]);
    ff.routes.set(URL_A, { status: 404, chunks: [] });
    expect((await rejection(stream(sink(), { rememberAbsent: true }))).missing).toBe("not-found");
    const again = await rejection(stream(sink(), { rememberAbsent: true }));
    expect(again.message).toContain("remembered from an earlier load");
    expect(ff.calls).toHaveLength(1);
  });
});

describe("fetchRange on a cache hit", () => {
  it("reads_the_slice_and_never_the_whole_entry", async () => {
    ff.routes.set(URL_A, { chunks: [BYTES] });
    await get();
    const whole = vi.spyOn(Response.prototype, "arrayBuffer");
    expect(await fetchRange("org/model", "main", "model.safetensors", 3, opts(), 5)).toEqual(BYTES.slice(5, 8));
    expect(whole).not.toHaveBeenCalled();
    whole.mockRestore();
    expect(ff.calls).toHaveLength(1);
    // An entry shorter than the range: the network, as before.
    ff.routes.set(URL_A, { status: 206, chunks: [new Uint8Array(4)] });
    expect(await fetchRange("org/model", "main", "model.safetensors", 4, opts(), 8)).toEqual(new Uint8Array(4));
    expect(ff.calls).toHaveLength(2);
  });
});

describe("the cache keys and headers", () => {
  it("the_cache_keys_and_headers_are_unchanged", async () => {
    // A user's Cache Storage from before the package existed is read as it lies.
    expect(CACHE_NAME).toBe("caldrix.js");
    expect(PART_POLICY_URL.startsWith("https://caldrix.js.invalid/cache/")).toBe(true);
    ff.routes.set(URL_A, { chunks: [BYTES] });
    await get();
    const entry = caches.stores.get("caldrix.js")!.entries.get(URL_A)!;
    expect(entry.headers.get("x-caldrix-sha256")).toBe(await sha256Hex(BYTES));
  });
});
