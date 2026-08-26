# Upstream reuse plan

## codex-slim

Use it as an optional compressor without `--move-to`. Before proposing upstream changes, reproduce cross-filesystem behavior in an isolated pair of volumes. Candidate upstream improvements:

- Cross-filesystem copy instead of relying only on `rename`
- Destination read-back verification before removing the local compressed file
- Retry relocation for an already compressed local file
- Explicit active-writer protection
- Automated tests for interrupted relocation and disconnected destinations

## codex-project-chat-exporter

Do not copy its implementation. Consider an upstream request for a reusable package/API because its current package is private. If exposed, add an optional adapter for Markdown/HTML and its archive manifest rather than implementing another transcript renderer.

## codex-session-sync

Do not embed WebDAV credentials or duplicate its bidirectional sync engine. Document it as an optional secondary-copy workflow and consider a stable CLI/REST integration only if users need direct WebDAV support.

## Licensing

The three projects above are MIT-licensed at the time of the initial review. No source code from them is vendored in this repository. Re-check licenses and record exact versions before adding any dependency.
