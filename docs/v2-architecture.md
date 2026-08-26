# SessionHarbor v2 three-layer architecture

Status: contract version 1 and the local filesystem implementation through M6 are checked in and
synthetically validated. Physical-drive/private-beta execution remains pending.

Last reviewed: 2026-08-26.

## 1. Product outcome

SessionHarbor should let one person use Codex on multiple computers while retaining three distinct
properties:

1. Old session evidence can leave the internal disk without becoming disposable.
2. Each computer can discover and verify what the other computer published through a removable
   drive, mounted NAS, or locally synchronized cloud directory.
3. Codex can receive a small, reviewed account of peer work without treating an entire transcript
   mirror as trusted memory.

The three layers are deliberately separate:

| Layer | Owns | Does not own |
| --- | --- | --- |
| L1: Session evidence | Raw rollout bytes, hashes, revisions, restore | Peer discovery or memory synthesis |
| L2: Exchange transport | Device identity, immutable snapshots, publishing, verification | Interpreting conversation content |
| L3: Shared recall | Reviewed decisions, artifacts, blockers, next steps, evidence links | Raw-session deletion or direct mutation of Codex internals |

A failure in a higher layer must not weaken a lower layer. For example, a bad memory digest must not
invalidate a verified raw session, and an unavailable peer must not block local archive verification.

## 2. Scope and non-goals

### In scope

- macOS and Windows devices owned by the same user.
- External drives formatted for both platforms, including exFAT.
- Mounted folders supplied by iCloud Drive, Baidu Netdisk, Synology Drive, SMB, or WebDAV clients.
- Immutable raw-session evidence and content-addressed deduplication.
- Explicit, reviewable sharing of compact work memory.
- Dry-run-first commands, exact run records, and deterministic recovery after interruption.
- Read-only import of the existing CodexBridge layout and SessionHarbor 0.1 catalogs.

### Out of scope for contract v1

- Editing Codex SQLite databases, `session_index.jsonl`, or generated memory files.
- Reconstructing the exact Codex sidebar or account state on another machine.
- Last-writer-wins memory merging.
- Propagating deletions between devices.
- Storing cloud credentials in a SessionHarbor vault or repository.
- Claiming that a readable Markdown export is a resumable Codex session.
- Concurrently opening a live Codex rollout directly from a removable drive.

## 3. End-to-end data flow

```text
local Codex rollout
        |
        | L1: stable read + SHA-256 + immutable copy
        v
device-owned content object + session snapshot
        |
        | L2: manifest-last publish to a configured carrier
        v
peer verifies head -> manifest -> content objects
        |
        | L3: evidence-linked digest + human review
        v
peer work context shown by the SessionHarbor skill
        |
        | optional explicit adoption
        v
checked-in AGENTS.md/project docs or another supported Codex input
```

Raw transcripts remain the evidence source. Shared recall is a derived, reviewable product that can
always point back to a session ID, session hash, and locator.

## 4. L1: session evidence archive

The current 0.1 archive engine is the starting point. It already performs a stable-source check,
cross-volume copy, file sync, SHA-256 comparison, destination marker verification, grace period,
reversible link, revision retention, and verified restore.

### Required invariants

- Raw JSONL bytes are canonical. Markdown, HTML, or summaries are never restore inputs.
- A content object is immutable after publication.
- A session is identified by its native session UUID; a particular byte revision is identified by
  SHA-256.
- The same session ID with a different SHA-256 is a new revision or fork, not an overwrite.
- All subtask and guardian rollouts may be retained in L1. L3 may hide housekeeping sessions by
  default, but it must not destroy their evidence.
- An object is not published until a second read verifies its stored hash.
- Local replacement or deletion is a separate authorization after verified copy and grace.
- Restore never removes the archive copy.

### Archive state machine

```text
discovered -> eligible -> copied -> verified -> grace -> linked/reclaimed
     |           |          |          |          |
     +-----------+----------+----------+----------+--> failed-closed

linked/reclaimed -> restored-local -> changed -> copied-as-new-revision
```

`copied` and `verified` do not mean internal disk space was reclaimed. Only a later, explicitly
authorized local replacement can do that.

### Content address

An identity-encoded session object is stored as:

```text
devices/<device-id>/sessions/objects/sha256/<first-two>/<sha256>.jsonl
```

A zstd-encoded object uses `.jsonl.zst`, and its `sha256` describes the stored bytes. A future
content record may add a separate canonical raw hash, but contract v1 does not imply one.

## 5. L2: device exchange and transport

### Writer ownership

Every device owns one subtree and must never modify a peer subtree:

```text
devices/<device-id>/...
```

This preserves the strongest useful property from the existing CodexBridge implementation. A Mac
and a Windows computer can publish independently without a shared database or distributed lock.

The only mutable records are pointers under the writer's own subtree. Content objects, snapshots,
and run records are append-only.

### Portable vault layout

```text
SessionHarbor/
  .session-harbor-destination.json
  protocol.json                         # protocol range and volume identity
  devices/
    <device-id>/
      device.json                       # device-manifest
      heads/
        sessions.json                   # head-pointer, replaced atomically
        memory/
          <project-id>.json             # head-pointer, replaced atomically
      sessions/
        objects/
          sha256/<prefix>/<hash>.jsonl
          sha256/<prefix>/<hash>.jsonl.zst
        manifests/
          YYYY/MM/<snapshot-id>.json    # session-snapshot
      memory/
        projects/<project-id>/snapshots/
          YYYY/MM/<snapshot-id>.json    # memory-snapshot
      runs/
        YYYY/MM/<run-id>.json           # run-record
      tmp/                              # ignored incomplete publications
```

All paths inside portable JSON use forward slashes, are relative to the vault root, and reject
drive letters, leading slashes, backslashes, empty segments, `.` and `..`. Absolute local paths are
allowed only in each device's private config.

### Identifiers

- `deviceId`: lowercase, stable, 3-64 characters, `[a-z0-9-]`; it is generated once and not derived
  again from a changing computer name.
- `projectId`: portable lowercase slug. A local map binds it to a different absolute directory on
  each computer.
- `sessionId`: native Codex UUID extracted from the rollout.
- `snapshotId` and `runId`: UUIDs generated for immutable records.
- `sha256`: 64 lowercase hexadecimal characters.

Wall-clock timestamps are diagnostic metadata, never the sole conflict ordering mechanism.

### Implemented M1 bootstrap transaction

`device init` is dry-run unless `--apply` is supplied. The applied sequence is:

1. Verify the existing destination marker.
2. Validate or publish immutable `protocol.json` bound to that marker's destination ID.
3. Save the current config version with one stable device ID and explicit backup/retention policy.
4. Validate or publish `devices/<device-id>/device.json`.
5. Publish an immutable `device-init` run record.

Saving local config before the device manifest is intentional: if the process stops between steps 3
and 4, the next run reuses the saved device ID and completes the same identity. It does not generate
a second device. Steps 1-5 do not inspect, copy, publish, link, or delete session bytes.

### Publish transaction

For a filesystem carrier, `sync push --apply` will use this order:

1. Verify the destination identity marker and protocol compatibility.
2. Copy each missing object to a unique temporary name in its final destination directory.
3. Sync the temporary file, read it back, compare SHA-256, and atomically rename it.
4. Write and validate the immutable snapshot manifest through a same-directory temporary file.
5. Sync and atomically rename the manifest.
6. Hash the manifest.
7. Write, sync, and atomically replace the device-owned head pointer last.
8. Write an immutable run record describing counts, warnings, errors, and exact portable refs.

Readers trust no file merely because it exists. They validate the head contract, verify the
manifest hash named by the head, validate the manifest, and verify required object hashes.

Temporary files never count as published data. An unplug during steps 2-7 leaves the prior head
valid, so a reader sees the previous complete snapshot. Orphan temporary files can be reported and
cleaned only by an explicit maintenance action.

Some filesystems provide weaker durability guarantees than APFS or NTFS. When directory or file
sync is unsupported, SessionHarbor must emit a warning and require a clean follow-up verification;
it must not upgrade the result to a guaranteed success.

### Pull behavior

`sync pull` means discovery and optional verified caching, not bidirectional overwrite:

- Read peer device manifests and head pointers.
- Validate hashes and protocol versions.
- Compare snapshot ancestry and content hashes.
- Cache small peer manifests and approved memory snapshots locally.
- Copy raw session objects locally only for explicit restore/export or an opted-in cache policy.
- Never write into the peer's subtree.

### Transport adapters

The protocol is transport-neutral; adapters only provide a vault root and file primitives.

| Adapter | Initial policy |
| --- | --- |
| Removable filesystem | First implementation target; full publish and verify |
| SMB/Synology mounted share | Same filesystem adapter, with disconnect and latency tests |
| iCloud/Baidu/Synology local sync folder | Copy-only; never link a live local rollout through an evictable file |
| Direct WebDAV/provider API | Future adapter; credentials stay in the provider's secure store |

Provider-specific code must not bypass the manifest-last or hash-verification protocol.

## 6. L3: reviewed shared recall

OpenAI's current documentation describes Codex memories as generated local state and recommends
checked-in instructions or project documentation for durable guidance. SessionHarbor therefore
does not write directly to `~/.codex/memories`, Codex SQLite, or other undocumented internal state.

The memory layer has two jobs:

1. Produce a compact, evidence-linked account of completed work.
2. Present approved peer context through the SessionHarbor skill for review or explicit adoption.

### Memory entry model

Each entry has:

- a stable `key`, such as `decisions/storage-safety`;
- `upsert` or `retract` operation;
- `global`, `project`, or `thread` scope;
- concise text;
- observation time and sensitivity;
- at least one evidence record with session ID, exact session SHA-256, and locator.

Recommended digest categories are:

- decisions and constraints;
- completed actions and verified outcomes;
- created artifacts and portable paths;
- blockers and exact error strings;
- next steps and unresolved questions.

A `draft` snapshot has null reviewer fields. An `approved` snapshot records reviewer device and time.
The initial publisher must refuse to place a draft snapshot at a peer-visible head.

### Adoption states

Peer memory is local context until explicitly adopted:

```text
unseen -> reviewed -> staged -> adopted
   |         |          |
   +-------> rejected   +-> superseded
```

- `reviewed` means a person or agent displayed and assessed the diff.
- `staged` means it is available to the SessionHarbor skill in a task.
- `adopted` means an explicit action copied the guidance into a supported durable location, such as
  checked-in `AGENTS.md` or project documentation.
- No state implies that Codex's native memory engine has consolidated the entry.

Restricted entries stay device-local unless the user explicitly includes them in an approved
snapshot. Raw sessions are always treated as sensitive regardless of memory labels.

## 7. Conflict rules

SessionHarbor never resolves a semantic conflict using modification time alone.

| Case | Result |
| --- | --- |
| Same session ID, same hash | Deduplicate; preserve provenance from both snapshots |
| Same session ID, different hash | Retain both revisions; report `SESSION_REVISION_DIVERGED` |
| Same memory key, same text and evidence | Deduplicate |
| Same memory key, different text with common ancestor | Three-way diff; require review |
| Update versus retraction | Require review; neither wins automatically |
| Two memory snapshots without known common ancestor | Keep parallel heads; require explicit merge |
| Unknown contract version | Refuse write/import; allow raw diagnostic inspection only |
| Peer head hash does not match manifest | Ignore new head; keep last verified local view |

A reviewed merge creates a new memory snapshot with both conflicting snapshot IDs in `parents`.
The inputs remain immutable.

Deletion propagation is excluded from contract v1. A future tombstone protocol must have retention,
expiry, and recovery semantics before it can be enabled.

## 8. Local configuration boundary

Portable metadata never contains machine-specific locations. Each device keeps a private local
configuration conceptually shaped as follows:

```json
{
  "version": 4,
  "device": {
    "id": "mac-example-air",
    "displayName": "Example MacBook Air"
  },
  "codexHome": "~/.codex",
  "backup": {
    "scope": "all",
    "allowPartial": true
  },
  "retention": {
    "cleanupAfterInactiveDays": 30,
    "minimumBackupAgeDays": 7,
    "reclaimAction": "keep",
    "autoReclaim": false
  },
  "exchange": {
    "adapter": "filesystem",
    "storageClass": "stable-mounted",
    "autoPublish": false
  },
  "projects": {
    "session-harbor": "/Users/example/Projects/session-harbor"
  },
  "memory": {
    "autoDraft": true,
    "autoPublish": false,
    "requireEvidence": true
  }
}
```

Windows uses its own local paths while keeping the same `deviceId` and `projectId` conventions.
The config, provider credentials, local peer-review state, and absolute paths are never copied into
the vault.

## 9. CLI surface

Implemented commands are:

```text
init  doctor  scan  archive  reclaim  verify/status  restore  compress
device init|show  bridge doctor  policy plan|run
project map|list  sync plan|push|pull|status|export
memory draft|diff|approve|stage|status
migrate codexbridge|v01 plan|apply
```

The first physical-drive execution remains outside the implementation milestone and follows the
live-readiness checklist.

Command rules:

- Read-only commands need no flag.
- Every filesystem or state mutation requires `--apply`.
- `plan` and any command without `--apply` produce no writes.
- JSON output contains a stable error code, affected portable refs, and whether a mutation occurred.
- `memory approve` and `memory stage` are separate actions.
- Migration never deletes source data. Any future cleanup is a separate, explicit command.

## 10. Migration plan

### Existing CodexBridge

The importer reads `CodexBridge/devices/<device-id>/backups/.../payload` without modifying it. It:

1. Inventories raw JSONL files and existing run/state files.
2. Extracts native session IDs and hashes each raw file.
3. Preserves every raw session, including subtasks; only derived L3 summaries may filter noise.
4. Publishes content-addressed objects into the importing device's SessionHarbor subtree.
5. Writes a migration run record containing counts and old portable relative paths.
6. Verifies the new snapshot independently.

The old `shared/latest` files are hints, not integrity evidence. Their absolute `vault`,
`codex_home`, and run-log paths are not copied into portable contracts.

### SessionHarbor 0.1 catalogs

Migration reads and verifies `catalog-v1.json` and its targets. It copies verified bytes into the new
content-addressed device tree and publishes a snapshot. The original catalog and files remain in
place until a later separately approved retirement workflow exists.

## 11. Security and privacy

- Never copy `auth.json`, tokens, provider credentials, caches, plugin runtimes, or arbitrary project
  trees.
- Raw sessions may contain credentials and personal data even when filenames appear safe.
- A destination marker prevents a missing mount path from silently becoming a local directory.
- SHA-256 provides integrity detection, not user authentication or encryption.
- A lost unencrypted removable drive exposes its contents. Encryption-at-rest is a deployment
  concern for v1 and a possible future adapter capability.
- An adversary with write access can roll a device head back to an older valid snapshot. Local
  clients should retain the last verified snapshot ID and warn on non-descendant heads.
- Clock skew cannot choose a conflict winner.
- Contract parsers reject unknown fields and unknown versions to prevent silent interpretation
  changes.

## 12. Acceptance matrix

No milestone is complete until its relevant cases pass with synthetic data.

| Area | Required cases |
| --- | --- |
| Contracts | All examples valid; traversal, absolute paths, unknown fields/version, bad hashes rejected |
| Ownership | A device cannot publish a head, manifest, or object path under a peer device ID |
| Archive | Source changes, target conflict, open file, wrong marker, broken link, revision restore |
| Publish | Disconnect before object, during object, after manifest, before head, and after head |
| Recovery | Orphan temp ignored; prior head remains readable; rerun is idempotent |
| Cross-platform | Synthetic macOS and Windows paths map to one project ID without leaking absolute paths |
| Conflict | Same hash dedup, session divergence retained, memory three-way conflict, retraction conflict |
| Memory | Missing evidence rejected; draft cannot publish; approved peer diff can be staged/rejected |
| Migration | Old bridge and 0.1 imports are read-only, count-preserving, hash-verified, repeatable |
| Packaging | CLI checks, tests, plugin validator, skill validator, package-content review |

Before a preview release, run a disposable-profile or independently backed-up beta on both macOS
and Windows. A successful synthetic suite is necessary but not sufficient for live-history safety.

## 13. Authoritative contracts and sources

The machine-checkable contract is split between:

- `schemas/session-harbor-contracts-v1.schema.json` for interoperable shape validation;
- `plugins/session-harbor/scripts/lib/bridge-contracts.mjs` for shape and cross-field semantic
  invariants;
- `examples/contracts/*.json` for synthetic protocol and record examples;
- `tests/bridge-contracts.test.mjs` for rejected edge cases.

The JavaScript validator is authoritative when JSON Schema cannot express a cross-field rule, such
as matching an object path to both the writer device and content hash.

Design assumptions about Codex are based on the current official documentation:

- [Memories](https://learn.chatgpt.com/docs/customization/memories)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Build plugins](https://learn.chatgpt.com/docs/build-plugins)

Codex storage behavior is an external compatibility boundary. Revalidate it before each release.
