# Changelog

Format after [Keep a Changelog](https://keepachangelog.com/); versions are independent semver, tagged
`models-js-v<version>`.

## 0.2.0 — 2026-11-24

### Added

- `streamFile`'s `cache: false`: a file streamed from the network and checked, but not kept in Cache Storage (a
  copy already there is not read) nor in the browser's HTTP cache (its request is `no-store`).
- `MadeModels.reader()`: the store to read only (`get`, `list`), with no file moves or Web Locks needed, creating
  nothing.
- `blobRange` and `streamBlob`: a kept file read as a Hub file is, a span or the whole of it in pieces, held to its
  record's size and sha256.

## 0.1.0 — 2026-11-23

### Added

- The first release: a Hugging Face repo's listing and files fetched at a revision, each file's sha256 checked against
  the Hub's, kept in the browser's Cache Storage (a large file in parts), read whole, by range or as a stream, and served
  from the cache offline.
- `MadeModels`: models made on the device, kept in the browser's private file system by name with a record of what each
  was made from, how and by what, written from a worker under a Web Lock and read by any package on the same site.
