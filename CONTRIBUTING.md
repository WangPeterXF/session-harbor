# Contributing

Bug reports, security reports, design proposals, and documentation feedback are welcome. Do not
include real rollouts, catalogs, configs, tokens, usernames, proprietary information, or absolute
personal paths.

## Code and documentation contributions

SessionHarbor is not currently accepting third-party code or documentation patches for merge. This
temporary policy keeps the copyright and relicensing chain clear while the project establishes an
appropriate contributor agreement. Pull requests may be closed without review; do not send code
that you expect the project to incorporate.

A future contribution policy may require a Contributor License Agreement (CLA) that preserves the
copyright holder's ability to distribute SessionHarbor under both noncommercial and separate
commercial terms. No contribution is accepted under such an agreement until the agreement is
published and affirmatively accepted by the contributor.

## Issue reports and proposals

Reports and proposals should:

1. Use synthetic Codex homes and temporary destinations only.
2. Include the command, platform, Node version, exact error code, and a minimal synthetic reproduction.
3. Describe any affected safety invariant, mutation, destination type, or interruption behavior.
4. Avoid credentials, personal data, real session IDs, and local archive contents.

Provider-specific cloud proposals must keep credentials outside the repository and must not weaken
local verification.
