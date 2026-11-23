/** Doubles for `fetch` and `caches`: real streams and Responses, no network. */

export interface Route {
  status?: number;
  chunks?: Uint8Array[];
  headers?: Record<string, string>;
  /** Error the body stream raises after its chunks. */
  failAfter?: Error;
  /** Called after each chunk is handed out (a test aborts its signal here). */
  afterChunk?: (index: number) => void;
  /** Set when the reader cancelled the body before its end. */
  cancelled?: boolean;
  /** The Response's `url`, standing in for the URL after a redirect. */
  url?: string;
}

export class FakeFetch {
  readonly calls: { url: string; signal?: AbortSignal; range?: string; cache?: RequestCache }[] = [];
  readonly routes = new Map<string, Route>();

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const range = new Headers(init?.headers).get("range") ?? undefined;
    this.calls.push({
      url,
      signal: init?.signal ?? undefined,
      ...(range !== undefined ? { range } : {}),
      ...(init?.cache !== undefined ? { cache: init.cache } : {}),
    });
    const route = this.routes.get(url);
    if (!route) return new Response("not found", { status: 404 });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const chunks = route.chunks ?? [];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
          route.afterChunk?.(i);
        }
        else if (route.failAfter) controller.error(route.failAfter);
        else controller.close();
      },
      cancel() {
        route.cancelled = true;
      },
    });
    const res = new Response(body, { status: route.status ?? 200, headers: route.headers });
    if (route.url !== undefined) Object.defineProperty(res, "url", { value: route.url });
    return res;
  };
}

export class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(url: string): Promise<Response | undefined> {
    if (this.failMatch) throw this.failMatch;
    return this.entries.get(url)?.clone();
  }
  failPut?: Error;
  /** A `put` of a body past this many bytes is refused, after the body is read. */
  maxEntryBytes?: number;
  /** The name of the error such a refusal carries. */
  capError = "UnknownError";
  failMatch?: Error;
  /** While pending, a `put` reads none of its body (a slow cache write). */
  putGate?: Promise<void>;
  /**
   * As Cache Storage does: the body is read to its end and the entry appears only when it closed
   * without error; a body that errors rejects the `put` and leaves the previous entry in place.
   */
  async put(url: string, response: Response): Promise<void> {
    await this.putGate;
    if (this.failPut) throw this.failPut;
    const body = await response.arrayBuffer();
    // An entry cap, as a browser applies it: the refusal comes once the whole body is written.
    if (this.maxEntryBytes !== undefined && body.byteLength > this.maxEntryBytes) {
      throw Object.assign(new Error("Unexpected internal error."), { name: this.capError });
    }
    this.entries.set(url, new Response(body, { status: response.status, headers: response.headers }));
  }
  async delete(url: string): Promise<boolean> {
    return this.entries.delete(url);
  }
  /** As `Cache.keys(url, { ignoreSearch: true })`: every key that is `url` once its query is dropped. */
  async keys(url: string, options?: { ignoreSearch?: boolean }): Promise<string[]> {
    const bare = (u: string) => (options?.ignoreSearch ? u.split("?")[0] : u);
    return [...this.entries.keys()].filter((k) => bare(k) === bare(url));
  }
}

export class FakeCaches {
  failOpen?: Error;
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    if (this.failOpen) throw this.failOpen;
    let c = this.stores.get(name);
    if (!c) this.stores.set(name, (c = new FakeCache()));
    return c;
  }
  /** Total entries across every named cache. */
  size(): number {
    let n = 0;
    for (const c of this.stores.values()) n += c.entries.size;
    return n;
  }
}
