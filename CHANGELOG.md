# Changelog

Format after [Keep a Changelog](https://keepachangelog.com/); versions are independent semver, tagged
`models-js-v<version>`.

## 0.1.0 — unreleased

### Added

- The first release: a Hugging Face repo's listing and files fetched at a revision, each file's sha256 checked against
  the Hub's, kept in the browser's Cache Storage (a large file in parts), read whole, by range or as a stream, and served
  from the cache offline.
