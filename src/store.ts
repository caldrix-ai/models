// The store of models made on the device: one directory per model under the origin's private file system
// (OPFS), holding the model's file and `model.json`, its record. A model is written to a hidden partial
// name and committed by moving it onto its file name and then writing the record beside it: a directory
// with no record is never a model (a write in progress, or one a closed tab left; `list` reports the
// latter as uncommitted), and the next `begin` of that name clears it. A name is held under a Web Lock
// from `begin` until its `commit` or `abort` ends, and for a `remove`, so no other tab or worker clears
// or begins it meanwhile. Every record is read back as hostile: capped, type-checked field by field, and
// held to the file it names.

import { ModelsError } from "./errors";

/** Where the browser packages keep models: the Hub's files and the models made on the device. */
export const STORE = {
  /** The Cache Storage name of the Hub's files (what earlier caldrix.js releases wrote). */
  hubCache: "caldrix.js",
  /** The private file system path of the models made on the device, one directory per model. */
  made: "caldrix-ai/models",
} as const;

/** What the store records of a model made on the device. */
export interface MadeRecord {
  /** The model's name: its directory's name. */
  name: string;
  /** The model's file in that directory. */
  file: string;
  /** The file's size in bytes. */
  bytes: number;
  /** The file's SHA-256, 64 lowercase hex digits. */
  sha256: string;
  /** The Hub repo and the revision the model was made from. */
  from: { repo: string; revision: string };
  /** How it was made (a quantization type, say). */
  recipe: string;
  /** What made it. */
  by: string;
}

/** A model being written: write its bytes through `handle`, then `commit` or `abort`. */
export interface MadeWrite {
  readonly name: string;
  readonly file: string;
  readonly handle: SyncHandle;
  commit(record: Omit<MadeRecord, "name" | "file">): Promise<MadeRecord>;
  abort(): Promise<void>;
}

/** The file system calls the store makes: the browser's private file system, or a stand-in. */
export interface SyncHandle {
  write(buf: Uint8Array, opts?: { at?: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}
interface FileH {
  readonly kind: "file";
  getFile(): Promise<File>;
  createSyncAccessHandle(): Promise<SyncHandle>;
  move(name: string): Promise<void>;
}
interface DirH {
  readonly kind: "directory";
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirH>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileH>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, DirH | FileH]>;
}

/** The part of the Web Locks API the store uses (`navigator.locks`). */
interface Locks {
  request<T>(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<T> | T): Promise<T>;
}

/** Locks within this realm alone: for a store over a root the caller gives where the browser has none (tests). */
const held = new Set<string>();
const REALM_LOCKS: Locks = {
  async request(name, _opts, cb) {
    if (held.has(name)) return cb(null);
    held.add(name);
    try {
      return await cb({});
    } finally {
      held.delete(name);
    }
  },
};

/** Takes `name`'s lock if no one holds it: its release, or null when it is held elsewhere. */
function take(locks: Locks, name: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(reject);
  });
}

/** The largest `model.json` the store reads. */
export const RECORD_CAP = 64 * 1024;
const RECORD = "model.json";
const RECORD_PARTIAL = ".model.json.partial";
const STRING_CAP = 1024;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const errName = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : undefined;

function segment(what: string, s: string): void {
  if (!SEGMENT.test(s)) {
    throw new ModelsError(
      "validate",
      `the ${what} ${JSON.stringify(s)} is not one the store keeps: 1 to 128 letters, digits, '.', '_' or '-', not starting with '.'`,
    );
  }
}

/** The models made on this device, in this origin's private file system. */
export class MadeModels {
  private constructor(
    private readonly dir: DirH,
    private readonly locks: Locks,
  ) {}

  /**
   * Opens the store. With no `root`, the browser's private file system: refused by name where the browser
   * lacks it, cannot move a file within it, or has no Web Locks.
   */
  static async open(root?: FileSystemDirectoryHandle): Promise<MadeModels> {
    let dir: DirH;
    const browserLocks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
    let locks: Locks = browserLocks ?? REALM_LOCKS;
    if (root) {
      dir = root as unknown as DirH;
    } else {
      const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator?.storage;
      if (typeof storage?.getDirectory !== "function") {
        throw new ModelsError("backend", "this browser cannot keep made models: it has no private file system (navigator.storage.getDirectory)");
      }
      const handle = (globalThis as { FileSystemFileHandle?: { prototype?: { move?: unknown } } }).FileSystemFileHandle;
      if (typeof handle?.prototype?.move !== "function") {
        throw new ModelsError("backend", "this browser cannot keep made models: it cannot move a file in its private file system (FileSystemFileHandle.move)");
      }
      if (typeof browserLocks?.request !== "function") {
        throw new ModelsError("backend", "this browser cannot keep made models: it has no Web Locks (navigator.locks)");
      }
      locks = browserLocks;
      try {
        dir = (await (storage.getDirectory as () => Promise<unknown>).call(storage)) as DirH;
      } catch (e) {
        throw new ModelsError("backend", `this browser refused its private file system: ${String(e)}`);
      }
    }
    for (const part of STORE.made.split("/")) dir = await dir.getDirectoryHandle(part, { create: true });
    return new MadeModels(dir, locks);
  }

  /**
   * The store to read only (`get`, `list`): with no `root`, the browser's private file system, refused by
   * name where the browser lacks it. It needs neither `FileSystemFileHandle.move` nor Web Locks (without
   * them a name being written in another tab may be listed as uncommitted), and creates nothing: a site
   * that kept no model has none.
   */
  static async reader(root?: FileSystemDirectoryHandle): Promise<Pick<MadeModels, "get" | "list">> {
    const browserLocks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
    const locks: Locks = typeof browserLocks?.request === "function" ? browserLocks : REALM_LOCKS;
    let dir: DirH;
    if (root) {
      dir = root as unknown as DirH;
    } else {
      const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator?.storage;
      if (typeof storage?.getDirectory !== "function") {
        throw new ModelsError("backend", "this browser cannot read made models: it has no private file system (navigator.storage.getDirectory)");
      }
      try {
        dir = (await (storage.getDirectory as () => Promise<unknown>).call(storage)) as DirH;
      } catch (e) {
        throw new ModelsError("backend", `this browser refused its private file system: ${String(e)}`);
      }
    }
    for (const part of STORE.made.split("/")) {
      const next = await dir.getDirectoryHandle(part).catch((e: unknown) => {
        if ((e as { name?: string }).name === "NotFoundError") return null;
        throw e;
      });
      if (next === null) return EMPTY;
      dir = next;
    }
    return new MadeModels(dir, locks);
  }

  /**
   * Starts writing the model `name` as `file`. Refuses a name that is already a model or is being written
   * (here or in another tab); clears what a write that never committed left under that name. Runs in a
   * worker: the bytes are written through a synchronous access handle.
   */
  async begin(name: string, file: string): Promise<MadeWrite> {
    segment("model name", name);
    segment("file name", file);
    if (file === RECORD) throw new ModelsError("validate", `the file name "${RECORD}" is the store's record; name the model's file otherwise`);
    const release = await this.hold(name);
    try {
      return await this.begun(name, file, release);
    } catch (e) {
      release();
      throw e;
    }
  }

  private async begun(name: string, file: string, release: () => void): Promise<MadeWrite> {
    const partial = `.${file}.partial`;
    const old = await this.child(name);
    if (old) {
      if (await has(old, RECORD)) throw new ModelsError("request", `a model named "${name}" is already kept; remove it first`);
      if (await has(old, partial)) {
        const probe = await lock(name, await old.getFileHandle(partial));
        probe.close();
      }
      await this.dir.removeEntry(name, { recursive: true });
    }
    const dir = await this.dir.getDirectoryHandle(name, { create: true });
    const fh = await dir.getFileHandle(partial, { create: true });
    const handle = await lock(name, fh);
    let open = true;
    let done = false;
    const close = (): void => {
      if (open) {
        open = false;
        handle.close();
      }
    };
    // After a commit (or an abort) the write is over: a later abort is a no-op, never a removal.
    const abort = async (): Promise<void> => {
      if (done) return;
      close();
      done = true;
      try {
        await this.dir.removeEntry(name, { recursive: true }).catch(() => undefined);
      } finally {
        release();
      }
    };
    const commit = async (fields: Omit<MadeRecord, "name" | "file">): Promise<MadeRecord> => {
      if (done) throw new ModelsError("request", `the model "${name}" was already committed or aborted`);
      let record: MadeRecord;
      try {
        record = checkRecord(name, { ...fields, name, file });
        handle.flush();
        const size = handle.getSize();
        if (size !== record.bytes) {
          throw new ModelsError("validate", `the model "${name}" has ${size} bytes written but its record says ${record.bytes}`);
        }
      } catch (e) {
        await abort();
        throw e;
      }
      close();
      done = true;
      try {
        await fh.move(file);
        const rp = await dir.getFileHandle(RECORD_PARTIAL, { create: true });
        const rh = await rp.createSyncAccessHandle();
        try {
          rh.write(new TextEncoder().encode(JSON.stringify(record)), { at: 0 });
          rh.flush();
        } finally {
          rh.close();
        }
        await rp.move(RECORD);
      } finally {
        release();
      }
      return record;
    };
    return { name, file, handle, commit, abort };
  }

  /**
   * Every committed model; every directory whose record the store refused, with why; and every name left
   * uncommitted (a write a closed tab or a failed commit left, holding disk until it is removed). A name
   * being written now is in none of them.
   */
  async list(): Promise<{ models: MadeRecord[]; refused: { name: string; why: string }[]; uncommitted: string[] }> {
    const models: MadeRecord[] = [];
    const refused: { name: string; why: string }[] = [];
    const uncommitted: string[] = [];
    for await (const [name, entry] of this.dir.entries()) {
      if (entry.kind !== "directory") continue;
      if (!(await has(entry, RECORD))) {
        const release = SEGMENT.test(name) ? await take(this.locks, lockName(name)) : null;
        if (release) {
          release();
          uncommitted.push(name);
        }
        continue;
      }
      try {
        models.push((await this.get(name)).record);
      } catch (e) {
        refused.push({ name, why: e instanceof Error ? e.message : String(e) });
      }
    }
    models.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    uncommitted.sort();
    return { models, refused, uncommitted };
  }

  /** The committed model `name`: its record, checked, and its file, held to the record's size. */
  async get(name: string): Promise<{ record: MadeRecord; file: File }> {
    segment("model name", name);
    const dir = await this.child(name);
    if (!dir || !(await has(dir, RECORD))) throw new ModelsError("request", `no model named "${name}" is kept`, "not-found");
    const raw = await (await dir.getFileHandle(RECORD)).getFile();
    if (raw.size > RECORD_CAP) {
      throw new ModelsError("validate", `the record of the model "${name}" is ${raw.size} bytes, over the ${RECORD_CAP}-byte cap`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await raw.arrayBuffer()));
    } catch {
      throw new ModelsError("validate", `the record of the model "${name}" is not JSON`);
    }
    const record = checkRecord(name, parsed);
    if (!(await has(dir, record.file))) throw new ModelsError("validate", `the model "${name}" has no file "${record.file}"`);
    const file = await (await dir.getFileHandle(record.file)).getFile();
    if (file.size !== record.bytes) {
      throw new ModelsError("validate", `the model "${name}" has ${file.size} bytes but its record says ${record.bytes}`);
    }
    return { record, file };
  }

  /** Deletes the model `name` (or what an uncommitted write left under it) and everything in its directory. */
  async remove(name: string): Promise<void> {
    segment("model name", name);
    const release = await this.hold(name);
    try {
      if (!(await this.child(name))) throw new ModelsError("request", `no model named "${name}" is kept`, "not-found");
      await this.dir.removeEntry(name, { recursive: true });
    } finally {
      release();
    }
  }

  /** `name`'s lock, or the refusal that another tab or worker is writing it. */
  private async hold(name: string): Promise<() => void> {
    const release = await take(this.locks, lockName(name));
    if (!release) throw new ModelsError("request", `the model "${name}" is being written elsewhere (another tab or worker)`);
    return release;
  }

  private async child(name: string): Promise<DirH | undefined> {
    try {
      return await this.dir.getDirectoryHandle(name);
    } catch (e) {
      if (errName(e) === "NotFoundError") return undefined;
      if (errName(e) === "TypeMismatchError") throw new ModelsError("validate", `"${name}" in the store is a file, not a model`);
      throw e;
    }
  }
}

/** The Web Lock a model's name is held under, within the origin. */
const lockName = (name: string): string => `${STORE.made}/${name}`;

async function has(dir: DirH, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (errName(e) === "NotFoundError" || errName(e) === "TypeMismatchError") return false;
    throw e;
  }
}

async function lock(name: string, fh: FileH): Promise<SyncHandle> {
  try {
    return await fh.createSyncAccessHandle();
  } catch (e) {
    if (errName(e) === "NoModificationAllowedError") {
      throw new ModelsError("request", `the model "${name}" is being written elsewhere (another tab or worker)`);
    }
    throw e;
  }
}

/** Checks a record read from (or about to be written to) the directory `name`, field by field. */
function checkRecord(name: string, v: unknown): MadeRecord {
  const bad = (why: string): ModelsError => new ModelsError("validate", `the record of the model "${name}" ${why}`);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad("is not an object");
  const r = v as Record<string, unknown>;
  const str = (k: string, x: unknown): string => {
    if (typeof x !== "string" || x.length === 0 || x.length > STRING_CAP) throw bad(`has no ${k} of 1 to ${STRING_CAP} characters`);
    return x;
  };
  if (r.name !== name) throw bad(`names ${JSON.stringify(r.name)}, not its directory`);
  const file = str("file", r.file);
  if (!SEGMENT.test(file)) throw bad(`names the file ${JSON.stringify(file)}, which the store does not keep`);
  if (typeof r.bytes !== "number" || !Number.isSafeInteger(r.bytes) || r.bytes < 0) throw bad("has no size that is a whole number of bytes");
  if (typeof r.sha256 !== "string" || !SHA256.test(r.sha256)) throw bad("has no SHA-256 of 64 lowercase hex digits");
  const from = r.from;
  if (typeof from !== "object" || from === null || Array.isArray(from)) throw bad("does not say what it was made from");
  const f = from as Record<string, unknown>;
  return {
    name,
    file,
    bytes: r.bytes,
    sha256: r.sha256,
    from: { repo: str("source repo", f.repo), revision: str("source revision", f.revision) },
    recipe: str("recipe", r.recipe),
    by: str("maker", r.by),
  };
}

/** The reader of a site that kept no model: nothing listed, every name not kept. */
const EMPTY: Pick<MadeModels, "get" | "list"> = {
  list: async () => ({ models: [], refused: [], uncommitted: [] }),
  get: async (name: string) => {
    segment("model name", name);
    throw new ModelsError("request", `no model named "${name}" is kept`, "not-found");
  },
};
