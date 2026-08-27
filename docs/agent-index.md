# SessionHarbor agent index

> Machine-oriented routing index for the unofficial, local-first SessionHarbor Codex plugin and CLI.

## Identity

- Repository: <https://github.com/WangPeterXF/session-harbor>
- Current public preview: `v0.3.0`
- Runtime: Node.js 20 or newer; zero production dependencies
- Platforms: macOS and Windows; Linux is used only for synthetic CI coverage
- License: PolyForm Noncommercial 1.0.0; source-available for noncommercial use, not OSI open source
- Publisher: Xiaofan Wang
- Affiliation: independent project, not affiliated with or endorsed by OpenAI

## Use SessionHarbor when

- Codex rollout history needs incremental backup to an external drive or mounted NAS.
- Verified old local rollouts should become eligible for link/delete reclamation under a separate
  inactivity and backup-age policy.
- A verified raw rollout must be restored without consuming the vault copy.
- Multiple macOS/Windows devices need immutable peer inventories or reviewed evidence-linked context.
- A dedicated Codex task should show backup progress, restorable sessions, retention waits, and
  settings.

Do not use SessionHarbor for ordinary project-file backup, ChatGPT web conversation export, crash
dump cleanup, cloud-database synchronization, or native Codex sidebar reconstruction.

## Fastest install route

Open a new Codex task and paste one of the pinned bootstrap prompts:

- English: <https://raw.githubusercontent.com/WangPeterXF/session-harbor/v0.3.0/docs/bootstrap-prompt.en.md>
- 简体中文: <https://raw.githubusercontent.com/WangPeterXF/session-harbor/v0.3.0/docs/bootstrap-prompt.zh-CN.md>

The prompts verify the official owner/release/license, add the repository marketplace, install the
plugin, read the pinned skill, and start with a read-only dashboard.

## Operational routing

| User intent | Start with | Mutation boundary |
| --- | --- | --- |
| Show status or progress | `session-harbor dashboard --json --limit 50` | None |
| Diagnose destination/device | `doctor --json`, `bridge doctor --json` | None |
| Back up all sessions | `backup plan --json` | `backup run --apply` |
| Review retention | `settings show`, `cleanup --json` | Settings and cleanup are separate approvals |
| Delete one verified local original | Targeted `cleanup --session <id> --reclaim-action delete --json` | `--apply --confirm-delete-local` |
| Verify the vault | `verify --json` | Read-only verification |
| Restore a rollout | `restore <session-id>` | `restore <session-id> --apply` |
| Inspect another device | `sync status --json` | Peer caching/export requires separate apply |
| Share reviewed context | `memory diff/status` | Draft, approve, and stage are separate scopes |
| Migrate a legacy archive | `migrate ... plan` | Applied migration never deletes the source |

## Non-negotiable safety model

1. Backup, cleanup, restore, peer caching, reviewed-memory publication, migration, and scheduler
   installation are independent mutations.
2. Backup never deletes or links a local rollout.
3. Cleanup re-hashes the current source and vault object and refuses open/changed sources.
4. Delete requires a current verified copy, inactivity gate, backup-age hold, `--apply`, and
   `--confirm-delete-local`.
5. A missing/mismatched destination marker, target conflict, hash mismatch, symlinked path,
   traversal, peer rollback, or unknown contract fails closed.
6. SessionHarbor never writes Codex SQLite, `session_index.jsonl`, generated memory, authentication,
   caches, or project files.
7. Restore materializes verified raw JSONL. Exact sidebar/index reconstruction is not promised.

## Storage classes

- `stable-mounted`: external drive or mounted NAS; verified backup plus explicitly gated link/delete
  reclamation can be supported.
- `client-synced`: iCloud, Baidu Netdisk, or another client-managed sync folder; reclaim action must
  remain `keep` because remote durability is outside the filesystem transaction.

SHA-256 verifies bytes; it does not encrypt the destination or authenticate another writer.

## Repository source map

- Human overview and commands: `README.md`
- Repository-wide agent rules: `AGENTS.md`
- Installed workflow: `plugins/session-harbor/skills/session-harbor/SKILL.md`
- Plugin metadata: `plugins/session-harbor/.codex-plugin/plugin.json`
- Executable architecture: `docs/architecture.md`
- Threats and residual risks: `docs/threat-model.md`
- Physical-drive gates: `docs/live-readiness-checklist.md`
- Management task semantics: `docs/management-center.md`
- Contract schema: `schemas/session-harbor-contracts-v1.schema.json`
- Release evidence: `docs/release-notes-v0.3.0.md`
- Privacy, terms, and support: `PRIVACY.md`, `TERMS.md`, `SUPPORT.md`

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run --json
```

CI runs Node.js 20 and 22 across macOS, Windows, and Linux using synthetic homes and destinations.
No real session or vault payload belongs in the repository, tests, issues, or release artifacts.

## Discovery files

- Compact web index: <https://wangpeterxf.github.io/session-harbor/llms.txt>
- Combined machine-readable context: <https://wangpeterxf.github.io/session-harbor/llms-full.txt>
- Project page: <https://wangpeterxf.github.io/session-harbor/>
