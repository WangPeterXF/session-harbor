# Release checklist

## Before the first public push

1. Confirm `git status` contains only project files and no live config, catalog, archive, logs, or rollout data.
2. Run `npm ci --ignore-scripts`, `npm run check`, and `npm test`.
3. Run the official Codex plugin validator and skill validator.
4. Run `npm pack --dry-run --json` and inspect every included path.
5. Review `THIRD_PARTY.md`, upstream licenses, and the current Codex storage behavior.
6. Confirm `LICENSE`, `COMMERCIAL-LICENSE.md`, package metadata, and plugin metadata all use
   `PolyForm-Noncommercial-1.0.0` and describe the project as source-available, not OSI open source.
7. Confirm no third-party code or documentation contribution has been merged without an applicable
   signed contributor agreement and complete provenance records.
8. Configure the intended Git author identity, create the initial commit, and inspect it before pushing.
9. Confirm both bootstrap prompt files pin the intended repository owner and release tag; test the
   pinned marketplace install from a clean temporary Codex home and a new chat.
10. Build the removable-drive Windows handoff snapshot, verify its `SHA256SUMS`, and require a Windows
    result file before claiming cross-platform live readiness.

## Publication

- Suggested repository name: `session-harbor`.
- Keep `0.3.1` marked as a preview until all-session backup, restore, drive-remount scheduling, and
  independently backed-up live-data cleanup beta gates pass.
- Keep `.github/workflows/ci.yml` green on macOS, Windows, and Linux before a release, then protect
  the default branch and require that CI after the initial workflow has completed successfully.
- Run `npm run docs:generate` before release and require `npm run docs:check` to prevent machine-
  readable discovery files from drifting from their authoritative sources.
- Publish the source-available repository first. Do not publish npm artifacts until install, upgrade,
  uninstall, and commercial-licensing behavior is documented and tested.
- Never attach configs, catalogs, diagnostic logs, or example archives captured from a real Codex home.
- Do not accept code or documentation patches until the project has a reviewed contributor agreement
  that preserves separate commercial licensing and future relicensing options.
- The public marketplace name must be `session-harbor`; do not publish the development-only name
  `personal` or an unresolved bootstrap placeholder.
- For a public plugin-directory submission, re-run the five positive and three negative cases in
  `evals/plugin-discovery.json` and update `docs/openai-plugin-submission.md` with the observed result.

## Release evidence

Record the tested Node and Codex versions, test count, plugin/skill validator results, package dry-run contents, and any known storage-format limitations in the release notes.

The physical-drive sequence is mandatory and documented in `live-readiness-checklist.md`. Synthetic
success is not evidence that real sessions were moved or that exFAT unplug behavior passed.
