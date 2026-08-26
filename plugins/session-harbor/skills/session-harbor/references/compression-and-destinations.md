# Compression and destinations

## Optional compression

`compression: "codex-slim"` enables the `compress` command. The command invokes the separately installed MIT-licensed `@milisp/codex-slim` binary without its `--move-to` option. SessionHarbor performs cross-volume transfer itself so it can copy to a temporary destination file, sync it, compare SHA-256 hashes, and fail closed if the source changes.

Before `compress --apply`, ensure `doctor` reports `codex-slim` and `lsof` as available. The command checks eligible files for open handles and aborts the whole compression batch if any candidate is active. A dry-run is still required first.

Codex's `.jsonl.zst` support is an internal implementation detail and can change. Verify compatibility against a synthetic Codex home after Codex upgrades before applying compression to real history.

## Destination selection

- External SSD/HDD: use `exchange.storageClass: "stable-mounted"`. Choose reclaim action `link`
  only when the volume name and mount point are stable; Codex cannot resume a linked session while
  the drive is disconnected.
- NAS/SMB mount: use `stable-mounted` plus `link` only on a reliable mount with local-user
  permissions and acceptable latency. Keep a second backup for important sessions.
- iCloud Drive or Baidu Netdisk sync folder: use `exchange.storageClass: "client-synced"` and
  reclaim action `keep`. SessionHarbor rejects link/delete for this class because clients can evict,
  replace, or delay local files.
- WebDAV: mount it through a trusted filesystem client or use a separate sync tool. This release does not store WebDAV credentials or implement a remote API.

The archive catalog contains portable paths, session IDs, sizes, timestamps, and SHA-256 hashes. It does not contain chat text, but raw archived rollout files remain sensitive and are not safe to publish.
