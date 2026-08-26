# Cross-device sessions and reviewed memory

Use this reference when two owned computers need verified continuity through the same SessionHarbor
vault.

## Session exchange

1. Initialize a distinct stable device ID on each computer.
2. Run `sync plan --json`; applied `sync push` publishes only to that device's subtree.
3. On the peer, run `sync status --json`, then preview and apply `sync pull`.
4. Add `--include-objects` only when offline raw-session export is required.
5. Use `sync export <peer> <session> --output <path>` before its applied form. Export does not rebuild
   the Codex sidebar or modify SQLite/index state.

The head is committed last. A missing/corrupt object, manifest hash mismatch, peer rollback, or
unsupported contract leaves the last verified local peer view intact and visibly stale.

Local deletion never propagates into a peer head. Reclaimed objects remain in immutable snapshots.

## Reviewed memory

Prepare a JSON draft whose entries contain `key`, `text`, `sensitivity`, and one or more evidence
records with `sessionId`, exact `sha256`, and `locator`.

1. `memory draft --project <id> --input <json>` validates evidence and stays dry-run.
2. Apply the draft to SessionHarbor's private local state.
3. Preview `memory approve <draft> --project <id>`; applied approval publishes a new immutable,
   reviewed snapshot and head.
4. On the peer, use `memory diff`, then preview/apply `memory stage`.
5. `memory status` displays staged entries and provenance even when the vault is disconnected.

Drafts cannot become peer-visible. Restricted entries require explicit inclusion for approval and
again for staging. Staging never edits Codex generated memory, `AGENTS.md`, or project files. Any
durable adoption remains a normal, separately authorized project-file change.

## Ownership and privacy

- A device writes only `devices/<its-device-id>/...`.
- Absolute Mac/Windows paths stay in private config.
- Raw rollouts may contain secrets and personal data; SessionHarbor provides integrity, not
  encryption.
- Never copy authentication, provider credentials, arbitrary project files, caches, or plugin state.
