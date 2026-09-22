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
