# Contributing to Pushify

Thanks for your interest in contributing to Pushify! This guide will help you get started.

## Development Setup

1. Fork and clone the repository
2. Follow the [Getting Started](README.md#getting-started) guide
3. Create a new branch for your feature or fix

## Branch Naming

- `feat/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation changes
- `refactor/description` — Code refactoring

## Commit Messages

Use clear, concise commit messages:

```
feat: add webhook notification support
fix: resolve database connection timeout
docs: update API endpoint documentation
refactor: extract modal into shared component
```

## Pull Request Process

1. Ensure your code passes linting and type checks
2. Update documentation if you've changed APIs or added features
3. Write a clear PR description explaining what changed and why
4. Link any related issues
5. Bump the version and add a CHANGELOG entry (see [Versioning and Changelog](#versioning-and-changelog))

## Versioning and Changelog

The backend follows [Semantic Versioning](https://semver.org/). Every PR bumps the version in `package.json` once, starting from the version currently on `master`, and adds a matching entry to [CHANGELOG.md](CHANGELOG.md) in the same PR. Always update both files together.

| Change | Bump | Example |
|--------|------|---------|
| Bug fix | patch | `1.2.3` → `1.2.4` |
| New feature (backward compatible) | minor | `1.2.3` → `1.3.0` |
| Large or breaking change (e.g. a removed or renamed API endpoint or field) | major | `1.2.3` → `2.0.0` |

If a PR has several kinds of change, use the largest bump.

1. Bump the version. This updates `package.json` and `package-lock.json` without creating a commit or tag:

   ```bash
   npm version patch --no-git-tag-version   # or: minor, major
   ```

2. In `CHANGELOG.md`, add a `## [X.Y.Z] - YYYY-MM-DD` section below `## [Unreleased]` with the new version from `package.json`. Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and group entries under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security`.
3. If another PR that bumps the version merges first, rebase onto it. Then take the next version after the one now on `master` and rename your CHANGELOG section to match.

Versions up to `0.2.0-beta.108` used `-beta.N` pre-release numbers. Since `0.3.0`, versions are plain `MAJOR.MINOR.PATCH`.

## Tests

- `npm test` — unit tests (fast, no services needed).
- `npm run test:e2e` — deploys real fixture repos to a real server and checks them over HTTP(S): git clone, Docker build, nginx vhost, certificates, blue-green redeploy. The "server" is a privileged container (`e2e/`) with sshd, Docker, nginx and certbot pointed at Pebble, Let's Encrypt's test CA; needs Docker, takes a few minutes, and never writes to your checkout. Tests live in `src/e2e/`. CI runs it on every push and PR (`.github/workflows/e2e.yml`).

Anything that talks to a server through SSH — deploys, nginx, certificates, containers — should get an e2e case: that is where unit tests with a fake SSH have missed real bugs.

## Code Style

- **TypeScript** — All code must be typed, avoid `any`
- **Components** — Use shared components from `components/` when possible
- **Constants** — Use `lib/constants.ts` for colors and status mappings
- **Utilities** — Use `lib/formatters.ts` for shared formatting functions
- **CSS** — Use CSS variables from `globals.css`, no hardcoded colors
- **i18n** — All user-facing strings must use the translation system

## Project Architecture

```
Frontend:  Page → Hook (React Query) → Service (API call) → Backend
Backend:   Route → Service → Repository → Database (Drizzle ORM)
```

## Reporting Issues

- Use the GitHub issue templates
- Include steps to reproduce for bugs
- Include screenshots for UI issues

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
