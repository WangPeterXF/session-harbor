# Management-center commands

Use this reference when the user treats a Codex task as the long-lived SessionHarbor operator window,
asks for status/progress or lists, changes retention settings, or requests a targeted cleanup pilot.

## Start every management turn read-only

Run `dashboard --json --limit 50` before proposing a mutation. Use `--state` to narrow long lists:

- `backed`, `unbacked`, or `changed` for backup state;
- `deleted`, `linked`, or `restored` for local-storage state; and
- `cleanup-ready`, `waiting-inactivity`, or `waiting-backup-age` for retention state.

The dashboard is a fast catalog/local-metadata comparison. Do not call it a fresh hash verification.
Run `verify` before a destructive cleanup or when integrity is the question.

Applied backups update a local operation record. Report its stage and processed/total counts when
present. Treat a running record marked stale as an interrupted run that needs diagnosis, not as active
progress.

## Natural-language routing

- Back up now: `backup plan`; run `backup run --apply` only after the plan is accepted.
- Change retention: `settings set` without `--apply`, show before/after, then apply after confirmation.
- List deleted/restorable sessions: `dashboard --state deleted`; restoration availability is not native
  sidebar reconstruction.
- Cleanup: default to `cleanup --session <exact-id>`. Require a current verified copy, inactivity gate,
  backup-age gate, and open-file check. Delete requires `--apply --confirm-delete-local`.
- Restore: preview the exact selector, apply after confirmation, then verify the restored bytes.
- Scheduling: offer manual, drive-mount, and weekly modes. Show weekday/hour/minute or Windows poll
  interval before installing. Backup and cleanup schedules remain separate.
- Peer context: use `sync status/pull/export` and memory `diff/stage`; never write a peer tree or Codex
  native memory.

Never use `--finalize` to make a real cleanup pilot appear to have waited the configured backup age.
If `cleanupEligibleAt` is in the future, report the exact timestamp and stop.

## Response labels

Label operational results as `planned`, `running`, `verified complete`, or `blocked`. Show counts before
large lists and never expose raw rollout content in routine status.
