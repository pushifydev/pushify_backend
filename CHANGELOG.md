# Changelog

## [0.2.0-beta.14] - 2026-06-13

### Added
- Static-site stack: publish editor sites on an auto-assigned port with no domain required (port-mode nginx + automatic firewall opening), alongside the existing domain/SSL path.
- Multi-page sites: new `pages` jsonb column (migration `0029`, with backfill of existing single-page sites) and a `PUT` pages API; renderer emits multi-file output (`index.html` + per-page directories) with a shared sticky nav.
- Design gallery API (`getDesigns` / `applyTemplate`) powering the editor's template picker.

### Fixed
- Static-site deploys now run through the standard deployment pipeline (deployment record + worker), so deployments start automatically after launch.
- RHEL/CentOS compatibility: write site nginx configs to `conf.d` (not `sites-available`) and apply SELinux port/content labels (`semanage` + `chcon`) — fixes BYOS "SFTP: No such file" and port-not-open failures.

### Improved
- Site publish writes all pages to the server (container or static fallback) in a single pass.

## [0.2.0-beta.13] - 2026-06-11

### Security
- Fix authenticated command injection via project env-var values in remote/local Docker deploys (shell-quote all values).
- Add missing organization-ownership checks: notification channels, marketplace deploy `serverId`, database disconnect.
- Authorize WebSocket channel subscriptions (resolve `project:`/`server:`/`database:` to the owning org).
- Add SSRF guard for health-check, notification webhook/Slack, and CMS-sync outbound fetches.
- 2FA brute-force attempt limiting; derive the rate-limit client IP from the socket (`TRUSTED_PROXY_HOPS`).
- Stripe webhooks: derive plan from the real price, make the DB the authoritative subscription→org mapping, fail dedupe closed.
- Sanitize site renderer (theme colors + block URLs); role gates on billing, database connect, domain and env-var writes.

### Fixed
- Robust deploy firewall port opening for BYOS servers — works without `sudo`/`ufw` (ufw → firewalld → iptables, root-first).

### Improved
- Strapi marketplace template auto-provisions Postgres and injects DB env (zero manual setup).
- Data-driven Site Studio template catalog with per-template themes (`sites/site-templates.ts`).

## [0.2.0-beta.12] - 2026-06-08

### Added
- **Site Editor** API: block CRUD, theme, publish to `/pushify-site/`, asset upload (SSH → container assets).
- Headless CMS bridge (Strapi/Directus URLs) and optional CMS sync on publish.
- Block types: hero, features, banner, stats, pricing, FAQ, CTA, footer; HTML renderer + default blocks.
- Migrations `0027_project_site_editor`, `0028_site_editor_theme`.
- Server terminal WebSocket (`/api/v1/servers/:id/terminal/ws`) with shell session helper.
- Deployment queue worker, scheduler, and deploy concurrency limits.
- Read-through cache helper; dashboard attention summary fields.

### Fixed
- BullMQ deploy job IDs: `deploy-{id}` (colons rejected by BullMQ — fixes Site Studio launch queue errors).

### Improved
- Site Studio launch initializes `project_site_editor` row.
- Deployment worker scheduling; metrics worker filters; SSH utilities for asset upload.

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
