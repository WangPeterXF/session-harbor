# SessionHarbor 0.3 implementation architecture

The complete three-layer design and portable layout are in
[v2-architecture.md](v2-architecture.md). This document maps the executable modules.

## Components

- `archive-core.mjs`: config v4, all-session backup inventory, verified catalog, independently
  age-selected local cleanup, restore, compression orchestration, and destination identity.
- `backup-runner.mjs`: manual/scheduled all-session backup followed by immutable snapshot publication.
- `atomic-store.mjs`: immutable/mutable same-directory temp writes, fsync, atomic rename, read-back,
  portable path checks, and concurrent-head protection.
- `device-registry.mjs`: stable device identity, protocol, device manifest, and bridge diagnostics.
- `session-snapshot.mjs`: content-addressed objects, immutable snapshots, manifest-last head commit,
  idempotency, and no-deletion propagation.
- `peer-discovery.mjs`: verified peer discovery, rollback warning, offline metadata/raw cache, and
  explicit peer export.
- `memory-exchange.mjs`: private drafts, evidence validation, approved immutable memory snapshots,
  peer diff, restricted filtering, and private local staging.
- `migration.mjs`: read-only CodexBridge/v0.1 inventory and verified import.
- `retention-runner.mjs`: compatibility orchestration for full backup, publication, and optional cleanup.
- `project-map.mjs`: private machine path to portable project ID mapping.
- `launchagent.mjs` and `windows-task.mjs`: dry-run-first scheduler generation/installation.

## Retention state machine

```text
discovered -> copied + verified -> changed -> new immutable revision
                  |
                  +-> inactive long enough + backup-age hold -> ready
                                                           +-- keep
                                                           +-- link -> linked
                                                           +-- delete -> reclaimed

linked/reclaimed -> verified restore -> restored local
restored local -> changed -> new immutable object/revision
```

`backup` covers every stable rollout and stops at copied/verified. `cleanup`/`reclaim` is the only
normal command that crosses from ready to
link/delete. Delete additionally requires `--confirm-delete-local`. `--finalize` is an explicit
compatibility override and is never scheduled.

When a stable device exists, all-session backup and cross-device snapshots reuse the same
content-addressed object. A later local deletion does not remove the object or propagate a deletion
to the session head.

## Transaction boundary

The portable publication commit order is object → immutable snapshot → mutable hash-bound head.
Peers ignore orphan objects/manifests and retain the last verified head. Every device writes only its
own subtree. Portable records contain no absolute local paths.

The destination identity marker is checked on every mutation and verification. A missing mount is
never created implicitly by archive/sync/reclaim commands.

## Local-only state

Private config, project maps, peer cache, memory drafts, staged memory, scheduler files, and absolute
paths stay outside the vault. SessionHarbor does not edit Codex indexes, SQLite, generated memory, or
authentication.
