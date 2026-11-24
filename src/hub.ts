import { ModelsError } from "./errors";
import { STORE } from "./store";
import { dropEntries, growPartBytes, learnRefusal, partBytesFor, partExtent, partUrl, readIndex, writeIndex, type Parted } from "./parted";

/**
 * The Cache Storage cache every model file lives in, keyed by its Hub resolve URL: one entry for a
 * file up to the part size, and for a larger one several parts and an index under keys derived from
 * that URL (`parted.ts`).
 */
export const CACHE_NAME = STORE.hubCache;

/** Header on the cached Response recording whether the digest was checked when the entry was written. */
const VERIFIED_HEADER = "x-caldrix-verified";

/** Header on a cached empty Response recording that the Hub answered 404 for an optional file. */
/**
 * The sha256 of the bytes a whole-buffer fetch cached (lower-case hex), on the entry or its index: a
 * cache hit under no pin is hashed against it, so a copy that is no longer those bytes is fetched again.
 */
const DIGEST_HEADER = "x-caldrix-sha256";
const ABSENT_HEADER = "x-caldrix-absent";

export interface FetchOptions {
  hubBaseUrl: string;
  offline: boolean;
  onProgress?: (p: { file: string; loaded: number; total: number | null }) => void;
  signal?: AbortSignal;
  /**
   * The file is optional: a 404 is remembered in the cache, so a later load (online or offline)
   * learns the absence without a request. A revision is a pinned commit, so the answer cannot change.
   */
  rememberAbsent?: boolean;
  /**
   * The body's sha256 as the alias pins it (lower-case hex): checked before the Hub's etag, on the
   * network's bytes and on a cache hit's; a mismatch from the network is a `digest` refusal and is
   * not cached, a cache hit that fails is dropped and fetched again.
   */
  sha256?: string;
  /** Who pins `sha256`, named in a refusal: the built-in `"alias"` (the default) or the repo's `"listing"`. */
  pinnedBy?: "alias" | "listing";
  /**
   * The body's size as the alias pins it: a body that passes it is refused mid-stream (the rest is
   * cancelled, not read) before the sha256 check, and nothing is cached.
   */
  bytes?: number;
  /**
   * The part size a cache write starts from when none was learned (`parted.ts`). The package names
   * none (`PART_BYTES`); a test names one past what its browser takes, to see a part refused. It is
   * also the most a probe grows the size back to.
   */
  startPartBytes?: number;
}

/**
 * The refusal of a body that passed the size `bytes` it was fetched under (`FetchOptions.bytes`),
 * cut mid-stream: a `fetch` error a caller tells apart by its class, never by its words.
 */
export class BodyPastSize extends ModelsError {
  readonly bytes: number;
  constructor(message: string, bytes: number) {
    super("fetch", message);
    this.bytes = bytes;
  }
}

export interface FetchedFile {
  bytes: Uint8Array<ArrayBuffer>;
  source: "cache" | "network";
  verified: boolean;
  /** False when the file is good but could not be written to Cache Storage; the next visit refetches. */
  cached: boolean;
}

function hex(b: ArrayBuffer): string {
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** `W/"abc"` or `"abc"` or `abc` -> `abc`, lower-case. */
function normalizeEtag(v: string): string {
  return v.trim().replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase();
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One URL path segment: no empty or dot segment, no separator, query, fragment, `%` escape or control character. */
function segment(part: string, value: string): string {
  if (
    value === "" ||
    value === "." ||
    value === ".." ||
    /[/\\?#]/.test(value) ||
    /%[0-9a-fA-F]{2}/.test(value) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ModelsError("validate", `${part} ${JSON.stringify(value)} is not a single safe path segment`);
  }
  return encodeURIComponent(value);
}

function secureContext(api: string): ModelsError {
  return new ModelsError("backend", `${api} is not available; caldrix.js needs a secure context`);
}

/** `${hubBaseUrl}/${repo}/resolve/${revision}/${file}`, each part validated then percent-encoded. */
function resolveUrl(repo: string, revision: string, file: string, hubBaseUrl: string): string {
  const repoPath = repo
    .split("/")
    .map((r) => segment("repo", r))
    .join("/");
  // One trailing `/` on the base is the caller's spelling of the same origin; it never doubles in the URL or key.
  const base = hubBaseUrl.endsWith("/") ? hubBaseUrl.slice(0, -1) : hubBaseUrl;
  return `${base}/${repoPath}/resolve/${segment("revision", revision)}/${segment("file", file)}`;
}

/** `${hubBaseUrl}/api/models/${repo}[/revision/${revision}]?blobs=true`: the Hub's listing of a repo, each part validated then encoded. */
export function listingUrl(repo: string, revision: string | null, hubBaseUrl: string): string {
  const repoPath = repo
    .split("/")
    .map((r) => segment("repo", r))
    .join("/");
  const base = hubBaseUrl.endsWith("/") ? hubBaseUrl.slice(0, -1) : hubBaseUrl;
  // A revision such as `refs/pr/1` is one path segment on the Hub, its slashes escaped.
  const rev =
    revision === null
      ? ""
      : `/revision/${revision
          .split("/")
          .map((r) => segment("revision", r))
          .join("%2F")}`;
  return `${base}/api/models/${repoPath}${rev}?blobs=true`;
}

async function openCache(file: string): Promise<Cache> {
  if (typeof caches === "undefined") throw secureContext("caches");
  try {
    return await caches.open(CACHE_NAME);
  } catch (e) {
    throw new ModelsError("backend", `opening the cache for ${file} failed: ${reason(e)}`);
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) throw secureContext("crypto.subtle");
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function offlineUncached(file: string): ModelsError {
  return new ModelsError("fetch", `${file} is not in the cache and offline is set`, "offline-uncached");
}

function fetchFailed(file: string, why: string, missing?: "not-found"): ModelsError {
  return new ModelsError("fetch", `fetching ${file} ${why}`, missing);
}

async function match(cache: Cache, url: string, file: string): Promise<Response | undefined> {
  try {
    return await cache.match(url);
  } catch (e) {
    throw new ModelsError("backend", `reading ${file} from the cache failed: ${reason(e)}`);
  }
}

/** The cache side of a model file: its URL (the key), the cache, and its entry, an absence marker resolved. */
interface Lookup {
  url: string;
  cache: Cache;
  hit: Response | undefined;
  /** The file's index, when no whole entry holds it and it is cached as parts. */
  parts: Parted | undefined;
  absent: (where: string) => ModelsError;
}

/** The index of a file cached as parts; a cache that fails to answer is the caller's `backend` error. */
async function matchIndex(cache: Cache, url: string, file: string): Promise<Parted | undefined> {
  try {
    return await readIndex(cache, url);
  } catch (e) {
    throw new ModelsError("backend", `reading ${file} from the cache failed: ${reason(e)}`);
  }
}

/** A part the index names is not in the cache: the file is not cached after all. */
class MissingPart extends Error {}

/**
 * Reads a file cached as parts in order through `each` (awaited), a part at a time, never whole.
 * Returns the byte count; a part that is missing or not its recorded length is a `MissingPart`.
 */
async function readParts(
  cache: Cache,
  url: string,
  p: Parted,
  file: string,
  o: FetchOptions,
  each: (bytes: Uint8Array, offset: number) => void | Promise<void>,
): Promise<number> {
  let loaded = 0;
  for (let i = 0; i < p.parts; i++) {
    const hit = await match(cache, partUrl(url, p.partBytes, i), file);
    if (!hit) throw new MissingPart();
    const base = loaded;
    const n = await readCached(hit, file, o, (c, offset) => each(c, base + offset));
    if (n !== partExtent(p, i).length) throw new MissingPart();
    loaded += n;
  }
  return loaded;
}

/** Whether every part the index names is in the cache (their bodies unread). */
async function partsPresent(cache: Cache, url: string, p: Parted, file: string): Promise<boolean> {
  for (let i = 0; i < p.parts; i++) {
    const hit = await match(cache, partUrl(url, p.partBytes, i), file);
    if (!hit) return false;
    hit.body?.cancel().catch(() => undefined);
  }
  return true;
}

async function lookup(repo: string, revision: string, file: string, o: FetchOptions): Promise<Lookup> {
  const url = resolveUrl(repo, revision, file, o.hubBaseUrl);
  const cache = await openCache(file);
  let hit = await match(cache, url, file);
  const absent = (where: string) =>
    new ModelsError("fetch", `fetching ${file} failed: HTTP 404${where}`, "not-found");
  if (hit && hit.headers.get(ABSENT_HEADER) === "1") {
    // Only an optional file's absence is ever written; a required fetch of the same URL asks the Hub.
    if (o.rememberAbsent) throw absent(" (remembered from an earlier load)");
    hit = undefined;
  }
  const parts = hit ? undefined : await matchIndex(cache, url, file);
  return { url, cache, hit, parts, absent };
}

/** A cached copy that is not the pinned file or the bytes that were cached (or lacks a part) is dropped, whole or in parts; the file is fetched again. */
async function dropFailedPin(cache: Cache, url: string): Promise<void> {
  await dropEntries(cache, url);
}

/** The offline refusals once the cache has not served the file. */
function refuseOffline(file: string, o: FetchOptions, pinFailed: boolean, changed = false): void {
  if (o.offline && changed) {
    throw new ModelsError("fetch", `${file}: the cached copy is not the bytes that were cached and offline is set`, "offline-uncached");
  }
  if (o.offline && pinFailed) {
    throw new ModelsError(
      "fetch",
      `${file}: the cached copy fails the ${o.pinnedBy ?? "alias"}'s sha256 pin and offline is set`,
      "offline-uncached",
    );
  }
  if (o.offline) throw offlineUncached(file);
}

interface Download {
  body: ReadableStream<Uint8Array>;
  etag: string | null;
  total: number | null;
  /** A compressed transfer's Content-Length counts encoded bytes, so it is only checked on an identity body. */
  identity: boolean;
}

/** The Hub's answer for a file: a 404 of an optional file remembered, any other failure refused. */
async function download(
  l: Pick<Lookup, "url" | "absent"> & { cache?: Cache; noStore?: boolean },
  file: string,
  o: FetchOptions,
): Promise<Download> {
  let res: Response;
  try {
    // `noStore`: a file never kept, which the browser's HTTP cache does not keep either.
    res = await fetch(l.url, { signal: o.signal, ...(l.noStore ? { cache: "no-store" as const } : {}) });
  } catch (e) {
    throw fetchFailed(file, o.signal?.aborted ? "was aborted" : `failed: ${reason(e)}`);
  }
  if (res.status === 404 && o.rememberAbsent) {
    try {
      await l.cache?.put(l.url, new Response(null, { headers: { [ABSENT_HEADER]: "1" } }));
    } catch {
      // not remembered: the next load asks again
    }
    throw l.absent("");
  }
  if (!res.ok || !res.body) {
    throw fetchFailed(file, `failed: HTTP ${res.status}`, res.status === 404 ? "not-found" : undefined);
  }
  const len = res.headers.get("content-length");
  return {
    body: res.body,
    etag: res.headers.get("x-linked-etag"),
    total: len !== null && /^\d+$/.test(len.trim()) ? Number(len) : null,
    identity: !res.headers.get("content-encoding"),
  };
}

/**
 * Reads a download's body in order, handing each chunk and its offset to `each` (awaited before the
 * next read) once it is within the pinned size; then the abort and Content-Length checks. Returns the
 * byte count. A throw from `each` or `onProgress` is the caller's, not a fetch failure.
 */
async function readBody(
  d: Download,
  file: string,
  o: FetchOptions,
  each: (bytes: Uint8Array, offset: number) => void | Promise<void>,
): Promise<number> {
  let loaded = 0;
  const reader = d.body.getReader();
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        throw fetchFailed(file, o.signal?.aborted ? "was aborted" : `failed: ${reason(e)}`);
      }
      if (r.done) break;
      if (o.signal?.aborted) throw fetchFailed(file, "was aborted");
      const offset = loaded;
      loaded += r.value.byteLength;
      if (o.bytes !== undefined && loaded > o.bytes) {
        throw new BodyPastSize(`${file}: the body passed its pinned size, ${o.bytes} bytes`, o.bytes);
      }
      await each(r.value, offset);
      o.onProgress?.({ file, loaded, total: d.total });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (o.signal?.aborted) throw fetchFailed(file, "was aborted");
  if (d.total !== null && d.total !== loaded && d.identity) {
    throw fetchFailed(file, `failed: Content-Length is ${d.total} but ${loaded} bytes arrived`);
  }
  o.onProgress?.({ file, loaded, total: d.total });
  return loaded;
}

/**
 * The checks on a downloaded body: the pinned sha256, then the Hub's `X-Linked-Etag`. `digest` is
 * called once, and only when a check applies. Returns whether one applied (the body is verified).
 */
async function checkDigest(file: string, o: FetchOptions, etag: string | null, digest: () => string | Promise<string>): Promise<boolean> {
  let verified = false;
  let got: string | null = null;
  if (o.sha256 !== undefined) {
    got = await digest();
    if (got !== o.sha256) {
      throw new ModelsError("digest", `${file}: sha256 is ${got} but the ${o.pinnedBy ?? "alias"} pins ${o.sha256}`);
    }
    verified = true;
  }
  if (etag !== null) {
    const want = normalizeEtag(etag);
    got ??= await digest();
    if (want !== got) {
      throw new ModelsError("digest", `${file}: sha256 is ${got} but the Hub's X-Linked-Etag is ${want}`);
    }
    verified = true;
  }
  return verified;
}

/**
 * Fetch one model file from the Hub through Cache Storage. `repo` is `owner/name` (each part a segment),
 * `revision` and `file` are single segments; each is validated and then percent-encoded, so the URL is
 * `${hubBaseUrl}/${repo}/resolve/${revision}/${file}` built from those parts only, and is the cache key.
 * The entry is written only after the whole body is read and the digest, when the Hub sent
 * `X-Linked-Etag`, matches. A failed cache write does not fail the fetch (`cached: false`).
 */
export async function fetchFile(
  repo: string,
  revision: string,
  file: string,
  o: FetchOptions,
): Promise<FetchedFile> {
  const l = await lookup(repo, revision, file, o);
  let pinFailed = false;
  /** The cached copy is not the bytes its own digest names. */
  let changed = false;
  // A file cached as parts is read whole, as a whole entry is; one lacking a part is not cached.
  let cachedBytes: Uint8Array<ArrayBuffer> | undefined;
  let cachedHeaders = l.hit?.headers;
  if (l.hit) cachedBytes = new Uint8Array(await l.hit.arrayBuffer());
  else if (l.parts) {
    const whole = new Uint8Array(l.parts.bytes);
    try {
      await readParts(l.cache, l.url, l.parts, file, o, (c, offset) => whole.set(c, offset));
      cachedBytes = whole;
      cachedHeaders = l.parts.headers;
    } catch (e) {
      if (!(e instanceof MissingPart)) throw e;
      await dropFailedPin(l.cache, l.url);
    }
  }
  if (cachedBytes && cachedHeaders) {
    const bytes = cachedBytes;
    if (o.sha256 === undefined) {
      // Under no pin the copy is checked against the digest it was cached with; one cached before
      // that digest was written is used as stored.
      const stored = cachedHeaders.get(DIGEST_HEADER);
      if (stored === null || (await sha256Hex(bytes)) === stored) {
        return { bytes, source: "cache", verified: cachedHeaders.get(VERIFIED_HEADER) === "1", cached: true };
      }
      changed = true;
    } else {
      if ((await sha256Hex(bytes)) === o.sha256) return { bytes, source: "cache", verified: true, cached: true };
      pinFailed = true;
    }
    await dropFailedPin(l.cache, l.url);
  }
  refuseOffline(file, o, pinFailed, changed);

  const d = await download(l, file, o);
  const chunks: Uint8Array[] = [];
  const loaded = await readBody(d, file, o, (c) => void chunks.push(c));
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  const digest = await sha256Hex(bytes);
  const verified = await checkDigest(file, o, d.etag, () => digest);

  if (o.signal?.aborted) throw fetchFailed(file, "was aborted");
  const headers = { [VERIFIED_HEADER]: verified ? "1" : "0", [DIGEST_HEADER]: digest };
  const partBytes = await partBytesFor(l.cache, o.startPartBytes);
  if (bytes.byteLength > partBytes) {
    const cached = await putParts(l.cache, l.url, bytes, partBytes, headers);
    if (cached) await growPartBytes(l.cache, partBytes, o.startPartBytes);
    return { bytes, source: "network", verified, cached };
  }
  try {
    await l.cache.put(l.url, new Response(bytes, { headers }));
  } catch (e) {
    // A whole entry the cache refuses is learned from, as a part is: the next write of it is parts.
    await learnRefusal(l.cache, partBytes, e, bytes.byteLength);
    return { bytes, source: "network", verified, cached: false };
  }
  return { bytes, source: "network", verified, cached: true };
}

/**
 * Writes `bytes` as parts of `partBytes`, then the index. A part the cache refuses is learned from
 * (`learnRefusal`), and whatever was written is removed: false, the file not cached.
 */
async function putParts(cache: Cache, url: string, bytes: Uint8Array<ArrayBuffer>, partBytes: number, headers: Record<string, string>): Promise<boolean> {
  // What an earlier write left under another part size would never be read again.
  await dropEntries(cache, url, true);
  try {
    for (let i = 0, at = 0; at < bytes.byteLength; i++, at += partBytes) {
      try {
        await cache.put(partUrl(url, partBytes, i), new Response(bytes.subarray(at, at + partBytes)));
      } catch (e) {
        await learnRefusal(cache, partBytes, e);
        throw e;
      }
    }
    await writeIndex(cache, url, bytes.byteLength, partBytes, headers);
    return true;
  } catch {
    await dropEntries(cache, url, true);
    return false;
  }
}

/** The host's incremental SHA-256: `finish` is the lower-case hex digest of every byte `update` saw. */
export interface Hasher {
  update(bytes: Uint8Array): void;
  finish(): string;
}

export interface StreamOptions extends FetchOptions {
  /** A fresh hasher; called once per pass over the bytes. */
  hasher: () => Hasher;
  /**
   * Each chunk in order with its byte offset, awaited before the next read; never called again after
   * it throws. The bytes are shared with the cache write: read them, never modify or transfer them.
   */
  onChunk: (bytes: Uint8Array, offset: number) => void | Promise<void>;
  /**
   * Called once every byte was delivered and the checks passed, before the cache entry is committed
   * (and before a cache hit resolves): a throw fails the call with it and leaves no new entry.
   */
  onEnd?: () => void | Promise<void>;
  /**
   * A cached copy under a sha256 pin is read once: delivered as it is hashed, and checked when it
   * ends. Without this it is read twice, hashed whole before a byte is delivered. The caller takes
   * on what the first read spared it: when the copy fails the pin, or a part of it is gone, the
   * copy is dropped and the call rejects with `StaleCache` after `onChunk` has seen its bytes, for
   * the caller to discard what it built and call again (the file then comes from the network).
   * Offline, that rejection is the cached-copy-fails-its-pin refusal instead.
   */
  singlePass?: boolean;
  /**
   * `false`: the file is streamed straight from the network and never kept, for a caller that
   * keeps what it makes of the bytes itself. Cache Storage is neither read nor written (a copy
   * there is not used), the size and sha256 checks still hold, offline is refused, and
   * `cached` is `false`. The default, `true`, caches the file as above.
   */
  cache?: boolean;
}

/**
 * A cached copy read under `singlePass` failed its sha256 pin, or had lost a part, after its bytes
 * were delivered. It has been dropped: the same call again fetches the file.
 */
export class StaleCache extends ModelsError {
  constructor(file: string) {
    super("digest", `${file}: the cached copy does not match its sha256 pin; it was dropped`);
    this.name = "StaleCache";
  }
}

export interface StreamedFile {
  /** `store`: a kept file read by `streamBlob`, never the Hub. */
  source: "cache" | "network" | "store";
  verified: boolean;
  /** False when the file is good but could not be written to Cache Storage; the next visit refetches. */
  cached: boolean;
  /** The body bytes delivered to `onChunk`. */
  loaded: number;
}

/** Reads a cached entry's body in order through `each` (awaited), never whole. Returns the byte count. */
async function readCached(
  hit: Response,
  file: string,
  o: FetchOptions,
  each: (bytes: Uint8Array, offset: number) => void | Promise<void>,
): Promise<number> {
  let loaded = 0;
  if (!hit.body) return loaded;
  const reader = hit.body.getReader();
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        throw new ModelsError("backend", `reading ${file} from the cache failed: ${reason(e)}`);
      }
      if (r.done) return loaded;
      if (o.signal?.aborted) throw fetchFailed(file, "was aborted");
      const offset = loaded;
      loaded += r.value.byteLength;
      await each(r.value, offset);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/**
 * A cache entry written while its body streams in: the Response's body is a stream this side closes
 * (`commit`) only after the checks pass and errors (`discard`) otherwise, so the cache commits a
 * checked entry or nothing, and an entry it would have replaced stays unless it commits. Each write
 * waits for the cache to take the chunk (backpressure). A `put` that fails early ends the writes;
 * the load goes on and `commit` answers false.
 */
function streamedEntry(cache: Cache, url: string, verified: boolean) {
  const pipe = new TransformStream<Uint8Array, Uint8Array>();
  const writer = pipe.writable.getWriter();
  let alive = true;
  let failure: unknown;
  const put = cache.put(url, new Response(pipe.readable, { headers: { [VERIFIED_HEADER]: verified ? "1" : "0" } })).then(
    () => true,
    (e: unknown) => {
      failure = e;
      return (alive = false);
    },
  );
  return {
    /** Why the put failed, once `commit` answered false. */
    failure: () => failure,
    async write(bytes: Uint8Array): Promise<void> {
      if (!alive) return;
      // A write blocked on a dead put's backpressure is let go when the put settles.
      await Promise.race([writer.write(bytes).catch(() => (alive = false)), put]);
    },
    commit(): Promise<boolean> {
      if (alive) writer.close().catch(() => undefined);
      return put;
    },
    async discard(why: unknown): Promise<void> {
      writer.abort(why).catch(() => undefined);
      await put;
    },
  };
}

/**
 * A streamed file written as parts (`parted.ts`): each part is a `streamedEntry` of its own, closed
 * when it is full, and the index is written by `commit`, after the checks passed. A part the cache
 * refuses ends the writes and is learned from; the load goes on, `commit` answers false and removes
 * what was written, as `discard` does.
 */
function partedEntry(cache: Cache, url: string, verified: boolean, partBytes: number) {
  let alive = true;
  let part: ReturnType<typeof streamedEntry> | null = null;
  let i = 0;
  let filled = 0;
  let total = 0;
  // What an earlier write left under another part size would never be read again.
  const cleared = dropEntries(cache, url, true);
  const close = async (): Promise<void> => {
    const p = part;
    part = null;
    if (p === null) return;
    if (!(await p.commit())) {
      alive = false;
      await learnRefusal(cache, partBytes, p.failure());
    }
    i += 1;
    filled = 0;
  };
  return {
    async write(bytes: Uint8Array): Promise<void> {
      await cleared;
      let at = 0;
      while (alive && at < bytes.byteLength) {
        part ??= streamedEntry(cache, partUrl(url, partBytes, i), verified);
        const take = Math.min(bytes.byteLength - at, partBytes - filled);
        await part.write(bytes.subarray(at, at + take));
        at += take;
        filled += take;
        total += take;
        if (filled === partBytes) await close();
      }
    },
    async commit(): Promise<boolean> {
      await cleared;
      if (alive) await close();
      if (alive) {
        try {
          await writeIndex(cache, url, total, partBytes, { [VERIFIED_HEADER]: verified ? "1" : "0" });
          return true;
        } catch {
          // falls through: nothing is kept
        }
      }
      await dropEntries(cache, url, true);
      return false;
    },
    async discard(why: unknown): Promise<void> {
      await cleared;
      await part?.discard(why);
      part = null;
      await dropEntries(cache, url, true);
    },
  };
}

/**
 * The streaming sibling of `fetchFile`: the same URL, cache entry, absence marker, offline rules,
 * size pin, Content-Length check, digest checks and error texts, but the body is never held whole.
 * Each chunk goes to `onChunk` in order (awaited) and through a hasher. A cache hit streams the entry;
 * under a pinned sha256 it is first hashed without being delivered, so a copy failing the pin is
 * dropped and fetched again (or refused offline) as `fetchFile` does, before `onChunk` sees a byte;
 * the second read, which delivers it, is hashed as well and checked against the pin before the call
 * resolves, so bytes that differ from the first read's are a `digest` refusal and the entry is dropped
 * (the caller has then been handed them, and aborts what it built from them). A hit with no pin is
 * delivered unhashed, `verified` as recorded when it was written.
 * From the network, the body is also streamed into the cache entry, which commits only after the
 * checks pass: a failure of any kind rejects the call and leaves no new entry, and removes none.
 */
export async function streamFile(repo: string, revision: string, file: string, o: StreamOptions): Promise<StreamedFile> {
  if (o.cache === false) return streamUncached(repo, revision, file, o);
  const l = await lookup(repo, revision, file, o);
  let pinFailed = false;
  // The cached copy, a whole entry or parts, read in order; each call reads it from its start.
  type Each = (bytes: Uint8Array, offset: number) => void | Promise<void>;
  let cached: { read: (each: Each) => Promise<number>; verified: boolean } | undefined;
  if (l.hit) {
    let hit: Response | undefined = l.hit;
    cached = {
      verified: l.hit.headers.get(VERIFIED_HEADER) === "1",
      // The entry is matched again for a second read: a clone would buffer one branch whole.
      read: async (each) => {
        const h = hit ?? (await match(l.cache, l.url, file));
        hit = undefined;
        if (!h) throw new MissingPart();
        return readCached(h, file, o, each);
      },
    };
  } else if (l.parts) {
    const p = l.parts;
    if (await partsPresent(l.cache, l.url, p, file)) {
      cached = { verified: p.headers.get(VERIFIED_HEADER) === "1", read: (each) => readParts(l.cache, l.url, p, file, o, each) };
    } else {
      await dropFailedPin(l.cache, l.url);
    }
  }
  if (cached && o.sha256 !== undefined && !o.singlePass) {
    const h = o.hasher();
    let whole = true;
    try {
      await cached.read((c) => h.update(c));
    } catch (e) {
      if (!(e instanceof MissingPart)) throw e;
      whole = false;
    }
    if (!whole) {
      cached = undefined;
      await dropFailedPin(l.cache, l.url);
    } else if (h.finish() !== o.sha256) {
      pinFailed = true;
      cached = undefined;
      await dropFailedPin(l.cache, l.url);
    }
  }
  if (cached) {
    // A part that goes missing once bytes were delivered cannot be answered by a fetch.
    const gone = (e: unknown) => (e instanceof MissingPart ? new ModelsError("backend", `reading ${file} from the cache failed: a part of it is gone`) : e);
    if (o.sha256 === undefined) {
      let loaded: number;
      try {
        loaded = await cached.read(o.onChunk);
      } catch (e) {
        if (e instanceof MissingPart) await dropFailedPin(l.cache, l.url);
        throw gone(e);
      }
      await o.onEnd?.();
      return { source: "cache", verified: cached.verified, cached: true, loaded };
    }
    // The delivering read is hashed too, and checked against the pin before the call resolves:
    // an entry that changed between the two reads fails as a digest mismatch and is dropped.
    const h = o.hasher();
    let loaded: number;
    // Whether the failure is `onChunk`'s own: then it is the caller's to report, not a stale copy.
    let callers = false;
    try {
      loaded = await cached.read(async (c, offset) => {
        h.update(c);
        try {
          await o.onChunk(c, offset);
        } catch (e) {
          callers = true;
          throw e;
        }
      });
      await checkDigest(file, o, null, () => h.finish());
    } catch (e) {
      const stale = e instanceof MissingPart || (e instanceof ModelsError && e.kind === "digest");
      if (stale) await dropFailedPin(l.cache, l.url);
      if (o.singlePass && stale && !callers) {
        refuseOffline(file, o, true);
        throw new StaleCache(file);
      }
      throw gone(e);
    }
    await o.onEnd?.();
    return { source: "cache", verified: true, cached: true, loaded };
  }
  refuseOffline(file, o, pinFailed);

  const d = await download(l, file, o);
  const hasher = o.hasher();
  const verifiedEntry = o.sha256 !== undefined || d.etag !== null;
  // A file known to be within the part size is one entry, as before; any other is written as parts.
  const partBytes = await partBytesFor(l.cache, o.startPartBytes);
  const whole = d.total !== null && d.identity && d.total <= partBytes ? streamedEntry(l.cache, l.url, verifiedEntry) : null;
  const entry = whole ?? partedEntry(l.cache, l.url, verifiedEntry, partBytes);
  try {
    const loaded = await readBody(d, file, o, async (c, offset) => {
      hasher.update(c);
      await Promise.all([o.onChunk(c, offset), entry.write(c)]);
    });
    const verified = await checkDigest(file, o, d.etag, () => hasher.finish());
    if (o.signal?.aborted) throw fetchFailed(file, "was aborted");
    await o.onEnd?.();
    const cached = await entry.commit();
    // A whole entry the cache refuses is learned from, as a part is: the next write of it is parts.
    if (!cached && whole !== null) await learnRefusal(l.cache, partBytes, whole.failure(), loaded);
    // A file cached as parts of a lowered size: probe for the largest size the cache takes.
    if (cached && whole === null) await growPartBytes(l.cache, partBytes, o.startPartBytes);
    return { source: "network", verified, cached, loaded };
  } catch (e) {
    await entry.discard(e);
    throw e;
  }
}

/** `streamFile` under `cache: false`: the network's bytes, checked, never kept. */
async function streamUncached(repo: string, revision: string, file: string, o: StreamOptions): Promise<StreamedFile> {
  if (o.offline) throw offlineUncached(file);
  const url = resolveUrl(repo, revision, file, o.hubBaseUrl);
  const absent = (where: string) => new ModelsError("fetch", `fetching ${file} failed: HTTP 404${where}`, "not-found");
  const d = await download({ url, absent, noStore: true }, file, o);
  const hasher = o.hasher();
  const loaded = await readBody(d, file, o, async (c, offset) => {
    hasher.update(c);
    await o.onChunk(c, offset);
  });
  const verified = await checkDigest(file, o, d.etag, () => hasher.finish());
  if (o.signal?.aborted) throw fetchFailed(file, "was aborted");
  await o.onEnd?.();
  return { source: "network", verified, cached: false, loaded };
}

/**
 * `length` bytes of a model file from byte `start` (0: its head), for a header read, or the one
 * small tensor the precheck reads past it, before the file is fetched: never cached and never
 * verified (the caller parses them as hostile input). A whole cached copy serves them with no
 * request; else one `Range: bytes=<start>-<start + length - 1>` request, whose `206` must carry
 * exactly `length` bytes. A `200` (a server ignoring the range) is the whole file: from 0 it is
 * read to `length` and its body cancelled; from any other start it is refused, so a range past the
 * head never reads the file up to it. Only the status and the body's length are relied on.
 */
export async function fetchRange(
  repo: string,
  revision: string,
  file: string,
  length: number,
  o: FetchOptions,
  start = 0,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new ModelsError("request", `a range of ${length} bytes of ${file} is not a positive integer`);
  }
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(start + length)) {
    throw new ModelsError("request", `a range from byte ${start} of ${file} is not a non-negative integer`);
  }
  const url = resolveUrl(repo, revision, file, o.hubBaseUrl);
  const cache = await openCache(file);
  const hit = await match(cache, url, file);
  if (hit && hit.headers.get(ABSENT_HEADER) !== "1") {
    // The entry as a blob, sliced: only the asked extent is read, never the whole file.
    const whole = await hit.blob();
    if (whole.size >= start + length) return new Uint8Array(await whole.slice(start, start + length).arrayBuffer());
  }
  const parts = hit ? undefined : await matchIndex(cache, url, file);
  if (parts && parts.bytes >= start + length) {
    // From the parts that hold the extent, each sliced; a missing part falls through to the request.
    const out = new Uint8Array(length);
    let filled = 0;
    for (let i = Math.floor(start / parts.partBytes); filled < length; i++) {
      const part = await match(cache, partUrl(url, parts.partBytes, i), file);
      if (!part) break;
      const from = start + filled - partExtent(parts, i).start;
      const piece = new Uint8Array(await (await part.blob()).slice(from, from + length - filled).arrayBuffer());
      if (piece.byteLength === 0) break;
      out.set(piece, filled);
      filled += piece.byteLength;
    }
    if (filled === length) return out;
  }
  if (o.offline) throw offlineUncached(file);

  const what = start === 0 ? `the first ${length} bytes` : `${length} bytes from byte ${start}`;
  const failed = (why: string) => new ModelsError("fetch", `fetching ${what} of ${file} ${why}`);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, signal: o.signal });
  } catch (e) {
    throw failed(o.signal?.aborted ? "was aborted" : `failed: ${reason(e)}`);
  }
  if ((res.status !== 206 && res.status !== 200) || !res.body) {
    throw failed(`failed: HTTP ${res.status}`);
  }
  if (res.status === 200 && start !== 0) {
    res.body.cancel().catch(() => undefined);
    throw failed("failed: the server answered HTTP 200 (the whole file) to a range past its head");
  }
  const out = new Uint8Array(length);
  let loaded = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        throw failed(o.signal?.aborted ? "was aborted" : `failed: ${reason(e)}`);
      }
      if (r.done) break;
      const take = Math.min(r.value.byteLength, length - loaded);
      out.set(r.value.subarray(0, take), loaded);
      loaded += r.value.byteLength;
      // A 200 is the whole file, read no further than asked; a 206 past the length is refused.
      if (loaded > length || (res.status === 200 && loaded === length)) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (o.signal?.aborted) throw failed("was aborted");
  if (loaded < length) throw failed(`failed: the HTTP ${res.status} answer carried ${loaded} bytes, not the ${length} asked for`);
  if (res.status === 206 && loaded > length) throw failed(`failed: the HTTP 206 answer carried more than the ${length} bytes asked for`);
  return out;
}

/** The most listing bytes read: equal to the host's `caldrix_web::listing::LISTING_CAP` (256 << 10), so the host is never handed more than it accepts. */
export const LISTING_CAP = 262144;

export interface FetchedListing {
  bytes: Uint8Array<ArrayBuffer>;
  source: "cache" | "network";
}

/**
 * Fetch a repo's Hub listing. The cache serves it offline only: online the Hub is always asked, so a
 * stale listing never outlives a connection. The body is read under `LISTING_CAP` and cached only whole.
 */
export async function fetchListing(
  repo: string,
  revision: string | null,
  o: Pick<FetchOptions, "hubBaseUrl" | "offline" | "signal">,
): Promise<FetchedListing> {
  const url = listingUrl(repo, revision, o.hubBaseUrl);
  const what = `the Hub listing of ${repo}`;
  const cache = await openCache(what);
  if (o.offline) {
    let hit: Response | undefined;
    try {
      hit = await cache.match(url);
    } catch (e) {
      throw new ModelsError("backend", `reading ${what} from the cache failed: ${reason(e)}`);
    }
    if (!hit) throw new ModelsError("fetch", `${what} is not in the cache and offline is set`, "offline-uncached");
    return { bytes: new Uint8Array(await hit.arrayBuffer()), source: "cache" };
  }

  const failed = (why: string) => new ModelsError("fetch", `fetching ${what} ${why}`);
  let res: Response;
  try {
    res = await fetch(url, { signal: o.signal });
  } catch (e) {
    throw failed(o.signal?.aborted ? "was aborted" : `failed: ${reason(e)}`);
  }
  const refuse = (e: ModelsError): never => {
    res.body?.cancel().catch(() => undefined);
    throw e;
  };
  const origin = new URL(o.hubBaseUrl).origin;
  if (res.url && new URL(res.url).origin !== origin) {
    refuse(new ModelsError("fetch", `${what} was redirected off ${origin} (to ${res.url})`));
  }
  if (res.status === 401) {
    refuse(
      new ModelsError(
        "fetch",
        `${repo}: the Hub answered HTTP 401 for its listing: the repo does not exist, or it is private (the browser build sends no token; the caldrix CLI reads HF_TOKEN)`,
        "not-found",
      ),
    );
  }
  if (res.status === 404) {
    refuse(
      new ModelsError(
        "fetch",
        `${repo}${revision ? "@" + revision : ""}: no such repo or revision on the Hub (HTTP 404)`,
        "not-found",
      ),
    );
  }
  if (!res.ok || !res.body) refuse(failed(`failed: HTTP ${res.status}`));

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body!.getReader();
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        throw failed(o.signal?.aborted ? "was aborted" : `failed: ${reason(e)}`);
      }
      if (r.done) break;
      loaded += r.value.byteLength;
      if (loaded > LISTING_CAP) {
        throw new ModelsError("validate", `${what} passed the 256 KiB (${LISTING_CAP}-byte) cap`);
      }
      chunks.push(r.value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (o.signal?.aborted) throw failed("was aborted");
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    await cache.put(url, new Response(bytes));
  } catch {
    // not cached: offline will not find it, but the call is good
  }
  return { bytes, source: "network" };
}

/** Why a read of a kept file failed: an error's name and message (a browser's read errors are named). */
function readWhy(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * `length` bytes of a kept file (`blob`, named `file` in errors) from byte `start` (absent: 0), the
 * reads a load makes before the body: never past the file's end.
 */
export async function blobRange(blob: Blob, file: string, length: number, start = 0): Promise<Uint8Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > blob.size) {
    throw new ModelsError("validate", `${file}: bytes ${start} to ${start + length} are past its ${blob.size} bytes`);
  }
  try {
    return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
  } catch (e) {
    throw new ModelsError("fetch", `${file}: reading it from the store failed: ${readWhy(e)}`);
  }
}

/**
 * A kept file (`blob`, named `file` in errors) delivered as `streamFile` delivers a Hub file: in order to
 * `o.onChunk`, each awaited, hashed with `o.hasher()`. A size other than `o.bytes` is refused before the
 * first chunk, and a sha256 other than `o.sha256` after the last, before `o.onEnd`. Nothing is fetched or
 * cached; `o.hubBaseUrl`, `o.offline`, `o.cache` and `o.singlePass` are not read.
 */
export async function streamBlob(blob: Blob, file: string, o: StreamOptions): Promise<StreamedFile> {
  const aborted = () => new ModelsError("fetch", `${file}: reading it from the store was aborted`);
  if (o.signal?.aborted) throw aborted();
  if (o.bytes !== undefined && blob.size !== o.bytes) {
    throw new ModelsError("validate", `${file}: ${blob.size} bytes but its record says ${o.bytes}`);
  }
  const hasher = o.hasher();
  const reader = blob.stream().getReader();
  let loaded = 0;
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        if (o.signal?.aborted) throw aborted();
        throw new ModelsError("fetch", `${file}: reading it from the store failed: ${readWhy(e)}`);
      }
      if (r.done) break;
      if (o.signal?.aborted) throw aborted();
      const offset = loaded;
      loaded += r.value.byteLength;
      hasher.update(r.value);
      await o.onChunk(r.value, offset);
      o.onProgress?.({ file, loaded, total: blob.size });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (o.signal?.aborted) throw aborted();
  if (o.sha256 !== undefined) {
    const got = await hasher.finish();
    if (got !== o.sha256) throw new ModelsError("digest", `${file}: sha256 is ${got} but its record says ${o.sha256}`);
  }
  await o.onEnd?.();
  return { source: "store", verified: o.sha256 !== undefined, cached: false, loaded };
}
