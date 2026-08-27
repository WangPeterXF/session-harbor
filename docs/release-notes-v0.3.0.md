# SessionHarbor v0.3.0 release notes

SessionHarbor v0.3.0 is the first public preview. It is source-available for noncommercial use under
the PolyForm Noncommercial License 1.0.0. Commercial use requires a separate written license.

## Cross-platform validation

- The same immutable handoff source passed `npm run check`, all 88 tests, the Codex plugin
  validator, and the Codex skill validator on Windows.
- The Windows fixes were recovered into the primary source tree and the same 88 tests passed again
  on macOS.
- A physical exFAT vault completed full Windows all-session backup, incremental reruns, strict
  object verification, read-only discovery of the macOS peer, dry-run peer export, missing-drive
  no-op behavior, and a synthetic byte-for-byte restore.
- The returned Windows head, manifest, and every object referenced by the latest snapshot were
  independently SHA-256 verified on macOS.
- A single real macOS session completed a deletion-and-restore pilot with matching bytes and hash.
  No real Windows session was deleted because that action was outside the Windows test authority.
- The Windows writer did not modify the macOS device tree. No cleanup, reclaim, or `--finalize`
  operation ran against real Windows sessions.

No real configs, catalogs, session contents, device names, result logs, or archive objects are
included in this repository or release.

## Windows defects found and fixed

| Area | Observed failure | Fix and regression coverage |
| --- | --- | --- |
| Node entrypoints | `file://` string construction did not match native Windows paths, so directly invoked scripts could exit without running. | Entrypoints now compare `import.meta.url` with `pathToFileURL(path.resolve(process.argv[1])).href`; direct CLI and scheduler execution are tested. |
| Detached drive | `backup run --apply --if-available` referenced `pathExists` without importing it. | The import is present and a detached destination returns `backup-skipped` / `destination-unavailable` with exit code 0. |
| Shared catalog | A device could attempt to validate peer-owned catalog entries as if they belonged to its own object tree. | Backup lookup, snapshot inventory, verification, dashboard counts, cleanup, and restore selection are filtered by the configured device ID. |
| Windows file links | Creating a file symlink can require Developer Mode or elevation. | An `EPERM` becomes `WINDOWS_SYMLINK_PRIVILEGE_REQUIRED`; the local source remains a regular verified file. Directory-redirection tests use Windows junctions. |
| Task Scheduler XML | The XML declared UTF-16 but was written as UTF-16LE without a byte-order mark. | Scheduler XML is written with an explicit `FF FE` BOM and decoded round-trip in tests. |

## Preview limitations

- The `v0.3.0` tag predates activation of the three-platform GitHub Actions workflow. The main branch
  now carries `.github/workflows/ci.yml`; use the tag's recorded Mac/Windows evidence for the tagged
  release and current Actions runs for later commits.
- Normal schedules perform all-session incremental backup only. Automated cleanup is disabled by
  default and requires separate policy plus deletion authorization.
- Windows removable-drive detection uses safe periodic polling in addition to a weekly trigger; it
  does not rely on a portable volume-arrival event.
- File-link reclamation on Windows requires Developer Mode or elevation. The default `keep` policy
  is unaffected, and explicit delete reclamation uses separate safety gates.
- exFAT may not expose directory `fsync`; SessionHarbor records that warning and still performs file
  read-back plus SHA-256 verification. Users must eject removable media cleanly.
- Cross-device memory exchange remains review-gated. If a peer has not published a memory head,
  memory diff/stage correctly remains unavailable rather than inventing shared context.
- SessionHarbor restores raw rollout files and does not promise exact native Codex sidebar/index
  reconstruction.
