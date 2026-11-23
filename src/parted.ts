/**
 * A model file cached as several entries. A browser may refuse one cache entry past a size it does
 * not announce (Chromium's memory-only cache, a private window's, refuses one of 256 MiB), so a file
 * past the part size is written as parts, each its own entry, and an index written last: a set
 * without its index is never read. The part size is learned from the writes themselves: a part the
 * cache refuses halves the size the next write uses, remembered in the cache, and a whole entry it
 * refuses (a file within the part size) brings the size below that file's. Once a file is cached at
 * a lowered size, scratch entries probe for the largest size the cache takes (`growPartBytes`).
 *
 * Keys: the index at `<url>?caldrix-parts`, part `i` of a set cut at `n` bytes at
 * `<url>?caldrix-part=<n>-<i>`. Neither is the file's own URL, the key of a file cached whole, so a
 * version of the package that knows only whole entries never reads one of these as a file.
 */

/** The part size a write starts from. */
export const PART_BYTES = 64 * 1024 * 1024;
/** The smallest part size: a refusal at it is not answered by a smaller one. */
export const MIN_PART_BYTES = 64 * 1024;
/** The cache key of the learned part size: no Hub URL, and never fetched. */
export const PART_POLICY_URL = "https://caldrix.js.invalid/cache/part-bytes";

/** The cache key of the scratch entry a probe writes and removes: no Hub URL, and never fetched. */
export const PART_PROBE_URL = "https://caldrix.js.invalid/cache/part-probe";
/** The cache key of the size a probe was refused at, with the browser that refused it. */
export const PART_PROBE_REFUSED_URL = "https://caldrix.js.invalid/cache/part-probe-refused";

const PARTS_HEADER = "x-caldrix-parts";
const PART_BYTES_HEADER = "x-caldrix-part-bytes";
const BYTES_HEADER = "x-caldrix-bytes";

/** A parted file as its index records it. */
export interface Parted {
  /** The file's size. */
  bytes: number;
  /** The size of every part but the last. */
  partBytes: number;
  parts: number;
  /** The index's other headers (the verified mark). */
  headers: Headers;
}

export const indexUrl = (url: string): string => `${url}?caldrix-parts`;
export const partUrl = (url: string, partBytes: number, i: number): string => `${url}?caldrix-part=${partBytes}-${i}`;

function count(v: string | null): number | null {
  if (v === null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** The file's index, when it is cached as parts; an index that does not add up is none. */
export async function readIndex(cache: Cache, url: string): Promise<Parted | undefined> {
  const hit = await cache.match(indexUrl(url));
  if (!hit) return undefined;
  const bytes = count(hit.headers.get(BYTES_HEADER));
  const partBytes = count(hit.headers.get(PART_BYTES_HEADER));
  const parts = count(hit.headers.get(PARTS_HEADER));
  if (bytes === null || partBytes === null || parts === null || partBytes < 1) return undefined;
  if (parts !== Math.ceil(bytes / partBytes)) return undefined;
  return { bytes, partBytes, parts, headers: hit.headers };
}

/** Where part `i` begins, and its length. */
export function partExtent(p: Parted, i: number): { start: number; length: number } {
  const start = i * p.partBytes;
  return { start, length: Math.min(p.partBytes, p.bytes - start) };
}

/**
 * The part size a write uses: the learned one, else `start`, which is also the most a learned one
 * may be. `start` is `PART_BYTES` for every load the package makes; only a test names another.
 */
export async function partBytesFor(cache: Cache, start = PART_BYTES): Promise<number> {
  try {
    const hit = await cache.match(PART_POLICY_URL);
    const n = hit ? count((await hit.text()).trim()) : null;
    if (n !== null && n >= MIN_PART_BYTES && n <= start) return n;
  } catch {
    // not read: the default
  }
  return start;
}

/**
 * An entry was refused for `why` while the part size was `partBytes`: the next write uses a smaller
 * one, down to `MIN_PART_BYTES`. A refused part halves it. A refused whole entry of `whole` bytes (a
 * file within the part size is one entry) takes the largest halving that is below `whole`, so the
 * next write of that file is parts; a file no larger than `MIN_PART_BYTES` teaches nothing, as no
 * part size would part it. A full disk (`QuotaExceededError`) is no entry cap, and teaches nothing.
 */
export async function learnRefusal(cache: Cache, partBytes: number, why: unknown, whole?: number): Promise<void> {
  if (typeof why === "object" && why !== null && (why as { name?: unknown }).name === "QuotaExceededError") return;
  let next = Math.max(MIN_PART_BYTES, Math.floor(partBytes / 2));
  if (whole !== undefined) {
    while (next >= whole && next > MIN_PART_BYTES) next = Math.max(MIN_PART_BYTES, Math.floor(next / 2));
    if (next >= whole) return;
  }
  if (next >= partBytes) return;
  try {
    await cache.put(PART_POLICY_URL, new Response(String(next)));
  } catch {
    // not remembered: the next write starts from the same size
  }
}

/** The browser as it names itself: what a refused probe is remembered under. */
const agent = (): string => (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";

/** The size this browser refused a probe at, when it is remembered; another browser's (an update's) is none. */
async function probeRefusedAt(cache: Cache): Promise<number | null> {
  try {
    const hit = await cache.match(PART_PROBE_REFUSED_URL);
    if (!hit) return null;
    const m = JSON.parse(await hit.text()) as { bytes?: unknown; agent?: unknown };
    return typeof m.bytes === "number" && Number.isSafeInteger(m.bytes) && m.agent === agent() ? m.bytes : null;
  } catch {
    return null;
  }
}

const ZEROS = new Uint8Array(1024 * 1024);
/** A body of `bytes` zeros, streamed: a probe holds no more than one chunk. */
function zeros(bytes: number): ReadableStream<Uint8Array> {
  let left = bytes;
  return new ReadableStream({
    pull(c) {
      if (left === 0) return c.close();
      const n = Math.min(left, ZEROS.byteLength);
      c.enqueue(ZEROS.subarray(0, n));
      left -= n;
    },
  });
}

/** A scratch entry of `n` zeros, written and removed: whether the cache took it, and why not. */
async function probe(cache: Cache, n: number): Promise<{ taken: boolean; quota: boolean }> {
  let taken = false;
  let quota = false;
  try {
    await cache.put(PART_PROBE_URL, new Response(zeros(n)));
    taken = true;
  } catch (e) {
    quota = typeof e === "object" && e !== null && (e as { name?: unknown }).name === "QuotaExceededError";
  }
  try {
    await cache.delete(PART_PROBE_URL);
  } catch {
    // not removed: the next probe writes over it
  }
  return { taken, quota };
}

/**
 * Brings a part size that refusals lowered back up, once a file was cached at `partBytes`, by scratch
 * entries of zeros written and removed, so no file's own write is spent finding out. The first is of
 * `start` bytes (`PART_BYTES` for every load the package makes): a cache that takes it had no entry
 * cap behind the refusal (a write that failed for another reason), and the size is `start` again
 * after one write. A cache that refuses it is probed at twice the size, and twice that, below `start`:
 * each one it takes becomes the part size the next write uses, and the first it refuses ends the
 * probes and is remembered with the browser's user agent, so that nothing at or past that size is
 * probed again until the browser changes. A full disk (`QuotaExceededError`) ends them and is not
 * remembered. Nothing is thrown.
 */
export async function growPartBytes(cache: Cache, partBytes: number, start = PART_BYTES): Promise<void> {
  if (partBytes >= start) return;
  const refusedAt = await probeRefusedAt(cache);
  const remember = async (url: string, body: string): Promise<boolean> => {
    try {
      await cache.put(url, new Response(body));
      return true;
    } catch {
      return false; // not remembered: the next cached file probes again
    }
  };
  if (refusedAt === null) {
    const top = await probe(cache, start);
    if (top.taken) return void (await remember(PART_POLICY_URL, String(start)));
    if (top.quota) return;
  }
  // `start` is refused, now or as remembered: the largest doubling below it that the cache takes.
  for (let n = 2 * partBytes; n <= start && (refusedAt === null || n < refusedAt); n *= 2) {
    // `start` itself was probed above; a doubling that reaches it is that refusal.
    const p = n === start ? { taken: false, quota: false } : await probe(cache, n);
    if (p.quota) return;
    if (!p.taken) return void (await remember(PART_PROBE_REFUSED_URL, JSON.stringify({ bytes: n, agent: agent() })));
    if (!(await remember(PART_POLICY_URL, String(n)))) return;
  }
  // Every doubling below `start` was taken and `start` is not one of them: it is the refused size.
  if (refusedAt === null) await remember(PART_PROBE_REFUSED_URL, JSON.stringify({ bytes: start, agent: agent() }));
}

/**
 * Removes every entry of the file at `url`: the whole entry, the index, and every part of any size
 * (a set left without its index by a write that was cut short included). `partsOnly` leaves the
 * whole entry: a write of parts removes only what parts hold.
 */
export async function dropEntries(cache: Cache, url: string, partsOnly = false): Promise<void> {
  try {
    const keys = await cache.keys(url, { ignoreSearch: true });
    await Promise.all(keys.filter((k) => !partsOnly || (typeof k === "string" ? k : k.url) !== url).map((k) => cache.delete(k)));
  } catch {
    // not dropped: a later write replaces what it writes over
  }
}

/** Writes the index of a set whose parts are all in: the file is cached from here on. */
export async function writeIndex(cache: Cache, url: string, bytes: number, partBytes: number, headers: Record<string, string>): Promise<void> {
  await cache.put(
    indexUrl(url),
    new Response(null, {
      headers: {
        ...headers,
        [BYTES_HEADER]: String(bytes),
        [PART_BYTES_HEADER]: String(partBytes),
        [PARTS_HEADER]: String(Math.ceil(bytes / partBytes)),
      },
    }),
  );
}
