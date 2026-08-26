# SessionHarbor v2 development plan

This plan turns the [three-layer architecture](v2-architecture.md) into small, testable increments.
It is also the proposed GitHub roadmap after private testing succeeds.

## Working rules

- Complete one vertical slice before adding another transport provider.
- Keep the CLI thin; filesystem and protocol behavior belongs in testable library modules.
- Use only synthetic Codex homes and temporary vaults in automated tests.
- Preserve exact error codes and run records across macOS and Windows.
- Add a failing regression test before changing a safety invariant.
- Do not combine publication, local reclamation, memory approval, or migration cleanup in one flag.
- Mark planned commands as unavailable instead of exposing placeholders that appear successful.

## Target module boundaries

```text
plugins/session-harbor/scripts/
  session-harbor.mjs                 # argument parsing and presentation only
  lib/
    archive-core.mjs                 # existing L1 archive/restore behavior
    bridge-contracts.mjs             # portable contract v1 validation
    atomic-store.mjs                 # same-directory temp, fsync, hash, rename
    device-registry.mjs              # device identity and protocol negotiation
    session-snapshot.mjs             # immutable object and snapshot creation
    peer-discovery.mjs               # head/manifest verification and comparison
    project-map.mjs                  # private absolute path to portable project ID
    memory-exchange.mjs              # draft, diff, approve, stage
    migration.mjs                    # read-only old-layout inventory and import
    run-record.mjs                   # stable operation evidence
    transports/
      filesystem.mjs                 # removable drive and mounted folder
```

Do not split modules merely to match this tree. Split when a milestone introduces the behavior and
keep public interfaces small.

## M0: freeze protocol and safety semantics

Status: implemented and validated locally in the current working tree.

Deliverables:

- Three-layer architecture and explicit non-goals.
- Portable vault layout and device writer-ownership rule.
- JSON Schema and semantic validator for contract v1.
- Synthetic examples for vault protocol, device, head, session, memory, and run records.
- Tests for path portability, device ownership, hashes, evidence, unknown fields, and versions.

Exit gate:

- `npm run check:contracts` succeeds.
- Contract tests reject both POSIX and Windows absolute paths.
- No example contains a real username, mount path, session, or prompt.
- Architecture and code agree on every contract kind and enum.

## M1: device and vault bootstrap

Status: implemented and validated locally in the current working tree.

Goal: initialize one device against one filesystem vault without publishing sessions.

Implementation tasks:

1. Introduce a versioned local config with migration from earlier settings in memory and on the
   next explicitly applied config write.
2. Generate and persist a stable device ID; never silently regenerate an existing identity.
3. Extend destination initialization with a protocol record and supported contract range.
4. Publish `devices/<device-id>/device.json` through the atomic store.
5. Add `device init`, `device show`, and `bridge doctor`.
6. Detect duplicate device IDs with different device manifests and stop with
   `DEVICE_IDENTITY_CONFLICT`.
7. Record filesystem capability warnings without assuming APFS, NTFS, or exFAT semantics.

Tests:

- New vault versus existing 0.1 destination.
- Missing, wrong, and substituted destination marker.
- Unsupported protocol range.
- Repeated initialization is idempotent.
- Same device ID with conflicting immutable identity is rejected.
- Simulated macOS, Windows, and Linux platform values.

Exit gate:

- No session bytes are copied by M1 commands.
- Every applied bootstrap has a matching run record or an explicit documented pre-run exception.
- A dry-run writes nothing.

## M2: session snapshot publication

Status: implemented and validated with synthetic homes, content deduplication, source-race tests,
and interruption at the head commit boundary.

Goal: publish one device's verified raw sessions in the portable layout.

Implementation tasks:

1. Refactor stable copy/hash primitives from `archive-core.mjs` into a reusable atomic store without
   changing current archive behavior.
2. Build a session inventory from `sessions` and `archived_sessions` only.
3. Extract the native session ID without loading an unbounded rollout into memory.
4. Stream-copy missing content objects and verify stored bytes.
5. Build an immutable session snapshot with an optional parent snapshot.
6. Publish the session head last and write a run record.
7. Add `sync plan` and `sync push`; both are dry-run unless `--apply` is present.
8. Make reruns idempotent by content hash.

Tests:

- Same content at two source paths deduplicates the object but preserves both manifest records only
  if their source keys differ and are valid.
- Same session ID with changed bytes retains both objects.
- Source modification during copy fails closed.
- Target conflict, corrupt existing object, and symlink redirection fail closed.
- Interrupt at every publish step leaves the previous head valid.
- An object present without a referencing manifest is not reported as published work.

Exit gate:

- A second identical push publishes zero new objects.
- Every head resolves to a manifest whose named objects pass verification.
- Existing `archive`, `verify`, and `restore` tests remain unchanged and pass.

## M3: peer discovery and cross-device continuity

Status: implemented and validated with synthetic macOS/Windows devices, rollback/corruption cases,
offline metadata/raw-object caches, and explicit peer export.

Goal: let Mac and Windows compare verified peer work without overwriting each other.

Implementation tasks:

1. Discover peer devices by validated device manifests.
2. Verify peer heads, manifest hashes, manifests, and requested objects.
3. Add local peer state outside the vault: last verified head, review status, and rollback warning.
4. Implement snapshot ancestry comparison:
   `unseen`, `up-to-date`, `local-ahead`, `peer-ahead`, `diverged`, `invalid`.
5. Add `sync pull` as verified metadata caching by default; raw object caching is opt-in.
6. Add `sync status --json` with exact per-peer counts and error codes.
7. Add explicit session restore/export from a peer object without changing Codex databases.
8. Add a private project map so different absolute paths resolve to one portable project ID.

Tests:

- Mac and Windows fixtures publish to separate trees.
- A device cannot write or generate a valid pointer for a peer tree.
- Rolled-back, corrupt, missing, and unsupported peer heads are ignored safely.
- Project mapping never leaks either machine's absolute path into a contract.
- A disconnected vault leaves the last verified local peer view readable but clearly stale.

Exit gate:

- Two synthetic devices can publish, disconnect, reconnect, and identify each other's new sessions.
- No test requires a shared SQLite database or cross-device lock.
- A peer failure cannot alter local archive state.

## M4: reviewed memory exchange

Status: implemented as private drafts, evidence validation, explicit approval, peer diff, restricted
entry filtering, and private local staging. Durable project-file adoption remains intentionally
outside the automatic workflow.

Goal: summarize peer work into a compact evidence-linked layer that can be reviewed and staged.

Implementation tasks:

1. Define a deterministic input selector for primary versus subtask/guardian sessions. Raw L1
   retention remains complete; only digest noise filtering changes.
2. Implement memory drafts with decision, outcome, artifact, blocker, and next-step categories.
3. Require an evidence record for every entry.
4. Implement snapshot diff by stable key and ancestry.
5. Implement approval as a separate local action that publishes a new immutable snapshot.
6. Refuse a draft head with `MEMORY_DRAFT_NOT_PUBLISHABLE`.
7. Implement `memory stage` into SessionHarbor's private local context cache.
8. Teach the bundled skill to display staged peer context and provenance.
9. Provide an explicit export for a proposed `AGENTS.md` or project-doc change; do not edit it without
   the user's normal file-change authorization.

Tests:

- Missing or stale evidence hash is rejected.
- Draft cannot become peer-visible.
- Same-key edits, update/retract, parallel ancestry, and reviewed two-parent merge.
- Restricted entries are excluded by default.
- Staging never writes Codex generated memories or SQLite.
- The skill distinguishes `staged` from `adopted` and from native Codex memory.

Exit gate:

- A peer can answer “what changed on the other computer?” from approved memory with evidence links.
- Conflicting memory stays visible until explicitly merged or rejected.
- Removing the vault does not corrupt local Codex state.

## M5: read-only migrations

Status: implemented for CodexBridge payloads and SessionHarbor v0.1 catalogs. Sources remain
untouched; incomplete/hash-mismatched inventories fail closed.

Goal: import existing work without making legacy data less recoverable.

Implementation tasks:

1. Add `migrate codexbridge plan` for the old `devices/<id>/backups/.../payload` layout.
2. Add `migrate v01 plan` for `catalog-v1.json` and current archive targets.
3. Produce deterministic inventory counts, bytes, session IDs, hashes, and warnings.
4. Add separately authorized `apply` that only creates new verified objects and manifests.
5. Record source layout, source relative refs, imported counts, skipped duplicates, and conflicts.
6. Keep legacy payload and catalogs untouched.

Tests:

- Incomplete old runs, duplicated payloads, missing indexes, subtask records, and changed revisions.
- Repeating the same migration produces no new content objects.
- A failed new publish leaves all old data unchanged.
- Real absolute paths from legacy state are redacted from portable output.

Exit gate:

- Inventory count equals imported plus skipped plus failed.
- Every imported raw file is hash-verifiable from its new snapshot.
- There is no migration cleanup command in the first implementation.

## M6: adapter and Windows hardening

Status: implemented for the filesystem adapter, Mac LaunchAgent/Windows Task Scheduler rendering,
Windows private paths, Unicode/long-path fixtures, stable-mounted versus client-synced policy, and a
three-OS GitHub Actions matrix. Physical exFAT unplug testing remains part of M7.

Goal: make the filesystem protocol reliable in the user's intended environments.

Implementation order:

1. exFAT removable drive on macOS and Windows.
2. Synology/SMB mounted folder.
3. iCloud/Baidu/Synology client-managed local folders in copy-only mode.
4. Direct WebDAV or provider API only after the filesystem protocol is stable.

Required work:

- Windows-safe config, path handling, open-file diagnostics, and scheduler documentation.
- Filesystem capability probe and explicit durability warning.
- Long-path and Unicode tests.
- Provider-eviction detection where available.
- No credentials in run records, examples, logs, or bug reports.

Exit gate:

- Cross-platform integration suite passes on GitHub Actions.
- Physical-drive unplug tests have recorded expected outcomes.
- An adapter cannot weaken contract validation or object verification.

## M7: private beta and public preview

Status: local packaging and synthetic gates implemented. Physical-drive rehearsal, disposable
profile beta, and selected live copy-only pilot remain deliberately unexecuted.

Private beta sequence:

1. Create an independent backup of both computers' Codex data.
2. Use a disposable Codex profile and synthetic sessions on the real drive.
3. Test Mac publish, Windows read, Windows publish, Mac read.
4. Test disconnect and reconnect at each publish boundary.
5. Test reviewed memory conflicts and rejection.
6. Import a copy of the old CodexBridge layout.
7. Only then test all-session incremental backup against independently backed-up live history.
8. Keep linked/delete cleanup disabled until restore is independently verified.

Public-preview gate:

- No unresolved P0/P1 data-loss or credential-leak issue.
- Recorded Node, Codex, macOS, Windows, filesystem, and drive test versions.
- Plugin and skill validators pass.
- `npm pack --dry-run --json` contains no live data.
- Installation, upgrade, rollback, and removal are documented.
- Known limitations prominently state that native sidebar reconstruction and native-memory injection
  are not promised.

## M8: disaster-recovery backup separated from local cleanup

Status: implemented in config v4 and validated with synthetic recent, old, changed, deleted, and
restored sessions. Live scheduled cleanup remains intentionally disabled pending a chosen inactivity
threshold and explicit authorization.

Goal: make a missing local disk survivable without requiring a session to become old before it is
backed up, while keeping disk-space reclamation independently reviewable.

Implementation tasks:

1. Make every manual or scheduled backup inventory all regular rollouts in both supported roots.
2. Preserve immutable prior revisions when a previously backed-up session grows.
3. Publish the device snapshot without propagating local deletion.
4. Make cleanup eligibility depend on inactivity, a minimum verified-backup age, current source and
   target hash equality, and open-file protection.
5. Add manual `backup` and `cleanup` commands while retaining legacy command compatibility.
6. Combine mount and weekly backup triggers on macOS; combine weekly and safe drive-presence polling
   on Windows; allow either trigger to be disabled independently.
7. Treat an unavailable configured destination as a scheduler no-op, but continue to reject a
   substituted destination marker.
8. Leave `autoReclaim=false` and `reclaimAction=keep` as safe defaults.

Exit gate:

- Recent and tiny sessions appear in a full backup even when they fail the cleanup policy.
- A repeated unchanged backup publishes zero new objects; a continued session publishes one new
  immutable revision.
- Cleanup never touches an unverified, changed, too-recent, or open local source.
- A deleted pilot session restores byte-for-byte from the vault.
- Scheduler renderers encode the selected trigger combination and never imply cleanup.

## Proposed GitHub work breakdown

Use milestone labels `M1` through `M8` and these issue types:

- `protocol`: contract or compatibility change;
- `safety`: data integrity, source replacement, secrets, or recovery;
- `transport`: carrier implementation;
- `memory`: digest, review, or conflict behavior;
- `migration`: existing-layout import;
- `platform:macos` and `platform:windows`;
- `needs-live-beta`: cannot be proven by synthetic fixtures alone.

Every issue should include:

1. User-visible outcome.
2. Inputs and mutation boundary.
3. Stable error codes.
4. Contract changes, if any.
5. Failure and interruption cases.
6. Tests and acceptance evidence.
7. Migration or backward-compatibility effect.

## Definition of done for any change

- Behavior is implemented, not only documented.
- Dry-run and applied behavior are separately tested where relevant.
- No peer or source ownership boundary is weakened.
- Contract examples and schemas are updated together when required.
- Exact errors are stable and actionable.
- Threat model and changelog reflect new mutation or privacy surfaces.
- Full checks, tests, plugin validation, skill validation, and package inspection pass.
