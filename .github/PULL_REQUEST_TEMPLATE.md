## Scope

Describe the change and the issue or approved maintainer task it addresses.

> SessionHarbor is not currently accepting unsolicited third-party code or documentation patches
> for merge. Read `CONTRIBUTING.md` before investing work in a pull request.

## Safety impact

- [ ] No real rollouts, configs, catalogs, logs, credentials, archive objects, device identifiers,
      or personal paths are included.
- [ ] Backup remains separate from cleanup.
- [ ] Delete/link behavior remains dry-run-first and freshly verified.
- [ ] Portable records contain no absolute paths or peer-owned writes.
- [ ] User-facing claims match tested behavior and preview limitations.

## Validation

- [ ] `npm ci --ignore-scripts`
- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm pack --dry-run --json` inspected
- [ ] Relevant plugin/skill validation completed
- [ ] Documentation, threat model, schema, and release evidence updated where applicable
