---
name: session-harbor
description: "Operate a dedicated Codex session-management task: show backup progress and inventories, configure retention, safely back up or clean verified local Codex sessions, restore sessions, exchange cross-device evidence, or migrate legacy archives. Do not use for ordinary project-file backups or ChatGPT web conversations."
---

# SessionHarbor

Use the bundled CLI for deterministic filesystem work. Resolve it relative to this file as
`../../scripts/session-harbor.mjs`.

## Dedicated management task

When the user asks to use this Codex task as a SessionHarbor control window, begin each operational
turn with the read-only `dashboard --json --limit 50`. Summarize backup state, local deletion state,
retention waits, policy, last publication, and current operation progress before proposing changes.
Use filters instead of dumping raw rollout content.

Read [management-center.md](references/management-center.md) for status filters, natural-language
routing, settings changes, targeted cleanup, scheduling choices, and response labels.

## Non-negotiable safety boundary

- Start with read-only `doctor`, `bridge doctor`, `backup plan`, `cleanup`, `sync plan`, or status commands.
- Treat destination initialization, device initialization, archive publication, local reclamation,
  restore, peer caching, memory approval/staging, migration, compression, and scheduler installation
  as separate mutations.
- Never infer approval for a real session or external-drive mutation from approval to develop or test
  the plugin. Synthetic tests do not authorize live use.
- Never use `--skip-open-check` on real data.
- Stop on a missing or mismatched destination marker, changed/open source, target conflict, hash
  mismatch, symlinked path component, unsupported protocol, peer rollback, or unknown contract.
- Never write Codex SQLite, `session_index.jsonl`, generated memory, authentication, caches, plugin
  runtimes, or project trees.

## Backup and cleanup semantics

Config v4 separates disaster recovery from local-space cleanup:

- `backup.scope` is `all`: every stable rollout in `sessions` and `archived_sessions` is considered,
  regardless of age or size. Changed rollouts publish a new immutable revision.
- `backup.allowPartial` permits other stable sessions to finish when a currently changing session
  fails its stable-read check; the result must be reported as partial and retried later.
- `backup.verifyExistingObjects=false` keeps insertion/weekly runs incremental by trusting unchanged
  source metadata plus stored object size and hashing new/changed bytes. `verify` remains the full
  cryptographic scrub and cleanup always re-hashes source and target before local mutation.
- `retention.cleanupAfterInactiveDays`: inactivity before a verified local copy becomes eligible for
  cleanup.
- `retention.minimumBackupAgeDays`: safety hold after the latest verified backup revision.

`backup` only copies, verifies, and publishes the device snapshot; it never reclaims local files.
`cleanup` (alias `reclaim`) is separate and re-verifies both source and destination:

- `keep`: retain the local original indefinitely.
- `link`: replace it with a reversible link to a stable mounted destination.
- `delete`: remove only the verified local original; requires both `--apply` and
  `--confirm-delete-local`, and remains restorable from the verified object.

Use `exchange.storageClass: "stable-mounted"` for an external drive or mounted NAS. A client-managed
iCloud/Baidu/Synology folder must use `"client-synced"` with reclaim action `keep`.

## First-use workflow

1. Preview `init --destination <path>`, then request approval before `init ... --apply`.
2. Preview `device init`; request separate approval before `device init --apply`.
3. Run `doctor --json`, `bridge doctor --json`, `backup plan --json`, and `cleanup --json`.
4. Report full-backup count/bytes, new/reused objects, any partial inventory errors, cleanup inactivity,
   minimum backup age, reclaim action, destination identity,
   broken links, and every warning/error.
5. After explicit approval, use `backup run --apply` to create verified copies and a device snapshot.
   Do not run cleanup in the first live run.
6. Run `verify --json`, `sync status --json`, and a dry-run restore/export test.
7. Only after an independently verified restore and a later explicit request, preview `cleanup`.
   For delete mode, request confirmation immediately before using
   `cleanup --session <exact-id> --apply --confirm-delete-local` for the pilot.

`--finalize` is a compatibility override that can bypass the grace period. Treat it as higher risk
and never use it in a scheduler.

## Cross-device and reviewed memory

- `sync push` publishes objects, then an immutable manifest, then its hash-bound head.
- `sync pull` caches verified peer metadata; `--include-objects --apply` additionally permits offline
  peer export. A device writes only under its own vault subtree.
- `sync export` materializes a verified peer session without editing Codex databases.
- `memory draft` stays private. `memory approve` is the only peer-visible publication and requires
  evidence matching a verified session object. Restricted entries require `--include-restricted`.
- `memory stage` writes only SessionHarbor's private local context cache. `staged` is not `adopted`
  and is never described as native Codex memory.

Read [bridge-and-memory.md](references/bridge-and-memory.md) for the detailed exchange workflow.
For compression or destination selection, read
[compression-and-destinations.md](references/compression-and-destinations.md).

## Migration and scheduling

`migrate codexbridge|v01 plan` is read-only. Applied migration creates new verified objects and never
deletes or rewrites the legacy source. macOS scheduling uses `../../scripts/launchagent.mjs`; Windows
uses `../../scripts/windows-task.mjs`. Installation is dry-run unless `--apply` is supplied. The
default schedule combines drive-presence and weekly all-session backup while leaving cleanup off.
macOS uses `StartOnMount`; Windows uses configurable drive-presence polling plus a weekly trigger.
Use `--no-on-mount` or `--no-weekly` to select one. Manual `backup run --apply` is always supported.
A scheduler includes cleanup only when explicitly encoded, and delete scheduling also requires
`--confirm-delete-local`.
