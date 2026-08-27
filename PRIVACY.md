# Privacy policy

Effective date: 2026-08-27

SessionHarbor is a local-first Codex session-management plugin and command-line tool published by
Xiaofan Wang. It does not operate a developer-hosted service, require a SessionHarbor account, send
telemetry to the developer, or upload session data to the developer.

## Data processed locally

SessionHarbor can read raw Codex rollout JSONL files and related local metadata needed to inventory,
back up, verify, reclaim, restore, and exchange reviewed context. Those files can contain prompts,
code, tool output, images, credentials, personal data, and absolute local paths.

The tool writes only to locations selected or initialized by the user, including its private local
configuration and a user-selected filesystem vault. Portable records exclude absolute local paths.
SessionHarbor does not edit Codex authentication, SQLite databases, `session_index.jsonl`, generated
memories, caches, or project files.

## External storage

If a user selects an external drive, NAS, iCloud, Baidu Netdisk, Synology, WebDAV-mounted storage, or
another third-party destination, that provider's privacy and security terms govern the destination.
SessionHarbor does not control those services. Client-synchronized destinations are restricted to
non-reclaiming storage mode because sync completion and durability cannot be verified as a mounted
filesystem transaction.

## Retention and deletion

The user controls archive retention and local reclamation. Backup never deletes a local source.
Local delete reclamation requires explicit configuration, an applied command, an extra confirmation,
and a current verified vault copy. Removing files from a user-selected vault is outside the normal
SessionHarbor workflow.

## Security

SHA-256 verification detects content changes but does not encrypt a drive or authenticate another
writer. Users should encrypt storage when loss of the destination would expose sensitive data. Do
not submit real sessions, archive objects, credentials, or personal paths in public issues.

Security reports should follow [SECURITY.md](SECURITY.md). General support is described in
[SUPPORT.md](SUPPORT.md).

## Changes

Material changes to this policy will be committed to the public repository and identified in release
notes when applicable.
