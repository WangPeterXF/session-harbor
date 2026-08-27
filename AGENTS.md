# SessionHarbor repository guidance

## Project

SessionHarbor is an unofficial, local-first Codex plugin and zero-dependency Node.js CLI. It backs
up raw Codex rollout JSONL files to a verified content-addressed vault, keeps backup separate from
local-space reclamation, restores verified raw sessions, and exchanges device-owned snapshots plus
reviewed evidence-linked context between macOS and Windows.

The project is source-available for noncommercial use under PolyForm Noncommercial 1.0.0. Do not
describe it as OSI open source. It is not affiliated with or endorsed by OpenAI.

## Safety invariants

- Start operational workflows with read-only planning or status commands. Synthetic development
  work never authorizes mutations against a real Codex home or removable drive.
- Never write Codex SQLite, `session_index.jsonl`, generated memories, authentication, plugin
  runtimes, caches, or project trees.
- Backup must never imply cleanup. Link/delete reclamation remains a separate scope; delete requires
  `--apply --confirm-delete-local` and a current verified vault copy.
- Fail closed on destination identity mismatch, open/changed source, hash mismatch, symlinked path
  components, peer rollback, target conflicts, path traversal, or unknown contracts.
- A device writes only its own vault subtree. Local deletion must not propagate to peer snapshots.
- Never commit real rollouts, configs, catalogs, logs, tokens, device identifiers, personal paths,
  or archive objects. Tests and examples use synthetic data only.

Read `docs/threat-model.md` before changing a mutation, restore, path, identity, or verification
boundary. Read `docs/live-readiness-checklist.md` before changing physical-drive claims.

## Repository map

- `plugins/session-harbor/scripts/session-harbor.mjs`: CLI entrypoint.
- `plugins/session-harbor/scripts/lib/`: archive, backup, retention, snapshot, peer, memory, migration,
  and dashboard implementation.
- `plugins/session-harbor/skills/session-harbor/`: installed-agent workflow and focused references.
- `schemas/` and `examples/contracts/`: portable contract schema and synthetic examples.
- `tests/`: synthetic, cross-platform, interruption, and safety regression coverage.
- `docs/architecture.md`: executable component map; `docs/v2-architecture.md` is the frozen design.
- `docs/agent-index.md`: compact machine-oriented routing index.
- `scripts/generate-agent-docs.mjs`: deterministic `llms.txt`/`llms-full.txt` generator.

## Development workflow

- Keep runtime code compatible with Node.js 20+ and preserve the zero-production-dependency design.
- Prefer a focused change with a regression test. Do not weaken a refusal merely to make a test pass.
- Preserve exact error codes and dry-run/apply boundaries; downstream automation relies on them.
- When contracts change, update the schema, semantic validator, synthetic examples, tests, agent
  index, and relevant architecture or threat-model text together.
- When user-facing behavior changes, update the README, skill instructions, changelog, and release
  evidence as applicable.
- Third-party patches are not currently accepted for merge; see `CONTRIBUTING.md` before preparing a
  pull request.

## Validation

Run from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run --json
```

`npm run check` includes syntax, contract, and generated-agent-document drift checks. Inspect the
package dry run for sensitive or unintended files. When plugin or skill metadata changes, also run
the official Codex plugin and skill validators before release.

## Code review rules

- Flag any path that can delete/link a source without fresh source-and-target verification.
- Flag any backup or schedule path that implicitly enables cleanup.
- Flag portable records containing absolute machine paths or peer-owned writes.
- Flag claims of native sidebar reconstruction, encryption, authenticated ownership, or exact
  cross-platform session resumption that the implementation does not provide.
- Flag documentation that calls the license open source or hides the preview limitations.
