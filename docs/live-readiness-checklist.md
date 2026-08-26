# Live external-drive readiness checklist

Status: implementation and synthetic validation complete. Each installation must separately verify
its physical-drive and live-history state before enabling local cleanup.

This checklist is the boundary between developing SessionHarbor and touching real Codex history.

## 1. Independent recovery copy

- Make an independent backup of `~/.codex/sessions`, `~/.codex/archived_sessions`, and the Windows
  equivalents before SessionHarbor's first live write.
- Keep that backup outside the SessionHarbor destination and verify at least one raw JSONL can be
  read.
- Do not use authentication, caches, plugins, or SQLite as the recovery artifact.

## 2. Physical carrier rehearsal

- Confirm the exact mount/root and free space on both computers.
- Use a disposable Codex home with synthetic rollouts on the real drive.
- Initialize the destination and two distinct device IDs.
- Test Mac publish → Windows verify/export, then Windows publish → Mac verify/export.
- Disconnect before object copy, during copy, after manifest, before head, and after head. Each rerun
  must retain the last valid head and finish idempotently.
- Record OS, Node, Codex, filesystem, drive model, and observed durability warnings.

## 3. Restore gate

- Run copy-only mode first.
- Verify every selected object and snapshot.
- Export a peer object and compare its SHA-256.
- Restore one disposable session, confirm the local bytes, continue it, and confirm the continuation
  publishes as a new immutable revision.

## 4. Selected live copy-only pilot

- Run `doctor`, `bridge doctor`, and `backup plan` against the real config.
- Review all-session count/bytes, new/reused objects, destination identity, and warnings.
- Apply `backup run --apply` in `keep` mode. A partial result must be retried before cleanup.
- Verify the vault and restore independently before expanding the batch.

## 5. Local-space reclamation gate

- Set and review `cleanupAfterInactiveDays`; keep `autoReclaim` false during the pilot.
- Wait at least the configured `minimumBackupAgeDays` after the latest backup revision.
- Run `cleanup` without `--apply` and review every candidate.
- During a pilot, use `cleanup --session <exact-id>` so one approved candidate cannot expand into a
  batch operation.
- Prefer `link` only when the external/NAS path is stable and expected to stay mounted.
- Use `delete` only after a second independent restore and a fresh explicit confirmation. Applied
  delete requires `--confirm-delete-local`.
- Run `verify` immediately afterward, restore a deleted pilot, and confirm no local deletion
  propagated into peer heads.
- Do not use `--finalize` to simulate the configured backup-age wait. If no candidate has naturally
  reached `cleanupEligibleAt`, record the gate as blocked and test again later.

## 6. Scheduler gate

- Install backup-only scheduling first. macOS may combine mount and weekly triggers; Windows uses a
  weekly trigger plus configurable drive-presence polling.
- Confirm a missing drive yields `backup-skipped` and never creates the mount path.
- Confirm reinsertion produces an idempotent incremental backup.
- Run a separate full `verify` after unsafe removal/filesystem warnings and before enabling cleanup;
  fast insertion backup is not a substitute for a cryptographic scrub.
- Do not install scheduled cleanup until the exact inactivity threshold is approved. Scheduled
  delete additionally requires a fresh `--confirm-delete-local` decision.

## Stop conditions

Stop without repairing or retrying automatically on any destination identity mismatch, missing
marker, open/changed source, target conflict, hash mismatch, symlink path, unsupported contract,
rollback warning, unavailable peer object, or failed restore.
