# Security Policy

## Supported Versions

Pushify follows [Semantic Versioning](https://semver.org/) since `0.3.0`. Every change ships as a
new version on `master` (`version` in `package.json`, an entry in [CHANGELOG.md](CHANGELOG.md)).
There are no long-term release lines: security fixes go into the next version only and are not
backported to earlier ones.

| Version | Supported |
|---|---|
| Latest version on `master` | ✅ |
| Any earlier version, including `0.2.0-beta.*` | ❌ — update to the latest |

Pushify Cloud always runs the latest version. Self-hosted installs are updated by their operator
(see [Updating a self-hosted install](#updating-a-self-hosted-install)).

## Reporting a Vulnerability

Please **do not open a public issue** for security problems.

- Email **support@pushify.dev** with the details (steps to reproduce, impact,
  affected component), or
- use GitHub's **"Report a vulnerability"** (Security tab → Private vulnerability
  reporting) on this repository.

You can expect an acknowledgement within **72 hours**. We'll work with you on a
fix and coordinate disclosure; credit is given unless you prefer otherwise.

## How fixes are released

- A security fix is released as a new version like any other change — normally a patch bump
  (`0.6.1` → `0.6.2`).
- That version's CHANGELOG entry has a `### Security` section. This is how a security release is
  recognised; `selfhost/update.sh --dry-run` marks such releases `[security]`.
- Details of a reported vulnerability are not published before a fixed version is available.

## Updating a self-hosted install

Back up the control-plane database and keep the `.env` before every update (see
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#operations)). Then, from the install directory:

```bash
./pushify_backend/selfhost/update.sh --dry-run   # installed vs. latest version, releases in between
./pushify_backend/selfhost/update.sh             # update to the latest version
```

The script is safe to re-run: when the install is already on the latest version it does nothing.

## Scope notes

- The platform executes user-supplied code inside Docker containers on deploy
  targets — reports about escaping that isolation are especially valuable.
- Secrets (env vars, SSH keys, tokens) are encrypted at rest; anything that
  exposes them in logs, APIs or the UI is in scope.
- Deployed user applications themselves are out of scope; the platform,
  dashboard, API, CLI and installer are in scope.
