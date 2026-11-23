# models.js

`@caldrix-ai/models` fetches model files from Hugging Face in the browser, checks them, and keeps them in the browser's
own storage. It resolves a repo at a revision (a branch, a tag or a commit), fetches its listing and its files, checks
each file's sha256 against the one the Hub publishes, and keeps the bytes in Cache Storage so the next load is served
from the disk, offline too. A large file is kept in parts. A file can be read whole, by byte range, or as a stream.

It does not list, search or recommend models: you name the repo.

It is the model source behind [caldrix.js](https://www.npmjs.com/package/@caldrix-ai/caldrix), which bundles it, and
is published on its own for other browser packages.

## Use

```ts
import { fetchFile, fetchListing } from "@caldrix-ai/models";

const hub = { hubBaseUrl: "https://huggingface.co", offline: false };
const listing = await fetchListing("HuggingFaceTB/SmolLM2-135M-Instruct", "main", hub);
const config = await fetchFile("HuggingFaceTB/SmolLM2-135M-Instruct", "main", "config.json", hub);
```

The listing is returned as the Hub sent it (its bytes, capped): parse it as untrusted input. Every failure is a
`ModelsError` with a `kind` (`fetch`, `digest`, `validate`, `backend` or `request`); a file that is simply absent
(not on the Hub, or not cached while offline) also says so in `missing`.

A large file can be streamed instead of read whole: `streamFile` hands it over a piece at a time, checked against
the sha256 you give it, and keeps it in Cache Storage for the next visit. Pass `cache: false` when you keep what you
make of the bytes yourself (a model quantized from them, say): the file is then read from the network, checked the
same way, and not kept.

## Models made on the device

A model made in the browser (quantized there, say) is kept in the browser's private file system, under
`caldrix-ai/models/<name>/`: its file and `model.json`, a record of its size, its sha256, the repo and revision it was
made from, how it was made and by what. Any package on the same site reads it there by name.

```ts
import { MadeModels } from "@caldrix-ai/models";

const store = await MadeModels.open();
// In a worker: the bytes go through a synchronous file handle, in any order.
const w = await store.begin("smollm2-q8", "model.gguf");
w.handle.write(bytes, { at: 0 });
await w.commit({ bytes: bytes.length, sha256, from: { repo, revision }, recipe: "Q8_0", by: "my-app" });

const { models, refused, uncommitted } = await store.list();
const { record, file } = await store.get("smollm2-q8");
```

A model is listed only once it is committed: a write that was aborted is gone, and one that a closed tab left half
done is not a model. `list` names it in `uncommitted`, since it still holds disk, and `remove` or the next `begin`
of its name clears it. A name already kept is never overwritten (`remove` it first), and a name another tab or worker
is writing (from `begin` until its `commit` or `abort` ends) is refused, by `begin` and `remove` alike. A model's file
cannot be named `model.json`, the record's name. Each record is read back as untrusted input: one that is too large,
malformed, or does not match its file is refused by name, and `list` reports it in `refused` with the reason. Names
are 1 to 128 letters, digits, `.`, `_` or `-`, not starting with `.`.

## Network

The Hugging Face Hub, and only for the repo you name. `hubBaseUrl` names the Hub's origin (another one for a test server
or a mirror); `offline: true` serves from the cache alone. Nothing else is contacted, and nothing is reported anywhere.

## Browsers

It needs a secure context (Cache Storage and `crypto.subtle`). Models made on the device need the private file system
with `FileSystemFileHandle.move`, and Web Locks; `MadeModels.open()` refuses by name a browser without them. It is
tested in Chromium.

## License

Apache-2.0 (`LICENSE`, `NOTICE`).
