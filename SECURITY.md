# Security Policy

## Supported Versions

Pushify is in active beta. Security fixes land on the latest `master`; earlier
betas are not patched retroactively. Self-hosters should track `master` (or the
latest release) to receive fixes.

## Reporting a Vulnerability

Please **do not open a public issue** for security problems.

- Email **support@pushify.dev** with the details (steps to reproduce, impact,
  affected component), or
- use GitHub's **"Report a vulnerability"** (Security tab → Private vulnerability
  reporting) on this repository.

You can expect an acknowledgement within **72 hours**. We'll work with you on a
fix and coordinate disclosure; credit is given unless you prefer otherwise.

## Scope notes

- The platform executes user-supplied code inside Docker containers on deploy
  targets — reports about escaping that isolation are especially valuable.
- Secrets (env vars, SSH keys, tokens) are encrypted at rest; anything that
  exposes them in logs, APIs or the UI is in scope.
- Deployed user applications themselves are out of scope; the platform,
  dashboard, API, CLI and installer are in scope.
