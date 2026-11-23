// The e2e's worker: each scenario drives the store over the browser's own private file system and
// posts back what it saw, or `{ error }` with the refusal's kind and message.
import { MadeModels, ModelsError } from "@caldrix-ai/models";

const PARTS = [new Uint8Array(70_000).fill(1), new Uint8Array(50_000).fill(2), new Uint8Array(30_000).fill(3)];
const BYTES = new Uint8Array(PARTS.reduce((n, p) => n + p.length, 0));
{
  let at = 0;
  for (const p of PARTS) {
    BYTES.set(p, at);
    at += p.length;
  }
}

async function sha256(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const fields = async () => ({
  bytes: BYTES.length,
  sha256: await sha256(BYTES),
  from: { repo: "e2e/tiny", revision: "0".repeat(40) },
  recipe: "Q8_0",
  by: "models.js e2e",
});

async function clear(store: MadeModels, name: string): Promise<void> {
  if ((await store.list()).models.some((m) => m.name === name)) await store.remove(name);
}

const scenarios: Record<string, () => Promise<unknown>> = {
  // begin, write three parts out of order, commit, list, get, a refused second begin, remove.
  async roundtrip() {
    const store = await MadeModels.open();
    await clear(store, "e2e");
    const w = await store.begin("e2e", "model.gguf");
    w.handle.write(PARTS[2]!, { at: 120_000 });
    w.handle.write(PARTS[0]!, { at: 0 });
    w.handle.write(PARTS[1]!, { at: 70_000 });
    const record = await w.commit(await fields());
    const listed = (await store.list()).models.map((m) => m.name);
    const got = await store.get("e2e");
    const same = (await sha256(new Uint8Array(await got.file.arrayBuffer()))) === record.sha256;
    let again = "";
    try {
      await store.begin("e2e", "model.gguf");
    } catch (e) {
      again = e instanceof ModelsError ? e.message : String(e);
    }
    await store.remove("e2e");
    const after = (await store.list()).models.map((m) => m.name);
    return { record, listed, same, size: got.file.size, again, after };
  },
  // begin and write, then hold the write open (the page keeps this worker alive).
  async hold() {
    const store = await MadeModels.open();
    await clear(store, "held");
    const w = await store.begin("held", "model.gguf");
    w.handle.write(BYTES, { at: 0 });
    return { begun: true };
  },
  // a second worker's begin of the name another worker is writing.
  async contend() {
    const store = await MadeModels.open();
    await store.begin("held", "model.gguf");
    return { begun: true };
  },
  // a browser whose file handles cannot move.
  async nomove() {
    delete (FileSystemFileHandle.prototype as unknown as { move?: unknown }).move;
    await MadeModels.open();
    return { opened: true };
  },
};

self.onmessage = async (e: MessageEvent<string>) => {
  try {
    const run = scenarios[e.data];
    if (!run) throw new Error(`no scenario ${e.data}`);
    self.postMessage(await run());
  } catch (err) {
    self.postMessage({ error: err instanceof ModelsError ? `${err.kind}: ${err.message}` : String(err) });
  }
};
