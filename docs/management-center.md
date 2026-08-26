# Management-center workflow

SessionHarbor supports a dedicated Codex task that acts as the operator console. The task is a
conversation layer over deterministic CLI commands; it is not a database, daemon, or replacement for
the verified vault.

## Read-only dashboard

```sh
session-harbor dashboard
session-harbor dashboard --json --limit 50
session-harbor dashboard --state backed
session-harbor dashboard --state unbacked
session-harbor dashboard --state changed
session-harbor dashboard --state deleted
session-harbor dashboard --state restored
session-harbor dashboard --state cleanup-ready
session-harbor dashboard --state waiting-backup-age
```

`--limit all` or `--limit 0` returns every matching session. The dashboard compares the local
inventory with catalog metadata so it stays fast. It explicitly does not replace `verify`, which
re-hashes vault objects and local sources.

Applied backups publish progress to the local config state directory. While a backup runs, the
dashboard shows its stage and processed/total counts. A final status is retained as the last
operation; a running record older than six hours is marked stale.

## Settings

Settings changes are dry-run by default:

```sh
session-harbor settings show
session-harbor settings set \
  --cleanup-after-inactive-days 30 \
  --minimum-backup-age-days 7 \
  --reclaim-action keep

session-harbor settings set \
  --cleanup-after-inactive-days 30 \
  --minimum-backup-age-days 7 \
  --reclaim-action delete \
  --apply
```

Changing `reclaimAction` does not delete anything. Cleanup remains a separate command, automatic
cleanup remains disabled unless explicitly enabled, and delete still requires the extra confirmation
token.

## Targeted cleanup and restore

Use a single-session selector for pilots and ordinary conversational operations:

```sh
session-harbor cleanup --session <session-id> --reclaim-action delete --json
session-harbor cleanup --session <session-id> --reclaim-action delete \
  --apply --confirm-delete-local
session-harbor restore <session-id>
session-harbor restore <session-id> --apply
session-harbor verify --json
```

Never use `--finalize` to simulate an elapsed backup-age safety period. If the dashboard reports
`waiting-backup-age`, wait until `cleanupEligibleAt` and rerun the dry-run.

## Scheduling choices

- Manual backup is always available.
- macOS supports drive-mount plus weekly calendar triggers; weekday, hour, and minute are configurable.
- Windows supports a weekly calendar trigger plus configurable drive-presence polling.
- Backup schedules never clean local files by default.
- Cleanup scheduling is a separate opt-in. Delete scheduling additionally requires an explicit delete
  policy and confirmation token, and should not be enabled during a pilot.

## Conversation response contract

For every request, show the current policy and distinguish:

- `planned`: dry-run only;
- `running`: an operation-state record is active;
- `verified complete`: the command finished and required verification passed; or
- `blocked`: a destination, identity, open-file, time, hash, or authorization gate refused the action.

When lists are long, show counts first and offer narrow dashboard filters. Never include prompt text,
tool output, credentials, or raw rollout content in a normal status response.
