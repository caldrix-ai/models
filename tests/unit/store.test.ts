import { describe, expect, it } from "vitest";
import { ModelsError } from "../../src/errors";
import { MadeModels, STORE, type MadeRecord } from "../../src/store";
import { CACHE_NAME } from "../../src/hub";
import { FakeDir, FakeFile, fakeRoot } from "./fake-opfs";

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const SHA = "a".repeat(64);
const RECORD = { bytes: BYTES.length, sha256: SHA, from: { repo: "Qwen/Qwen3-0.6B", revision: "c".repeat(40) }, recipe: "Q8_0", by: "tunix.js" };

async function refusal(p: Promise<unknown>): Promise<ModelsError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelsError);
    return e as ModelsError;
  }
  throw new Error("expected a refusal");
}

/** Writes BYTES in three parts out of order and commits them as `name`. */
async function made(store: MadeModels, name = "qwen3-q8", record = RECORD): Promise<MadeRecord> {
  const w = await store.begin(name, "model.gguf");
  w.handle.write(BYTES.subarray(6), { at: 6 });
  w.handle.write(BYTES.subarray(0, 3), { at: 0 });
  w.handle.write(BYTES.subarray(3, 6), { at: 3 });
  return w.commit(record);
}

/** The store's directory of made models in the fake tree. */
async function madeDir(fake: FakeDir): Promise<FakeDir> {
  let d = fake;
  for (const part of STORE.made.split("/")) d = await d.getDirectoryHandle(part, { create: true });
  return d;
}

describe("the store's names", () => {
  it("keeps the Hub cache's name and puts made models beside it", () => {
    expect(STORE.hubCache).toBe("caldrix.js");
    expect(CACHE_NAME).toBe(STORE.hubCache);
    expect(STORE.made).toBe("caldrix-ai/models");
  });
});

describe("MadeModels", () => {
  it("a_committed_model_is_listed_and_read_back", async () => {
    const { root } = fakeRoot();
    const store = await MadeModels.open(root);
    const rec = await made(store);
    expect(rec).toEqual({ name: "qwen3-q8", file: "model.gguf", ...RECORD });
    const { models, refused } = await store.list();
    expect(models).toEqual([rec]);
    expect(refused).toEqual([]);
    const got = await store.get("qwen3-q8");
    expect(got.record).toEqual(rec);
    expect(new Uint8Array(await got.file.arrayBuffer())).toEqual(BYTES);
  });

  it("an_uncommitted_model_is_not_listed", async () => {
    const { fake, root } = fakeRoot();
    const store = await MadeModels.open(root);
    const w = await store.begin("half", "model.gguf");
    w.handle.write(BYTES, { at: 0 });
    expect((await store.list()).models).toEqual([]);
    expect((await store.list()).refused).toEqual([]);
    await w.abort();
    expect([...(await madeDir(fake)).files().keys()]).toEqual([]);
    expect((await madeDir(fake)).children.size).toBe(0);
  });

  it("a_commit_whose_size_differs_is_refused", async () => {
    const { root } = fakeRoot();
    const store = await MadeModels.open(root);
    const e = await refusal(made(store, "short", { ...RECORD, bytes: BYTES.length + 1 }));
    expect(e.message).toContain(String(BYTES.length));
    expect(e.message).toContain(String(BYTES.length + 1));
    expect((await store.list()).models).toEqual([]);
  });

  it("a_hostile_record_is_refused_by_name", async () => {
    const { fake, root } = fakeRoot();
    const store = await MadeModels.open(root);
    await made(store, "good");
    const hostile: [string, (r: Record<string, unknown>) => Uint8Array][] = [
      ["huge", () => new Uint8Array(64 * 1024 + 1).fill(0x20)],
      ["bytes-a-string", (r) => json({ ...r, bytes: "9" })],
      ["file-escapes", (r) => json({ ...r, file: "../x" })],
      ["name-elsewhere", (r) => json({ ...r, name: "good" })],
      ["not-json", () => new TextEncoder().encode("{")],
    ];
    for (const [name, body] of hostile) {
      await made(store, name);
      const rec = (await madeDir(fake)).children.get(name) as FakeDir;
      const file = rec.children.get("model.json") as FakeFile;
      const r = JSON.parse(new TextDecoder().decode(file.data)) as Record<string, unknown>;
      file.data = body(r);
    }
    for (const [name] of hostile) {
      const e = await refusal(store.get(name));
      expect(e.message, name).toContain(name);
    }
    const { models, refused } = await store.list();
    expect(models.map((m) => m.name)).toEqual(["good"]);
    expect(refused.map((r) => r.name).sort()).toEqual(hostile.map(([n]) => n).sort());
    for (const r of refused) expect(r.why.length, r.name).toBeGreaterThan(0);
  });

  it("an_unsafe_name_is_refused", async () => {
    const { root } = fakeRoot();
    const store = await MadeModels.open(root);
    for (const bad of ["", ".", "..", "a/b", "a\\b", ".hidden", "x".repeat(129)]) {
      const e = await refusal(store.begin(bad, "model.gguf"));
      expect(e.kind, bad).toBe("validate");
    }
    const e = await refusal(store.begin("ok", "../model.gguf"));
    expect(e.kind).toBe("validate");
  });

  it("a_committed_name_is_not_overwritten", async () => {
    const { root } = fakeRoot();
    const store = await MadeModels.open(root);
    await made(store, "once");
    const e = await refusal(store.begin("once", "model.gguf"));
    expect(e.message).toContain("once");
    expect(new Uint8Array(await (await store.get("once")).file.arrayBuffer())).toEqual(BYTES);
  });

  it("a_name_being_written_is_not_begun_twice", async () => {
    const { root } = fakeRoot();
    const store = await MadeModels.open(root);
    const w = await store.begin("busy", "model.gguf");
    const e = await refusal(store.begin("busy", "model.gguf"));
    expect(e.message).toContain("busy");
    await w.abort();
  });

  it("a_file_left_without_its_record_is_cleared_by_the_next_begin", async () => {
    const { fake, root } = fakeRoot();
    const store = await MadeModels.open(root);
    const dir = await (await madeDir(fake)).getDirectoryHandle("left", { create: true });
    (await dir.getFileHandle("model.gguf", { create: true })).data = new Uint8Array([7]);
    expect((await store.list()).models).toEqual([]);
    await made(store, "left");
    expect(new Uint8Array(await (await store.get("left")).file.arrayBuffer())).toEqual(BYTES);
  });

  it("a_file_named_like_the_record_is_refused", async () => {
    const { root } = fakeRoot();
    const store = await MadeModels.open(root);
    const e = await refusal(store.begin("clash", "model.json"));
    expect(e.kind).toBe("validate");
    expect(e.message).toContain("model.json");
  });

  it("abort_after_commit_keeps_the_model", async () => {
    const { root } = fakeRoot();
    const store = await MadeModels.open(root);
    const w = await store.begin("kept", "model.gguf");
    w.handle.write(BYTES, { at: 0 });
    await w.commit(RECORD);
    await w.abort();
    expect((await store.list()).models.map((m) => m.name)).toEqual(["kept"]);
  });

  it("a_begin_or_remove_during_another_commit_is_refused_and_the_commit_stands", async () => {
    const { root } = fakeRoot();
    const a = await MadeModels.open(root);
    const b = await MadeModels.open(root);
    const w = await a.begin("race", "model.gguf");
    w.handle.write(BYTES, { at: 0 });
    const committing = w.commit(RECORD);
    const begun = await refusal(b.begin("race", "model.gguf"));
    expect(begun.message).toBe('the model "race" is being written elsewhere (another tab or worker)');
    const removed = await refusal(b.remove("race"));
    expect(removed.message).toBe('the model "race" is being written elsewhere (another tab or worker)');
    await committing;
    expect(new Uint8Array(await (await b.get("race")).file.arrayBuffer())).toEqual(BYTES);
    // Once committed, the name is free again: a remove goes through.
    await b.remove("race");
    expect((await b.list()).models).toEqual([]);
  });

  it("uncommitted_leftovers_are_reported_and_a_write_in_progress_is_not", async () => {
    const { fake, root } = fakeRoot();
    const store = await MadeModels.open(root);
    const dir = await (await madeDir(fake)).getDirectoryHandle("left", { create: true });
    (await dir.getFileHandle("model.gguf", { create: true })).data = new Uint8Array([7]);
    const w = await store.begin("writing", "model.gguf");
    const seen = await store.list();
    expect(seen.uncommitted).toEqual(["left"]);
    expect(seen.models).toEqual([]);
    await w.abort();
    await store.remove("left");
    expect((await store.list()).uncommitted).toEqual([]);
  });

  it("remove_deletes_the_model", async () => {
    const { fake, root } = fakeRoot();
    const store = await MadeModels.open(root);
    await made(store, "gone");
    await store.remove("gone");
    expect((await store.list()).models).toEqual([]);
    expect((await madeDir(fake)).children.has("gone")).toBe(false);
    expect((await refusal(store.remove("gone"))).message).toContain("gone");
  });
});

function json(v: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(v));
}

describe("MadeModels.reader", () => {
  it("a_reader_lists_and_gets_what_a_writer_committed", async () => {
    const { root } = fakeRoot();
    await made(await MadeModels.open(root));
    const r = await MadeModels.reader(root);
    expect((await r.list()).models.map((m) => m.name)).toEqual(["qwen3-q8"]);
    const got = await r.get("qwen3-q8");
    expect(got.record).toMatchObject({ name: "qwen3-q8", file: "model.gguf", bytes: BYTES.length });
    expect(new Uint8Array(await got.file.arrayBuffer())).toEqual(BYTES);
  });

  it("a_reader_of_a_site_that_kept_nothing_creates_nothing_and_knows_no_model", async () => {
    const { fake, root } = fakeRoot();
    const r = await MadeModels.reader(root);
    expect(await r.list()).toEqual({ models: [], refused: [], uncommitted: [] });
    const e = await refusal(r.get("qwen3-q8"));
    expect([e.kind, e.message]).toEqual(["request", 'no model named "qwen3-q8" is kept']);
    expect([...fake.children.keys()]).toEqual([]);
  });

  it("a_reader_opens_without_move_or_locks", async () => {
    const { root } = fakeRoot();
    await made(await MadeModels.open(root));
    const nav = { storage: { getDirectory: async () => root } };
    const g = globalThis as { navigator?: unknown; FileSystemFileHandle?: unknown };
    const saved = [g.navigator, g.FileSystemFileHandle];
    Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
    g.FileSystemFileHandle = undefined;
    try {
      const r = await MadeModels.reader();
      expect((await r.get("qwen3-q8")).record.bytes).toBe(BYTES.length);
      await expect(MadeModels.open()).rejects.toThrow("FileSystemFileHandle.move");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: saved[0], configurable: true, writable: true });
      g.FileSystemFileHandle = saved[1];
    }
  });

  it("a_reader_refuses_a_browser_without_a_private_file_system", async () => {
    const g = globalThis as { navigator?: unknown };
    const saved = g.navigator;
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
    try {
      const e = await refusal(MadeModels.reader());
      expect(e.kind).toBe("backend");
      expect(e.message).toContain("navigator.storage.getDirectory");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: saved, configurable: true, writable: true });
    }
  });
});
