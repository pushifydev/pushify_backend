# Changelog

## [0.2.0-beta.50] - 2026-07-06

### Security
- **Secrets are now masked in every log surface.** User builds routinely print env values (`console.log(process.env)`, framework error dumps, connection-string errors) — those secrets used to land verbatim in build logs, the persisted 7-day runtime logs, and live log streams. A per-project masker (built from the project's decrypted env values via a sensitive-key/long-value heuristic, plus ad-hoc secrets like git access tokens) now replaces occurrences with `••••••` at write/stream time: the deploy-log choke point (`addLog`), the log-collector's persisted chunks (10-min-cached masker), and both live SSE container streams. Multi-line values (PEM keys) are masked line-by-line; trivial values (`production`, ports…) are left alone so logs stay readable. 8 unit tests.

### Added
- **Invoice history endpoint** — `GET /api/v1/billing/invoices` lists the organization's Stripe invoices (number, date, amount, status, hosted/PDF links; last 24). Returns `[]` when Stripe isn't configured. Pairs with the dashboard's new Billing → Invoices section.

## [0.2.0-beta.49] - 2026-07-06

### Added
- **Admin event notification emails.** Set `ADMIN_NOTIFY_EMAILS` (comma-separated, multiple operators supported) and every significant platform event emails the list: **user registration**, subscription activated/canceled, payment failed, infra wallet credited, server created (managed & BYOS) / deleted / suspended for billing, project created/deleted, database created/deleted, and failed deployments — 14 instrumentation points. Delivery rides the existing **BullMQ** infrastructure (new `admin-notify` queue + worker, 3 retries with backoff) with a direct-send fallback when Redis is unset; every call site is fire-and-forget so a mail failure can never break or slow the underlying operation. Emails are a clean field-table template (HTML+text, HTML-escaped). Unset = feature off.

## [0.2.0-beta.48] - 2026-07-06

### Fixed
- **CRITICAL — hourly infra billing overcharged small servers up to ~2.5×.** The integer hourly price was derived with a double rounding (EUR→USD `round` on a sub-cent amount, then margin `ceil`): a server quoted **$5.75/mo** was actually billed **2¢/hour = $14.60/mo**, draining a month of credits in ~2 weeks and then auto-suspending the server. Billing now **accrues from the accurate MONTHLY price prorated over elapsed wall-clock time**, carrying sub-cent remainders in millicents (new `infra_billing_carry_millicents` column, migration `0034`) — the long-run total equals monthly/730 per hour exactly (unit-tested: 730 hourly ticks bill the monthly price ±1¢; restart-heavy schedules bill the same as regular ones). The displayed hourly price is now derived from the customer monthly with a single rounding, and the monthly-burn estimate uses the monthly price directly.
- **Restarting a suspended server no longer demands a full month's balance.** `start` required `customerPriceMonthlyCents` in the wallet; it now requires **72 hours of coverage** — and starting resets the billing anchor so stopped time is never billed.

### Added
- **`npm run refund:infra-overcharge`** — computes, per organization, the difference between what `server_hourly_charge` transactions actually debited and the fair monthly-rate amount (each old charge was intended to be one hour), and credits it back as an adjustment. Dry-run by default; `--apply` to execute.

## [0.2.0-beta.47] - 2026-07-06

### Added
- **SECURITY.md** — vulnerability disclosure policy (private reporting via email or GitHub's Report-a-vulnerability, 72h acknowledgement, scope notes for the deploy-isolation surface). Part of the pre-open-source hygiene pass; a repo-wide scan confirmed no secrets or personal data in tracked files.

### Changed
- README now opens with a real product screenshot (the redesigned landing hero).

## [0.2.0-beta.46] - 2026-07-05

### Added
- **Scale-to-zero (auto-sleep).** Opt-in per project: after `sleepAfterMinutes` (default 30, 5–1440) with no meaningful traffic — judged from the container's rx/tx counters in `container_metrics`, with a 500KB window threshold that swallows health-check chatter and a post-deploy/wake grace period — a 5-minute sweeper stops the container (SSH on server/runner, local fallback) and marks the project `sleeping`. **Wake on request:** generated nginx vhosts now include an `error_page 502 = @pushify_wake` fallback proxying to the new public `/api/v1/wake/:slug` endpoint, which CAS-claims the wake (exactly one starter under concurrent visitors), `docker start`s the container, and serves an auto-refreshing "Waking up…" page — genuine crashes get a branded unavailable page instead of a raw nginx 502 (fallback emitted only when `API_BASE_URL` is set). Also: authenticated `POST /projects/:id/wake` for the dashboard, health checks skip sleeping/waking apps (auto-restart would fight the sweeper), a deploy resets sleep state, and disabling auto-sleep while asleep starts the container back up. Migration `0033` adds the projects columns.

## [0.2.0-beta.45] - 2026-07-05

### Added
- **Web shell into the app container.** New WebSocket endpoint `/ws/projects/:projectId/shell` (same message protocol as the server terminal): SSHes to the server the container actually runs on — the project's assigned server **or its sticky runner** — resolves the blue/green container on the host and attaches an interactive `docker exec` (bash when the image has it, sh otherwise) over a real PTY. `SSHShellSession` gained an exec-with-PTY mode alongside the login shell. Owner/admin only, slug validated before command interpolation, shares the 50-session cap.

## [0.2.0-beta.44] - 2026-07-03

### Added
- **Project-level log search** (`GET /projects/:id/logs/search?q=&logType=&limit=`) for the dashboard's new Logs explorer: searches the persisted 7-day `container_logs` chunks (ILIKE with escaped wildcards, literal substring semantics), extracts matching lines with their chunk timestamp / stdout-stderr type / deployment id. Bounded: max 100 chunks scanned, max 1000 lines returned.

## [0.2.0-beta.43] - 2026-07-03

### Added
- **Persistent volumes for user apps.** Projects can now attach Docker **named volumes** (`pushify-vol-<slug>-<name>`) at a chosen container path — SQLite files, uploads, caches survive every redeploy. Mounts are applied on **all** container start paths: standard remote deploy (blue-green), quick rollback, and local. New `project_volumes` table (migration `0032`), REST CRUD (`/projects/:id/volumes`), validation (shell-safe names, absolute paths, `/proc`,`/sys`,`/dev`,`/etc`… mount targets denied), max 5 volumes/project. Changes take effect on the next deploy; project teardown removes the project's `pushify-vol-*` volumes.

### Fixed
- **Blue-green traffic switch no longer drops container mounts.** `completeBlueGreenSwitch` recreates the new container from `docker inspect` (image + env) but never carried over mounts — any volume (marketplace or user) would silently detach at the switch. The recreate now reads the container's volume/bind mounts and re-applies them.

## [0.2.0-beta.42] - 2026-07-03

### Added
- **Cron jobs (scheduled tasks) for user apps.** Per-project scheduled tasks with two types: **command** — a shell command executed *inside the app container* (`docker exec` over SSH on the project's server or runner, `timeout`-guarded, local fallback), and **http** — a GET to a URL (SSRF-guarded, timeout-bounded). Standard 5-field cron expressions with an IANA timezone per task (croner). New tables `scheduled_tasks` + `scheduled_task_runs` (migration `0031`): precomputed `next_run_at` claimed atomically (CAS) by a 30s worker tick so each firing runs exactly once even with multiple workers; run history keeps exit code / HTTP status / captured output (8KB cap) for 7 days. REST: list/create/update/delete, **Run now** (`POST .../run`, synchronous, recorded as `trigger=manual`), and run history. Caps: 10 tasks per project, 10–600s timeout. Full migration chain re-verified on a fresh Postgres 16.

## [0.2.0-beta.41] - 2026-07-02

### Added
- **Discord notification channel.** New `discord` channel type alongside slack/email/webhook: paste a Discord incoming-webhook URL and deployment/health events arrive as rich embeds (event color, project/branch/commit/status fields, log tail on failures, link back to the dashboard). Implemented on both delivery paths (direct send in `notification.service` with the SSRF guard, and the BullMQ `notification.worker`). Migration `0030` adds the enum value. Note: the auto-generated migration was hand-trimmed to just the enum change — the schema had drifted from the migrations dir (earlier releases used `db:push`), and the generated file would have re-added already-existing columns and broken fresh installs; the new `0029_snapshot.json` now captures the full current schema so future generates diff cleanly. Full migration chain verified against a fresh Postgres 16.

## [0.2.0-beta.40] - 2026-07-02

### Added
- **Regression tests for this week's production incidents** (25 new tests; suite now 45). Each locks in a bug that actually bit: `redis-connection.test.ts` — BullMQ must honor the DB index in `REDIS_URL` (staging/prod queue collision); `runner-routing.test.ts` — sticky runner-pool assignment, legacy env fallback, and `resolveProjectServerId` preferring the assigned server (the "Container is not running" log-stream bug); `effective-plan-limits.test.ts` — `planLimitsOverride` must reach effective limits without mutating shared plan definitions (the grant-org / disabled Create Server bug); `utils.test.ts` — `normalizeClientIp` first-IP + varchar(45) cap (the login 500 from long x-forwarded-for chains).

## [0.2.0-beta.39] - 2026-07-02

### Added
- **One-command self-hosting.** `curl -fsSL .../selfhost/install.sh | bash` now stands up the entire platform on any Docker host: it clones backend + frontend, generates secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, DB password), and starts a full stack — dashboard, API, worker, one-shot migrator, Postgres 16, Redis 7 — via `selfhost/docker-compose.yml`. New multi-stage `Dockerfile` builds a single backend image used for the API (`dist/index.js`), the worker (`dist/worker.js`) and migrations. New `src/migrate.ts` (built to `dist/migrate.js`, `npm run db:migrate:prod`) applies Drizzle SQL migrations programmatically so production doesn't need `drizzle-kit`/dev deps. Full guide in `docs/SELF_HOSTING.md` — including the deploy model: the containerized control plane has no host Docker/nginx access by design; apps deploy to servers attached over SSH (which can be the same machine), exactly like Pushify Cloud.
- README: Self-Hosting section; fixed the frontend repo link (`pushify-dev/pushify-frontend` → `pushifydev/pushify_frontend`).

## [0.2.0-beta.38] - 2026-06-28

### Fixed
- **Container logs now work for runner-deployed projects** ("Container is not running"). The log-stream endpoint decided remote-vs-local solely from `project.serverId`, so a free/unassigned project — which has no `serverId` but still deploys to a runner via sticky routing — was treated as local, looked at the control-plane's Docker, found nothing, and returned *"Container is not running."* Extracted the deploy-target resolution into `lib/runner-routing.ts` (`pickRunnerServerId` + `resolveProjectServerId = project.serverId || runner`) — the same logic the deploy worker uses — and the log stream now SSHes into the actual runner. (Other `serverId`-gated container ops, e.g. custom-domain nginx in `domain.service`, should adopt `resolveProjectServerId` too as runner usage grows.)

## [0.2.0-beta.37] - 2026-06-28

### Fixed
- **BullMQ now honors the Redis DB index in `REDIS_URL`** (e.g. `redis://host:6379/1` → db 1). The queue connection previously parsed only host/port/auth and silently dropped the db, so every environment sharing a Redis host landed on db 0 with the same static queue names (`deployments`, `notifications`, …). On a box running both staging and production, that meant a **staging worker could pick up and run a production deployment job** (and vice-versa) — which also silently broke runner routing: the staging process lacks `PUSHIFY_RUNNER_SERVER_IDS`, so it fell back to a local deploy and failed with *"Docker is not available on this machine."* Centralized the connection parsing (`lib/redis-connection.ts`) across the enqueue side and all queue workers (deployments, notifications). **To isolate environments sharing one Redis, point each at a different db** — e.g. production `…/0`, staging `…/1`.

## [0.2.0-beta.36] - 2026-06-28

### Fixed
- **Dashboard no longer rate-limits itself (429 storm).** The interactive dashboard polls logs, status and metrics, so an active session can easily exceed the free plan's 60 req/min — but that per-plan `apiRequestsPerMinute` was meant for *programmatic* API keys, not the browser. Authenticated session (JWT) traffic now uses a separate, generous per-org limit (`RATE_LIMIT_SESSION_MAX`, default **600/min**) that only guards against a runaway client loop; **API keys keep their per-plan limit** unchanged. This removes the constant 429s while managing a project (especially during a deploy) without weakening API-key tiering or anonymous/IP flood protection.

### Note
- Behind a reverse proxy (nginx), set **`TRUSTED_PROXY_HOPS=1`** in the control-plane `.env` so IP-based limiters (login/refresh) use the real client IP instead of bucketing every user under the proxy's address.

## [0.2.0-beta.35] - 2026-06-27

### Added
- **Internal/comp grant tool** (`npm run grant-org`): set an organization's `plan` and/or `planLimitsOverride` directly, without Stripe — for the operator's own org (e.g. `--servers 1` to add the platform runner) or to comp a partner. Uses the existing per-org `planLimitsOverride` (merged on top of plan limits by `getEffectivePlanLimits`), so the org keeps its real billing state but gains the granted capacity. Examples: `grant-org -- --org <id> --servers 1`, `--plan hobby`, `--override '{"servers":2,"projects":20}'`.

## [0.2.0-beta.34] - 2026-06-27

### Changed
- **Runner is now a pool, not a single server.** `PUSHIFY_RUNNER_SERVER_IDS` (comma-separated `servers` row ids) defines a pool of dedicated runner hosts that free/unassigned deploys land on; a project is **stickily and deterministically** mapped to one runner by its id, so its redeploys always go to the same host (its subdomain/state stay put) while projects spread across the pool. Scales to N runners by just adding ids — no code change. The single `PUSHIFY_RUNNER_SERVER_ID` from beta.33 is still honored as a one-runner pool. (Note: actually serving 2+ runners also needs per-app DNS so `<app>.pushify.dev` resolves to that app's runner — a wildcard A record only points at one host; that piece comes when the 2nd runner is added.)

## [0.2.0-beta.33] - 2026-06-27

### Added
- **Free/unassigned deploys can target a dedicated runner server** instead of running on the control-plane host. New `PUSHIFY_RUNNER_SERVER_ID` env (a `servers` row id): when a project has no user-assigned `serverId`, the deploy now lands on that runner over SSH (same remote path as a user's own server) — keeping untrusted free-tier workloads off the box that runs pushify.dev + the API + the platform database. If unset, behavior is unchanged (deploys fall back to the local host). The deploy-target resolution (`deployTargetServerId = project.serverId || PUSHIFY_RUNNER_SERVER_ID`) is applied across the standard, static-site, blue-green and quick-rollback paths; per-project server assignment, cleanup and GC still key off the user's real `serverId`.

## [0.2.0-beta.32] - 2026-06-27

### Changed
- Hardened the domain → port resolution (from beta.31) so it can't drift on any deploy path. `resolveProjectPort` now uses the **actual host port recorded on the most recent deployment** as the source of truth (every deploy path — blue-green, marketplace, quick-rollback — records the real port it published on), falling back to the `PORT` env and then the assigned port only if no deployment port is available. This also covers the edge case of a marketplace app with a manually-set `PORT` plus a custom domain.

## [0.2.0-beta.31] - 2026-06-27

### Fixed
- **Custom domains no longer 502 when the app uses a custom `PORT`.** A deploy publishes the app on the project's `PORT` env value when set (e.g. `1367`), but the domain → Nginx setup derived the proxy target from the *assigned* port (`getOrAssignPort`) instead, so the vhost proxied to the wrong port and returned 502 even though the app was reachable on its real port. Domain verification and the apply-settings path now resolve the app's actual published port the same way the deploy does (PORT env first, assigned port as fallback) via a shared `resolveProjectPort` helper.

## [0.2.0-beta.30] - 2026-06-27

### Fixed
- **Apps can now reach a Pushify-managed database by its container name.** A standalone database (`pushify-db-<name>`) runs on the default bridge network, where Docker provides no name resolution — so a deployed app connecting to `pushify-db-<name>` failed with `ENOTFOUND`, and there was no reliable host to use instead. Every remote deploy (standard, blue-green, and quick-rollback) now joins the app and all `pushify-db-*` containers to a shared `pushify` Docker network, so the app reaches its database by container name with no host/IP guessing. Scoped to servers that actually have Pushify databases (i.e. the user's own server) — the shared host is unaffected. The database's public-port choice is untouched (still the user's decision); this only adds private app↔database connectivity.

## [0.2.0-beta.29] - 2026-06-26

### Added
- **Automatic GC of orphaned deployments on the shared host.** When a project is moved to a user's own server (or deleted), its container/images can linger on the shared Pushify host and waste disk. A new periodic sweep (`gcOrphanedLocalDeployments`, every 30 min from the background workers) tears down any local `pushify-<slug>` deployment whose project no longer belongs there — safe by construction: it only acts on projects that have a remote `serverId` (so they must not have a local deployment) or are deleted, matched by exact name. Also runnable on demand with `npm run gc:orphans`.

### Changed
- The teardown script (`buildRemoteTeardownScript`, used by project delete, server-move cleanup, and the new GC) now also **removes the project's built images** (`pushify/<slug>*`), not just the containers/vhost/dir — so cleanups actually reclaim the disk that images consume.

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
