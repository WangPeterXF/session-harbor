# OpenAI public plugin submission pack

This is a review-ready source sheet for a future **Skills only** submission. It does not claim that
SessionHarbor has been submitted, reviewed, endorsed, or accepted by OpenAI.

## Listing

- **Plugin name:** SessionHarbor
- **Developer identity:** Xiaofan Wang (individual verification required in the submission portal)
- **Category:** Productivity
- **Short description:** Back up, reclaim, restore, and review Codex sessions safely.
- **Long description:** SessionHarbor turns a dedicated Codex task into a local session-management
  center. It incrementally backs up every stable local Codex rollout to a content-addressed vault,
  verifies stored bytes, reports progress and retention waits, and restores selected raw sessions.
  Backup and local cleanup are separate. Optional cleanup applies only after inactivity and backup-age
  gates and requires a current verified copy. Immutable device-owned snapshots and reviewed
  evidence-linked context help macOS and Windows devices understand prior work without a shared
  writable database.
- **Website:** <https://wangpeterxf.github.io/session-harbor/>
- **Repository:** <https://github.com/WangPeterXF/session-harbor>
- **Support:** <https://github.com/WangPeterXF/session-harbor/blob/main/SUPPORT.md>
- **Privacy:** <https://github.com/WangPeterXF/session-harbor/blob/main/PRIVACY.md>
- **Terms:** <https://github.com/WangPeterXF/session-harbor/blob/main/TERMS.md>
- **License:** PolyForm Noncommercial 1.0.0; commercial use requires a separate written license
- **Availability recommendation:** select only countries offered by the portal where the publisher
  is prepared to provide the listing and license; confirm this choice at submission time.

## Starter prompts

1. Use SessionHarbor as my management center and show the current read-only dashboard.
2. Show a dry-run plan to back up all my local Codex sessions to my configured vault.
3. List sessions removed locally that remain verified and restorable.

## Discovery evaluation

The canonical machine-readable set is `evals/plugin-discovery.json`. Run every prompt in a new task
against the packaged plugin and record whether SessionHarbor was selected, what command was proposed,
and whether an approval was requested at the correct boundary.

### Five positive cases

1. A 70 GB Codex history needs all-session incremental backup to an external drive.
2. A user wants backup progress and restorable/deleted session inventories.
3. A user wants to configure 30 inactive days plus a 7-day verified-backup hold without enabling
   automatic deletion.
4. A user wants to restore one selected rollout from the verified vault.
5. A user wants reviewed context about work performed by Codex on another device.

### Three negative cases

1. Back up an ordinary Documents folder to iCloud: do not select SessionHarbor.
2. Export ChatGPT web conversations: do not select SessionHarbor.
3. Delete macOS crash dumps: do not select SessionHarbor.

## Expected safety behavior

- The first operational response is read-only.
- No real filesystem mutation is inferred from installation, development, or test approval.
- Backup never runs cleanup.
- Cleanup/delete is not proposed as automatic by default.
- Client-synced storage remains `keep` only.
- Native sidebar reconstruction, encryption, or authenticated device ownership is not promised.

## Submission checklist

- [ ] Individual developer identity verified in the OpenAI Platform organization used for submission.
- [ ] Apps Management write permission available for the submitter.
- [ ] Plugin bundle passes the current official validator.
- [ ] Skill bundle passes the current official validator.
- [ ] All five positive and three negative discovery cases replayed in new tasks.
- [ ] Website, support, privacy, terms, logo, descriptions, and starter prompts publicly reachable.
- [ ] Current release notes and preview limitations supplied.
- [ ] Country availability explicitly reviewed.
- [ ] No claim of OpenAI affiliation, endorsement, or OSI open-source licensing.
