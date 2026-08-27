# SessionHarbor v0.3.1 release notes

SessionHarbor v0.3.1 is a source-available public preview for noncommercial use under the PolyForm
Noncommercial License 1.0.0. Commercial use requires a separate written license.

## What changed

- Windows handoff snapshots now include the repository agent instructions, discovery evaluations,
  privacy policy, support guide, and terms that the bootstrap workflow asks a Windows agent to read.
- Session timestamps are normalized to integer milliseconds. This prevents harmless NTFS/exFAT
  fractional timestamp differences from making byte-identical sessions appear perpetually pending.
- Existing-session verification now checks that the source stays stable while hashing. Revision
  copies also fail closed if the copied bytes no longer match the digest used to plan their
  content-addressed path.
- Applied backup refreshes stable catalog metadata when the bytes still match, without creating an
  unnecessary revision.
- The repository now exposes agent-oriented discovery files, structured plugin metadata, a public
  project page, and macOS/Windows/Linux CI on Node.js 20 and 22.

## Windows return evidence

- The original immutable `v0.3.0` handoff verified all 94 recorded checksum entries before use.
- On a local NTFS development copy, Windows reproduced the omitted-file defect, implemented the four
  fixes above, and passed `npm run check`, all 93 tests, the Codex plugin validator, and the Codex
  skill validator.
- A physical removable-drive incremental backup processed 782 local sessions: 2 copied, 780 skipped,
  and 0 errors. The restore fixture and peer export both matched their expected SHA-256 digests.
- Windows did not delete a real local session, run a cleanup scheduler, or write into the macOS
  device-owned tree.
- macOS independently recovered the exact Windows patch, reproduced its four source-file hashes in
  an isolated tree, passed all 93 tests, and generated a complete synthetic handoff whose 99 checksum
  rows all verified.

No real config, catalog, session content, device name, result log, or archive object is included in
the repository or release.

## Preview limitations

- Automated cleanup remains disabled by default. Real local deletion still requires a current
  verified backup, both time gates, an explicit apply action, and a separate delete confirmation.
- Real Windows session deletion remains untested. Windows file-link reclamation can require
  Developer Mode or elevation; the default `keep` policy is unaffected.
- Removable-drive detection on Windows uses safe periodic polling plus a weekly trigger rather than a
  portable volume-arrival event.
- exFAT may not expose directory `fsync`; SessionHarbor records that warning and still performs file
  read-back plus SHA-256 verification. Users must eject removable media cleanly.
- Cross-device memory exchange remains review-gated. SessionHarbor restores verified raw rollout
  files and does not promise exact native Codex sidebar or index reconstruction.
