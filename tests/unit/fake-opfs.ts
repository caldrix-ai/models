// An in-memory stand-in for the browser's private file system (OPFS): the directory and file handle
// calls the store makes, with a file's sync access handle locked while it is open, as the browser does.

export class FakeFile {
  readonly kind = "file" as const;
  data: Uint8Array = new Uint8Array(0);
  locked = false;
  constructor(
    public name: string,
    public parent: FakeDir,
  ) {}

  async getFile(): Promise<File> {
    return new File([this.data.slice()], this.name);
  }

  async createSyncAccessHandle(): Promise<FakeSyncHandle> {
    if (this.locked) throw new DOMException("the file is open elsewhere", "NoModificationAllowedError");
    this.locked = true;
    return new FakeSyncHandle(this);
  }

  async move(a: FakeDir | string, b?: string): Promise<void> {
    const [dir, name] = typeof a === "string" ? [this.parent, a] : [a, b ?? this.name];
    this.parent.children.delete(this.name);
    dir.children.set(name, this);
    this.parent = dir;
    this.name = name;
  }
}

export class FakeSyncHandle {
  closed = false;
  constructor(private f: FakeFile) {}
  write(buf: Uint8Array, opts?: { at?: number }): number {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
    const at = opts?.at ?? 0;
    if (at + buf.length > this.f.data.length) {
      const grown = new Uint8Array(at + buf.length);
      grown.set(this.f.data);
      this.f.data = grown;
    }
    this.f.data.set(buf, at);
    return buf.length;
  }
  read(buf: Uint8Array, opts?: { at?: number }): number {
    const at = opts?.at ?? 0;
    const part = this.f.data.subarray(at, at + buf.length);
    buf.set(part);
    return part.length;
  }
  getSize(): number {
    return this.f.data.length;
  }
  truncate(n: number): void {
    this.f.data = this.f.data.slice(0, n);
  }
  flush(): void {}
  close(): void {
    this.closed = true;
    this.f.locked = false;
  }
}

export class FakeDir {
  readonly kind = "directory" as const;
  readonly children = new Map<string, FakeDir | FakeFile>();
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    const c = this.children.get(name);
    if (c instanceof FakeDir) return c;
    if (c) throw new DOMException(`${name} is a file`, "TypeMismatchError");
    if (!opts?.create) throw new DOMException(`${name} not found`, "NotFoundError");
    const d = new FakeDir(name);
    this.children.set(name, d);
    return d;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    const c = this.children.get(name);
    if (c instanceof FakeFile) return c;
    if (c) throw new DOMException(`${name} is a directory`, "TypeMismatchError");
    if (!opts?.create) throw new DOMException(`${name} not found`, "NotFoundError");
    const f = new FakeFile(name, this);
    this.children.set(name, f);
    return f;
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const c = this.children.get(name);
    if (!c) throw new DOMException(`${name} not found`, "NotFoundError");
    if (c instanceof FakeDir && c.children.size > 0 && !opts?.recursive) {
      throw new DOMException(`${name} is not empty`, "InvalidModificationError");
    }
    this.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, FakeDir | FakeFile]> {
    for (const e of [...this.children.entries()]) yield e;
  }

  /** The tree under this directory as `path → bytes`, for assertions. */
  files(prefix = ""): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const [n, c] of this.children) {
      if (c instanceof FakeFile) out.set(prefix + n, c.data);
      else for (const [p, b] of c.files(`${prefix}${n}/`)) out.set(p, b);
    }
    return out;
  }
}

/** A fresh root, typed as the browser's for the code under test. */
export function fakeRoot(): { fake: FakeDir; root: FileSystemDirectoryHandle } {
  const fake = new FakeDir("");
  return { fake, root: fake as unknown as FileSystemDirectoryHandle };
}
