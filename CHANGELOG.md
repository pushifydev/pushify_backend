# Changelog

## [0.2.0-beta.11] - 2026-05-27

### Added
- `PROCESS_ROLE` split: `api` (HTTP/WS), `worker` (background jobs), `all` (dev).
- `src/worker.ts` entry + `npm run start:worker` / `dev:worker`.
- PostgreSQL pool tuning via `PG_POOL_MAX`, idle/connection timeouts.
- Redis deploy-worker leader lock (single deployment poller across worker replicas).
- Startup Redis PING + production warnings (`docs/SCALING.md`, `docs/JENKINS_BACKEND.md`).
- Jenkins deploy script and PM2 `ecosystem.config.example.cjs` (env from `.env`).

### Fixed
- API key auth: case-insensitive Bearer, `X-API-Key` header, route `pk_live_*` before JWT.

## [0.2.0-beta.10] - 2026-05-27

### Added
- Pause/resume stops and starts remote Docker containers (not only DB status).
- Server health API: disk usage and orphan `pushify-*` container scan.
- Deploy queue metadata on deployment list (`inQueue`, `queuePosition`, `queueMessage`).
- GitHub webhook auto-install via `POST /projects/:id/webhook/github/install`.

### Fixed
- Project delete tears down containers even when `serverId` is null (production URL / org scan fallback).
