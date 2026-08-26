# Windows Codex handoff

This handoff lets a second Codex installation continue Windows development and physical-drive testing
without writing into the producer-owned device tree.

## Ownership boundary

- The producer owns only `devices/<producer-device-id>/**`; read the exact ID from `handoff.json`.
- Windows must choose a new stable device ID such as `win-<computer-name>` and write only
  `devices/<windows-device-id>/**`.
- Neither device may rewrite the peer's head, manifest, object, run-record, or approved-memory tree.
- Local reclamation never propagates as a peer deletion.
- Development handoff files live outside the vault protocol tree under `SessionHarbor-Handoff/`.

## Windows pickup

1. Read `WINDOWS_HANDOFF.md`, `WINDOWS_CODEX_PROMPT.zh-CN.txt`, `handoff.json`, `SHA256SUMS`, the
   source snapshot, and the referenced producer evidence before doing work. Treat producer evidence
   as read-only.
2. Copy the source snapshot to an NTFS local development directory. Do not develop directly on the
   removable exFAT copy.
3. Verify `SHA256SUMS`, inspect the noncommercial license, then run `npm ci --ignore-scripts`,
   `npm run check`, and `npm test`.
4. Run plugin and skill validators if the Windows Codex installation provides them.
5. Use a synthetic `%USERPROFILE%\.codex` and temporary destination for all mutation tests first.
6. Render the Windows Task Scheduler XML and verify quoting, least privilege, weekly execution, drive
   polling, missing-drive no-op behavior, and no automatic cleanup.
7. Initialize a Windows config against the physical drive only after checking the drive letter,
   filesystem, marker, and free space. Use a unique Windows device ID.
8. Run backup, dashboard, peer discovery/export, reviewed-memory diff/stage, and restore tests. Do not
   delete real Windows sessions until their own backup has passed the configured inactivity and
   backup-age gates and a separate Windows restore pilot has succeeded.
9. Write results only to `results/windows-<device-id>-result.json` using the supplied template. Never
   edit the producer result or source snapshot in place.

## Required result evidence

Record exact commands and outcomes for:

- source checksum verification;
- Node, Codex, Windows, and filesystem versions;
- test count and failures;
- plugin and skill validation;
- rendered and installed scheduler behavior;
- destination marker and device identity;
- incremental backup and current dashboard counts;
- peer read/export without producer-tree mutation;
- reviewed memory diff/stage without native-memory mutation;
- restore byte/hash equality; and
- any deletion test, including the exact inactivity and backup-age timestamps.

Use `blocked` rather than `passed` when a real safety gate has not elapsed. Never use `--finalize` to
manufacture a retention pass.
