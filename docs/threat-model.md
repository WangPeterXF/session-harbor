# Threat model

## Protected outcomes

- A copy is never called archived until its SHA-256 matches a stable source snapshot.
- A local rollout is never replaced merely because a destination filename exists.
- An open or changed rollout is not finalized.
- Restore does not consume Markdown, HTML, or an unverified target.
- Paths from configuration or catalog entries cannot escape their declared roots.
- Existing symbolic links in archive path components, marker paths, and catalog paths are rejected.
- A configured archive only accepts the destination carrying its original random identity marker.
- A portable contract cannot contain an absolute or traversal path.
- One device cannot publish a valid head or content path under a peer device's subtree.
- A memory entry is not accepted without evidence tied to an exact session ID and hash.
- A vault protocol must match the destination marker identity before a device manifest is trusted.
- A stored device identity cannot be rebound through later CLI flags or a conflicting manifest.
- Archive publication cannot implicitly reclaim a local source; reclamation is a separate scope.
- Delete reclamation requires an extra confirmation and a still-verifiable archive copy.
- Local deletion does not propagate through session snapshots.
- A draft memory snapshot can never become a peer-visible head.
- Legacy migration never mutates or cleans up its source layout.

## Expected failures

- Destination disconnected before a run: the command stops before modifying sources.
- Expected mount path exists but belongs to a different disk or recreated folder: marker comparison stops the run.
- Destination disconnects during copy: the partial file is removed when possible and the source remains.
- Source changes during hash or copy: the operation fails and does not publish a catalog entry.
- Target changes after copying: finalization and restore fail on a hash mismatch.
- Process stops after catalog state `copied`: the source is still local; a later run can continue safely.
- Process stops during local link or restore replacement: a same-directory backup is used for rollback.
- Process stops before a session or memory head update: the previous head remains authoritative.
- Peer head is rolled back or diverges: the cached verified view remains and a rollback warning is shown.
- Destination is disconnected after metadata was cached: the view is marked stale; raw export requires
  an explicitly cached verified object.

## Residual risks

- POSIX cannot provide a cross-process transaction with Codex's writer. The tool combines an age gate, stable metadata checks, repeated hashes, and `lsof`; a narrow race can still exist if another process opens the file immediately after the final check.
- A symlinked session cannot resume when its destination is disconnected.
- A locally deleted session is absent from native Codex storage until explicitly restored; exact
  sidebar reconstruction is not promised.
- Windows open-file safety relies on stable-copy checks and rename-enforced reclamation rather than
  `lsof`; filesystem and application behavior still requires physical beta testing.
- exFAT and network/client-synchronized filesystems may not provide the same durability guarantees as
  APFS/NTFS. Applied writes verify read-back, but power-loss behavior remains carrier-dependent.
- A malicious process with the same user permissions can modify files between checks.
- SHA-256 detects accidental or unsophisticated modification but does not authenticate archive ownership.
- Internal Codex storage conventions may change. Always test after upgrading Codex.
- A malicious writer can replay an older but internally valid head. Clients must retain the last
  verified lineage and warn on rollback or divergence.
- SHA-256 does not authenticate device ownership. Contract v1 relies on a user-controlled vault;
  signed manifests are a possible future hardening measure.
- A device bootstrap interrupted after config save may leave a missing manifest, but the saved
  stable ID is the recovery anchor and a repeated initialization completes the same identity.

## Secrets and publication

Raw rollout files and live configuration are sensitive. CI uses only synthetic fixtures. Release archives must exclude `catalog-v1.json`, real configs, logs, and any session data.
