# Changelog

## [0.2.0-beta.28] - 2026-06-26

### Fixed
- **Projects on a user's own server no longer try to use a `*.pushify.dev` subdomain.** A `*.pushify.dev` auto-subdomain only works on Pushify's shared host (where the wildcard cert lives and the `*.pushify.dev` DNS points). When a project that was created on the shared host got moved to the user's own server, the deploy still tried to configure that same subdomain on the user's server — which failed (`nginx -t`: wildcard cert not present) and was conceptually wrong (the subdomain resolves to Pushify's host, not the user's server). Both remote-deploy paths (standard + blue-green) now check whether the **target** server actually has the wildcard cert; if a carried-over auto-subdomain isn't usable there, the auto-generated domain record is removed and the project is served over the server's IP (`http://<ip>:<port>`) instead. A user's own server only gets a public domain when they add their own (which then gets a real per-domain Let's Encrypt cert).

## [0.2.0-beta.27] - 2026-06-26

### Fixed
- **Moving a project to a different server now tears down the old host.** Changing a project's deployment server (local→server, server→server, or server→local) only updated `serverId` — the old container/images kept running on the previous host (e.g. the shared Pushify server), wasting resources and potentially still answering on the old subdomain. `updateProject` now detects a server change and runs the existing best-effort cleanup (`cleanupProjectContainers`) against the **previous** host (using the pre-update snapshot) so the old deployment is removed; the next deploy lands on the new server. (Reminder: assigning a server still requires it to be `running` + setup `completed`, otherwise the assignment is rejected and the project stays where it is.)

## [0.2.0-beta.26] - 2026-06-26

### Fixed
- **Auto-subdomain Nginx config now points to the actual wildcard cert.** The `*.pushify.dev` vhost hardcoded its certificate path from `PREVIEW_BASE_URL` (`/etc/letsencrypt/live/<base>/`), ignoring `WILDCARD_SSL_PATH`. When the wildcard cert lives under a different lineage name (e.g. the apex `pushify.dev` cert already owns `/etc/letsencrypt/live/pushify.dev`, so the wildcard is at `.../pushify.dev-0001`), Nginx looked for a cert that wasn't there → `cannot load certificate ... No such file` → `nginx -t` failed → the config was never applied. `generateAutoSubdomainSiteConfig` now uses `WILDCARD_SSL_PATH` when set (falling back to the base-domain path), matching the deploy workers' existing resolution. Set `WILDCARD_SSL_PATH` to the wildcard's live dir.

## [0.2.0-beta.25] - 2026-06-26

### Fixed
- **Login no longer 500s behind a proxy chain** (`value too long for type character varying(45)`). The client IP was taken straight from the `x-forwarded-for` header and written to the `ip_address varchar(45)` column — but behind multiple proxies (nginx/Cloudflare) that header is a comma-separated list of IPs that overflows 45 chars, which threw on session creation and broke every login (password + Google/GitHub OAuth). Added a shared `normalizeClientIp()` that keeps only the first (client) IP and caps it to 45 chars, applied at session creation and activity logging. Not data/Postgres related — purely the header length.

## [0.2.0-beta.24] - 2026-06-26

### Fixed
- **Servers no longer get stuck at setup `installing` after they're running.** The reconciliation sweep now also covers the *setup* stage, not just provisioning: for managed servers that reached `running` but whose `setupStatus` is still `pending`/`installing` (e.g. the one-shot `server-setup` poll job died on a worker restart, even though the server's `/health` is up), the sweep re-checks `http://<ip>/health` every 30s and marks the server `completed` (sending the server-ready email) once it responds — or `failed` only after a generous 30-minute deadline. This closes the same silent-stuck gap on the setup stage that beta.23 closed on provisioning. `npm run requeue:stuck-servers` (which runs the sweep) recovers any already-stuck servers immediately.

## [0.2.0-beta.23] - 2026-06-26

### Fixed
- **Managed servers no longer get stuck at "Provisioning" forever.** The one-shot `server-status` poll job only retries for ~5 minutes; if the VM reaches `running` on the provider later than that (slow boot, or the worker process restarted mid-poll), the job exhausted and gave up silently — leaving the server stuck at `provisioning` even though the VM was actually running. Added an independent **provisioning reconciliation sweep** (`reconcileProvisioningServers`, runs every 30s from the background workers) that re-checks every server still stuck at `provisioning` and drives it forward: promotes it to `running` and hands off to setup as soon as the provider reports it ready (idempotent — the fixed setup `jobId` de-dupes), or marks it `error` with a clear retryable message if the provider errored or it's been provisioning past a 20-minute deadline (no more silent dead-ends). The existing poll/setup workers are unchanged — this is a safety net.
- Added `scripts/requeue-stuck-servers.ts` (`npm run requeue:stuck-servers`) to immediately recover any servers already stuck at `provisioning` (or `running` with setup still pending).

### Fixed
- **Storage quota no longer unfairly blocks deploys** ("Monthly storage limit reached"). Three compounding bugs are fixed:
  - **Enforcement rounded any usage up to a full GB.** The check compared `ceil(bytes / GB) >= limit`, so a free org (1 GB) was blocked the moment *any* storage was recorded. It now compares real bytes against `limit × GB`.
  - **Per-deploy cumulative inflation.** Each deploy added its image size to a running "peak" that never decreased (even though only the last 5 images are kept on disk), so redeploys eventually tripped the limit. Storage is no longer metered by cumulative deploy size.
  - **Whole-host over-counting on shared hosts.** Storage was measured as the entire host's docker disk and attributed to *every* org on it. It's now measured per-org as the footprint of that org's own project images (`pushify/<slug>`), so co-tenants aren't charged for each other's images or for build cache.
- Free-tier storage allowance raised from 1 GB to 5 GB.
- Added `scripts/reset-storage-usage.ts` (`npm run reset:storage-usage [-- --org <id>]`) to clear the previously-inflated current-period peaks; the next disk sync re-records the correct per-org footprint.

## [0.2.0-beta.21] - 2026-06-25

### Security
- **OAuth login no longer bypasses two-factor authentication.** Google and GitHub sign-in issued a full session immediately, ignoring the account's `twoFactorEnabled` flag — so a user who had enabled 2FA (or whose email/password account got linked to an OAuth identity) could log in without the second factor. `googleLogin`/`githubLogin` now apply the same 2FA gate as password login: when 2FA is enabled they return a short-lived `requiresTwoFactor` challenge instead of tokens, and the client completes via the existing `POST /auth/login/2fa`. No full session is created until the second factor is verified.

## [0.2.0-beta.20] - 2026-06-25

### Changed
- **Transactional emails are now light-themed** ("Clean Pro"), matching the dashboard light mode. Flipped the shared `email-templates.ts` palette (light canvas/card, dark text, indigo `#6366f1` button) and replaced the hardcoded near-white emphasis (`#fafafa`) with dark `#18181b` so bold text is readable on light cards. Deployment/health status accents (green/red/gray) are unchanged.

### Added
- **Six new account & security emails**, all bilingual (EN/TR), sent fire-and-forget so a mail failure never breaks the underlying flow:
  - **Welcome** — on registration (alongside email verification), with a button to the dashboard.
  - **Password changed** — confirmation after a successful password change, with a security note and reset link.
  - **2FA enabled / 2FA disabled** — security confirmations wired into the two-factor enable/disable flow.
  - **Server ready** — sent when a managed server finishes setup (both the managed-server setup worker and the BYOS path), deep-linking to the server.
  - **New sign-in** — alert when an account is accessed from a new device. Only fires when the user has prior sessions and none used the same user-agent (no spam on first login or known devices); password-login sessions now also store IP/user-agent to power this detection.

## [0.2.0-beta.19] - 2026-06-24

### Added
- Workspace switching for multi-org users. New `GET /organizations/mine` (lists every org the user belongs to, with their role) and `POST /organizations/switch` (verifies membership, then re-issues a token pair scoped to the target org). This is what lets an invited team member actually reach the inviting org's projects/servers — previously their session stayed locked to their personal org.

## [0.2.0-beta.18] - 2026-06-24

### Fixed
- Included compute credit is now sized **dynamically** to the cheapest plan-eligible server's *current* monthly price (live Hetzner + dynamic FX, plus headroom), capped at a per-plan ceiling — instead of a fixed amount that could fall just short of the wallet threshold required to start a server as FX / IPv4 prices moved. Fixes paying customers being unable to start their entry server despite the credit having been granted. `includedInfraCreditCents` is now the **ceiling**, not the exact grant; new `getCheapestEligibleMonthlyCents()` and `computeIncludedCreditTargetCents()`. The backfill script reuses the same dynamic target (`--dry-run` reports it).

## [0.2.0-beta.17] - 2026-06-24

### Added
- **Included compute credit per plan**: paid plans now bundle a monthly managed-infra allowance (Hobby ~$6.50, Pro ~$18, Business ~$45) so a paying customer can start their entry server without a separate top-up. Credit is granted on every paid invoice (initial checkout + renewals) by topping the infra wallet **up to** the plan allowance — never above it. New `includedInfraCreditCents` field on each plan and `infraBillingService.grantIncludedInfraCredit()`.

### Notes
- Loss-prevention by design: each allowance is kept below the plan's net margin; the grant never over-credits (a customer who already holds ≥ the allowance gets nothing) and is idempotent across webhook retries; and the existing "wallet hits 0 → suspend server" backstop still caps provider spend at what the customer funded.
- Bundled grants are recorded as `credit_topup` ledger entries tagged `metadata.bundled = true` (no schema migration required).
- Backfill for customers who subscribed before this release: `npm run backfill:infra-credit` (add `-- --dry-run` to preview). Idempotent — only tops up organizations still below their plan allowance.

## [0.2.0-beta.16] - 2026-06-24

### Fixed
- Billing checkout no longer returns a 500 (`No such customer`) when an organization carries a Stripe customer ID created in a different mode — e.g. a leftover **test-mode** customer after switching to live keys. `getOrCreateCustomer` now verifies the stored customer exists in the current Stripe mode and transparently recreates it if it is missing or deleted.

## [0.2.0-beta.15] - 2026-06-24

### Improved
- Managed-infra billing now uses a **live EUR→USD exchange rate** (ECB via Frankfurter, cached in-memory with a 12h refresh) instead of a hardcoded `1.08`, so a strengthening EUR no longer erodes the infra margin. Pricing reads the cached rate synchronously (never blocks on the network); on fetch failure it falls back to the configured floor.

### Added
- `INFRA_FX_BUFFER_PERCENT` (default `2`) — safety buffer % applied on top of the live FX rate to absorb intraday swings.
- `INFRA_PROVIDER_SURCHARGE_EUR` (default `0`) — flat per-server surcharge in EUR added before margin to cover provider extras like IPv4 (~`0.50`).

### Changed
- `INFRA_EUR_TO_USD_RATE` is now the fallback/floor rate (used only when the live FX fetch fails or returns a lower value), not the primary conversion rate.

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
