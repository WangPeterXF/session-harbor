# SessionHarbor

[![CI](https://github.com/WangPeterXF/session-harbor/actions/workflows/ci.yml/badge.svg)](https://github.com/WangPeterXF/session-harbor/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/WangPeterXF/session-harbor?include_prereleases)](https://github.com/WangPeterXF/session-harbor/releases)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853d)](package.json)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-2563eb)](LICENSE)
[![No telemetry](https://img.shields.io/badge/telemetry-none-0f766e)](PRIVACY.md)

![SessionHarbor connects multiple Codex devices to one verified data hub](docs/assets/sessionharbor-github-social-preview-v0.3.0.jpg)

**Back up, verify, reclaim, restore, and review Codex session context across macOS and Windows.**

SessionHarbor is an unofficial, local-first Codex plugin and zero-dependency Node.js CLI by Xiaofan
Wang. It turns an external drive or mounted NAS into a verified filesystem vault for every stable
local Codex rollout.

| Outcome | What SessionHarbor does |
| --- | --- |
| Back up every Codex session | Incremental, content-addressed backup with SHA-256 read-back and immutable device-owned snapshots. |
| Free local disk space safely | Keeps backup and cleanup separate; old originals become eligible only after inactivity, backup-age, open-file, and fresh verification gates. |
| Restore deleted local conversations | Materializes the verified raw rollout without consuming the vault copy. |
| Bridge multiple Codex computers | Lets macOS and Windows devices inspect verified peer inventories and stage reviewed, evidence-linked context. |

## Install with one Codex prompt

Open a new Codex task and paste the complete pinned prompt for
[English](docs/bootstrap-prompt.en.md) or [简体中文](docs/bootstrap-prompt.zh-CN.md). A compact version is:

```text
Set up SessionHarbor from https://github.com/WangPeterXF/session-harbor using the pinned v0.3.0
bootstrap prompt. Verify the owner, tag, license, and plugin before installing. Make this task my
SessionHarbor management center, start with the read-only dashboard, and do not mutate any real
session or drive without a separate explicit approval.
```

The setup verifies `WangPeterXF/session-harbor` and the pinned release before installing the
repo-local marketplace plugin. Installation, destination initialization, backup publication, local
cleanup, restore, and scheduling remain separate decisions.

## For agents and AI tools

- [`AGENTS.md`](AGENTS.md): repository-wide safety invariants, source map, validation, and review rules.
- [`docs/agent-index.md`](docs/agent-index.md): compact task router for installation, operation, and development.
- [`llms.txt`](https://wangpeterxf.github.io/session-harbor/llms.txt): small web index pointing to authoritative Markdown sources.
- [`llms-full.txt`](https://wangpeterxf.github.io/session-harbor/llms-full.txt): generated combined context, checked for drift in CI.
- [`evals/plugin-discovery.json`](evals/plugin-discovery.json): five positive and three negative prompts for discovery precision and recall.

Project page: <https://wangpeterxf.github.io/session-harbor/>

SessionHarbor is source-available for noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use requires a separate written license;
see [commercial licensing](COMMERCIAL-LICENSE.md). Because the license restricts commercial use,
SessionHarbor is not Open Source Initiative (OSI) open-source software.

## Status

Version `0.3.0` implements full incremental backup, verified local cleanup, restore, cross-device
continuity, a conversational management dashboard, and multi-mode scheduling. Automated validation uses synthetic Codex homes, temporary
vaults, simulated interruptions, and Mac/Windows path fixtures. Each installation must still pass the
physical-drive checklist before local cleanup is enabled.

SessionHarbor never edits Codex SQLite, `session_index.jsonl`, generated memories, authentication, or
project files. It does not promise exact sidebar reconstruction. Raw JSONL remains the restore and
evidence source.

The initial cross-platform validation record, Windows defects found during physical-drive testing,
and remaining preview limitations are summarized in the
[v0.3.0 release notes](docs/release-notes-v0.3.0.md).

## Management task behavior

The repository includes copy-ready bootstrap prompts for
[Chinese](docs/bootstrap-prompt.zh-CN.md) and [English](docs/bootstrap-prompt.en.md), pinned to the
official `WangPeterXF/session-harbor` `v0.3.0` release. The prompt asks Codex to verify the pinned
repository and license, add the repository marketplace, install the plugin, read the verified skill
for the current chat, and turn that task into the user's long-lived SessionHarbor management center.

Official Codex behavior makes newly installed plugin skills available to new chats. The bootstrap
prompt does not pretend the plugin hot-loaded: it explicitly reads the verified skill in the setup
chat so that chat can continue immediately, while later chats use the normal installed plugin.

The management task starts read-only:

```sh
session-harbor dashboard --json --limit 50
session-harbor dashboard --state unbacked
session-harbor dashboard --state deleted
session-harbor dashboard --state waiting-backup-age
```

It reports cataloged/current/pending backups, local deletions, restorable sessions, retention waits,
latest publication, and applied-backup progress. See the
[management-center workflow](docs/management-center.md).

## Backup and cleanup are independent

The settings the project exposes are deliberately separate:

```json
{
  "backup": {
    "scope": "all",
    "allowPartial": true,
    "verifyExistingObjects": false
  },
  "retention": {
    "cleanupAfterInactiveDays": 30,
    "minimumBackupAgeDays": 7,
    "reclaimAction": "keep",
    "autoReclaim": false
  }
}
```

- `backup.scope`: always `all`; backup age and file size never filter disaster-recovery coverage.
- `backup.allowPartial`: a changing/open session is reported and retried on the next trigger while
  other stable sessions can still be backed up.
- `backup.verifyExistingObjects`: `false` makes insertion/weekly runs compare stable source metadata
  and stored object sizes, then hash only new or changed content. Set it to `true` for a deliberately
  slower full scrub; `verify` and restore always perform cryptographic verification.
- `cleanupAfterInactiveDays`: only local sessions inactive for this many days enter cleanup review.
- `minimumBackupAgeDays`: keep the local original for this additional safety period after its latest
  verified backup revision.
- `reclaimAction`:
  - `keep` keeps the local original indefinitely;
  - `link` replaces it with a reversible link to a stable mounted vault;
  - `delete` removes only the verified local original and remains restorable from the vault.
- `autoReclaim`: lets an explicitly installed schedule include a separate reclaim scope. It is off
  by default.

`backup` never deletes or links a local file. `cleanup`/`reclaim` is a different command. Delete mode
requires both `--apply` and `--confirm-delete-local`; `autoReclaim` defaults to false.

Legacy config v1-v3 age/grace keys migrate into config v4. Existing reclaim actions are preserved;
new configs default to `keep`.

## Safety model

Publication follows this order:

1. Verify the destination identity marker and stable device identity.
2. Read a stable local source and compute SHA-256.
3. Copy to a same-directory temporary file, sync it, hash the stored bytes, and publish atomically.
4. Publish an immutable snapshot manifest.
5. Replace the device-owned head pointer last.

Cleanup is allowed only when the destination copy still matches the current local source, the
inactivity and backup-age gates have elapsed, and the source is not open. A missing/mismatched volume, changed source,
target conflict, corrupt object, symlinked path component, peer rollback, or unknown contract fails
closed. Restore keeps the archive copy.

Fast scheduled backup does not replace periodic integrity verification. Run `session-harbor verify`
manually after unsafe removal, filesystem errors, or before enabling cleanup; cleanup itself always
re-hashes both local source and vault target before changing the local file.

## Requirements

- Node.js 20 or newer
- A stable filesystem destination such as an exFAT external drive or mounted NAS
- macOS or Windows for the intended two-computer workflow
- Optional: [`codex-slim`](https://github.com/milisp/codex-slim) for lossless zstd compression

Use `exchange.storageClass: "stable-mounted"` for an external drive/NAS. iCloud, Baidu Netdisk, or
another client-managed synchronized folder must use `"client-synced"` together with reclaim action
`keep`; SessionHarbor rejects link/delete reclamation for that class.

## Dry-run setup

Every command below is read-only until its applied form is explicitly used:

```sh
node plugins/session-harbor/scripts/session-harbor.mjs \
  init --destination /path/to/EXTERNAL_DRIVE/SessionHarbor

node plugins/session-harbor/scripts/session-harbor.mjs doctor --json
node plugins/session-harbor/scripts/session-harbor.mjs device init --json
node plugins/session-harbor/scripts/session-harbor.mjs bridge doctor --json
node plugins/session-harbor/scripts/session-harbor.mjs backup plan --json
node plugins/session-harbor/scripts/session-harbor.mjs cleanup --json
```

Applied destination/device initialization, first session publication, and first local reclamation
are three separate approvals. See [the live-readiness checklist](docs/live-readiness-checklist.md)
before using a physical drive.

## Backup, cleanup, and restore

After reviewing the dry-run and granting the corresponding scope:

```sh
# Preview and then incrementally back up every stable local session.
session-harbor backup plan
session-harbor backup run --apply

# Preview local reclamation after the configured grace.
session-harbor cleanup --json

# Prefer exactly one target for cleanup pilots.
session-harbor cleanup --session <session-id> --reclaim-action delete --json

# Link mode.
session-harbor cleanup --apply

# Delete mode requires the extra confirmation token.
session-harbor cleanup --apply --confirm-delete-local

session-harbor verify --json
session-harbor restore <session-id>          # dry-run
session-harbor restore <session-id> --apply
```

Retention settings can be reviewed and changed independently. `settings set` is a dry-run unless
`--apply` is added:

```sh
session-harbor settings show
session-harbor settings set --cleanup-after-inactive-days 30 \
  --minimum-backup-age-days 7 --reclaim-action keep
```

`archive`, `reclaim`, and `policy` remain compatibility/advanced commands. `--finalize` is retained
as a high-risk compatibility override that can bypass the backup-age gate. It
is not emitted by either scheduler.

## Cross-device sessions

Each device writes only `devices/<its-device-id>/...`; no shared database or peer-tree writes are
used.

```sh
session-harbor sync status --json
session-harbor sync pull --peer <device-id> --json
session-harbor sync pull --peer <device-id> --include-objects --apply
session-harbor sync export <device-id> <session-id> --output <path>
session-harbor sync export <device-id> <session-id> --output <path> --apply
```

Metadata caching supports an explicitly stale offline view. Raw object caching is opt-in. Peer export
materializes a verified JSONL copy but does not mutate Codex indexes or reconstruct its sidebar.

Local reclamation never propagates as a cross-device deletion; immutable evidence remains referenced.

## Reviewed shared context

Map different local paths to the same portable project ID:

```sh
session-harbor project map session-harbor /local/project/path
session-harbor project map session-harbor /local/project/path --apply
```

Then use the reviewed-memory workflow:

```sh
session-harbor memory draft --project session-harbor --input draft.json
session-harbor memory draft --project session-harbor --input draft.json --apply
session-harbor memory approve <draft-id> --project session-harbor
session-harbor memory approve <draft-id> --project session-harbor --apply

session-harbor memory diff --peer <device-id> --project session-harbor
session-harbor memory stage --peer <device-id> --project session-harbor
session-harbor memory stage --peer <device-id> --project session-harbor --apply
session-harbor memory status --project session-harbor
```

Every entry needs a verified session ID, exact session SHA-256, and locator. Drafts remain private;
only approved snapshots become peer-visible. Restricted entries require explicit inclusion at
approval and staging. `staged` is SessionHarbor context, not native Codex memory and not an adopted
project instruction.

## Read-only legacy migration

```sh
session-harbor migrate codexbridge plan --source /path/to/old/CodexBridge
session-harbor migrate v01 plan --source /path/to/old/SessionHarbor
```

The applied forms create new verified objects and snapshots without changing the old payload or
catalog. No migration cleanup command exists.

## Windows development handoff

The [Windows handoff protocol](docs/windows-handoff.md) keeps each device in its own immutable writer
tree and defines a write-back result format. The Mac prepares a checksummed source snapshot under a
separate `SessionHarbor-Handoff` directory on the removable drive; Windows copies it to a local NTFS
development directory, tests there, then writes only its own result file back to the handoff folder.

## Scheduling

macOS:

```sh
node plugins/session-harbor/scripts/launchagent.mjs install \
  --config ~/.config/session-harbor/config.json --apply
```

Windows:

```powershell
node plugins/session-harbor/scripts/windows-task.mjs render `
  --config "$HOME\.config\session-harbor\config.json"
```

Install/uninstall remains dry-run without `--apply`. By default, macOS combines true filesystem-mount
and weekly triggers; Windows combines weekly execution with a configurable 15-minute drive-presence
poll because Task Scheduler has no portable volume-arrival trigger. The command is idempotent and a
missing configured drive is a safe no-op. Use `--no-on-mount` or `--no-weekly` to select one mode;
manual `backup run --apply` is always available. Generated backup schedules never clean local files.
A cleanup schedule must be explicitly requested, and delete scheduling additionally requires
`--confirm-delete-local`.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run --json
```

The contract schema is in
[`schemas/session-harbor-contracts-v1.schema.json`](schemas/session-harbor-contracts-v1.schema.json),
with semantic checks in `bridge-contracts.mjs`. The design, threat model, milestone evidence, and
release gates are under `docs/`.

## Privacy and limitations

Raw rollouts can contain prompts, code, paths, tool output, images, credentials, and personal data.
SHA-256 detects corruption but does not encrypt the drive or authenticate another writer. Use
encrypted storage where loss of an unencrypted drive would be unacceptable.

SessionHarbor is not affiliated with or endorsed by OpenAI. See [LICENSE](LICENSE),
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md), [PRIVACY.md](PRIVACY.md), [TERMS.md](TERMS.md),
[SUPPORT.md](SUPPORT.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[THIRD_PARTY.md](THIRD_PARTY.md).
