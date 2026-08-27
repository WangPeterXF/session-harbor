# Changelog

## Unreleased

## 0.3.1 - 2026-08-27

- Included `AGENTS.md`, plugin discovery evals, privacy, support, and terms files in immutable
  Windows handoff source snapshots, with regression coverage for every required path.
- Normalized rollout timestamps to integer milliseconds so NTFS/exFAT timestamp precision drift no
  longer leaves byte-identical sessions permanently pending.
- Added stable-stat guards around existing-source hashing and revision copying, including rejection
  when bytes change after a content-addressed revision path is planned.
- Refreshed catalog metadata after a verified byte-identical backup and covered the Windows
  timestamp round-trip with a synthetic regression test.
- Added agent-oriented repository metadata, generated `llms.txt`/`llms-full.txt`, discovery prompt
  evals, a lightweight GitHub Pages site, and cross-platform CI on Node.js 20 and 22.
- Added structured issue forms, public privacy/terms/support pages, plugin listing metadata, and a
  social preview centered on backup, verified cleanup, restore, and reviewed cross-device context.


## 0.3.0 - 2026-08-26

- Changed the project license before first public publication from MIT to
  `PolyForm-Noncommercial-1.0.0`; SessionHarbor is now source-available for noncommercial use, with
  commercial use requiring a separate written license.
- Added a commercial-licensing notice and temporarily closed code/documentation contributions until
  a contributor agreement preserves ownership and relicensing options.
- Added a read-only conversational management dashboard with state filters for current, pending,
  changed, deleted, linked, restored, cleanup-ready, and retention-waiting sessions.
- Added applied-backup progress records, dry-run/apply settings management, and single-session cleanup
  selection for controlled deletion/restore pilots.
- Added Chinese and English one-paste Codex bootstrap prompts plus a checksummed Windows development
  handoff and write-back protocol.
- Changed backup to cover every local Codex rollout on every run, independent of age and size.
- Added incremental revision backup for sessions that continue growing after an earlier backup.
- Added config v4 with `backup.scope=all`, `cleanupAfterInactiveDays`, and
  `minimumBackupAgeDays`; v1-v3 configs migrate compatibly.
- Added `backup plan|run` for manual disaster-recovery backups and `cleanup` as the clearer alias for
  verified local reclamation.
- Made cleanup require both inactivity eligibility and a current SHA-256 verified vault copy. Local
  delete still requires `--apply --confirm-delete-local` and remains restorable.
- Changed default reclaim action to `keep`; automatic local cleanup remains disabled by default.
- Added combined macOS mount/weekly scheduling and Windows weekly plus configurable insertion
  polling. Missing configured drives are safe no-op backup triggers.
- Made normal scheduled reruns metadata-incremental instead of re-hashing the full historical corpus;
  explicit `verify` and all cleanup mutations still perform full SHA-256 checks.
- Allowed a snapshot to publish the latest verified catalog state when one live session continues
  changing, reporting the run as partial and retrying that session on the next trigger.
- Added synthetic coverage for recent/tiny sessions, incremental revisions, selective local delete,
  and restore after cleanup.
- Fixed direct Node entrypoint detection on native Windows paths for the CLI, schedulers, contract
  validator, and removable-drive handoff builder.
- Fixed scheduled `--if-available` backup so a detached destination exits successfully as an
  explicit no-op instead of failing before the availability check.
- Scoped shared-catalog backup lookup, snapshot publication, verification, dashboard, cleanup, and
  restore selection to the local device's object tree.
- Made unprivileged Windows file-link reclamation fail with
  `WINDOWS_SYMLINK_PRIVILEGE_REQUIRED` while leaving the local source unchanged.
- Persisted Windows Task Scheduler XML with a UTF-16LE byte-order mark matching its declaration.
- Passed 88 tests on Windows and macOS after physical exFAT-vault backup, peer-read, scheduler, and
  synthetic restore validation. Windows real-session deletion remains untested and disabled by
  default.

## 0.2.0 - Unreleased

- Added config v3 with explicit `archiveAfterDays`, `localGraceDays`, `reclaimAction`, and
  `autoReclaim`; v1/v2 settings migrate compatibly.
- Separated verified archive publication from local reclamation. Normal archive/scheduled copy no
  longer links or deletes automatically; delete reclamation requires `--confirm-delete-local`.
- Added device-owned content-addressed session objects, immutable snapshots, head-last publication,
  stable native ID extraction, revision retention, idempotency, and interruption recovery.
- Added verified peer discovery/status/pull, rollback warnings, offline metadata/raw-object cache,
  and explicit session export without Codex database changes.
- Added portable project mapping and reviewed memory draft/approve/diff/stage/status with exact
  session evidence and restricted-entry gates.
- Added read-only CodexBridge and SessionHarbor v0.1 migrations with repeatable verified imports and
  no source cleanup.
- Added explicitly scoped policy runs plus macOS LaunchAgent and Windows Task Scheduler rendering.
- Added stable-mounted versus client-synced storage safety, Windows private-path support, Unicode and
  long-path fixtures, and Windows to the GitHub Actions matrix.
- Added a physical-drive/live-history checklist; no live session move has been executed.

- Established the independent project name `SessionHarbor` and personal authorship by Xiaofan Wang.
- Added a Codex plugin and repo-local marketplace.
- Added read-only storage diagnostics and candidate scanning.
- Added two-phase, SHA-256 verified cross-volume archiving.
- Added destination identity markers to stop on missing or substituted mounts.
- Added rejection of symlinked destination components to prevent filesystem path redirection.
- Added reversible linked storage, verification, and restore.
- Added immutable revision retention when a restored task is continued and later archived again.
- Added optional `codex-slim` compression orchestration.
- Added opt-in macOS LaunchAgent scheduling.
- Added synthetic tests, a threat model, and public contribution guidance.
- Froze the v2 three-layer architecture for session evidence, device exchange, and reviewed recall.
- Added contract v1 JSON Schema, a zero-dependency semantic validator, and synthetic examples for
  device manifests, head pointers, session snapshots, memory snapshots, and run records.
- Added fail-closed tests for absolute/traversal paths, peer-tree ownership, hash format, evidence,
  unknown fields, and unknown contract versions.
- Added an implementation roadmap with migration, cross-platform, interruption, and release gates.
- Implemented M1 stable device identity and immutable vault protocol bootstrap.
- Added `device init`, `device show`, and `bridge doctor`, with dry-run defaults, device conflict
  refusal, filesystem durability warnings, resumable interruption handling, and immutable run records.
- Added config migration and fixed `--version` to match the positional command.
