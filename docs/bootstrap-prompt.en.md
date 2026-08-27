# One-paste SessionHarbor bootstrap prompt (English)

This prompt is pinned to release `v0.3.1` of the official `WangPeterXF/session-harbor` repository.

Copy everything between `PROMPT START` and `PROMPT END` into a new Codex chat.

--- PROMPT START ---

Make this chat my dedicated SessionHarbor management center for backing up, reclaiming, restoring,
exchanging, and reviewing shared context from local Codex sessions.

The only authorized source is the GitHub repository `WangPeterXF/session-harbor` pinned to
`v0.3.1`. Perform the following workflow:

1. Read `LICENSE`, `README.md`, `SECURITY.md`, and
   `plugins/session-harbor/skills/session-harbor/SKILL.md` from that exact revision. Confirm the
   source, noncommercial license, and safety boundaries. Do not install a fork, search-result copy,
   or third-party archive.
2. Inspect the current OS, Codex CLI, Node.js, installed plugin, and marketplace state. Follow Codex
   approval prompts for network access, installation, and configuration writes. Never collect or
   copy `auth.json`, tokens, credentials, project trees, or real session contents.
3. Prefer the supported repository marketplace flow:
   - `codex plugin marketplace add WangPeterXF/session-harbor --ref v0.3.1`
   - confirm the marketplace name is `session-harbor`, then run
     `codex plugin add session-harbor@session-harbor`.
   If `codex plugin` is unavailable, clone the pinned revision into a persistent user directory for
   local validation. Do not hand-edit marketplace configuration or claim installation succeeded.
4. Do not claim the newly installed skill hot-loaded into this chat. To make this chat usable now,
   read the verified checkout's complete SessionHarbor `SKILL.md` and only the references it routes
   to for the current task, then follow them for the rest of this chat. Explain that the installed
   plugin becomes available normally in new Codex chats.
5. If task renaming is supported, name this task `SessionHarbor Management Center` and retain it as
   the dedicated management chat.
6. Begin read-only: run `doctor --json`, `bridge doctor --json`, and
   `dashboard --json --limit 50`. Summarize destination availability, cataloged backups, pending
   backups, local deletions, restorable sessions, inactivity waits, backup-age waits, policy, latest
   publication, and any active operation.
7. If uninitialized, ask for a stable external-drive or NAS path. Do not format media, guess drive
   letters, or configure a client-synced folder for local deletion. Preview and separately authorize
   initialization, backup, settings changes, schedule installation, local deletion, restore,
   cross-device writes, and memory publication.
8. Map natural-language requests to these actions:
   - status/progress: `dashboard`, read-only;
   - back up now: `backup plan`, then `backup run --apply` after confirmation;
   - list deleted/pending/waiting sessions: the matching `dashboard --state ...` filter;
   - change inactivity or backup-age waits: dry-run `settings set`, then `--apply` after review;
   - delete local sessions: show exact targets and use single-session `--session` by default; only a
     current verified backup past both time gates may be deleted, and deletion requires
     `--apply --confirm-delete-local`;
   - restore: dry-run the exact selector, apply after confirmation, then verify the restored hash;
   - scheduling: show manual, drive-mount, and weekly choices before installation; scheduled cleanup
     remains separately authorized and off by default;
   - peer sessions/shared context: read only the peer-owned tree, diff before staging, and never write
     Codex native memory or a peer device tree.
9. Label every result as planned, running, verified complete, or blocked by a safety gate. A fast
   catalog/metadata dashboard is not a fresh full SHA-256 scrub; perform the required full verification
   before deletion or restore.

Begin with installation verification and the read-only dashboard. Do not delete any local session.

--- PROMPT END ---
