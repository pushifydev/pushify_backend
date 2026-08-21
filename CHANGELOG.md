# Changelog

## [0.2.0-beta.62] - 2026-08-21

### Added
- **Database Studio — a data browser for managed PostgreSQL/MySQL databases.** New endpoints under `/databases/:id/studio`: `GET /tables` (tables and views with row estimates, size and primary-key info), `GET /rows` (paged, sortable, filterable rows for one table), `POST/PATCH /rows` and `POST /rows/delete` (row insert / update / bulk delete, always addressed by primary key), and `POST /query` (SQL console). Queries reach the database the same way the rest of the database service does — SSH to the server, then `docker exec` the engine's own client — so nothing has to be exposed to the network. Owner/admin only; API keys need `databases:read`, and `databases:write` for writes.
- **Schema editing from the studio.** `POST /studio/tables` (create), `DELETE /studio/tables` (drop table or view), `POST /studio/tables/truncate`, `POST /studio/tables/rename`, `POST /studio/columns` (add) and `DELETE /studio/columns` (drop). Column types cannot be catalog-checked the way names can — they do not exist yet — so every type token comes from a per-engine allowlist and only the matched token is emitted; lengths and scales must be integers in range; defaults are quoted literals unless they match a short allowlist of expressions (`now()`, `CURRENT_TIMESTAMP`, `gen_random_uuid()`, `uuid()`, …). Auto-increment maps to `serial`/`bigserial` on Postgres and to `AUTO_INCREMENT` (primary key required) on MySQL. Every schema change is logged as `database.schema_changed` (migration `0042`). 19 unit tests on the DDL renderer.
- **GitHub App: repository access that outlives the person who set it up.** Every deploy used to borrow the organisation *owner's* personal OAuth token, with the `repo` scope over every repository that person could reach — so the owner leaving, revoking the grant or rotating the token stopped every project in the organisation. Now an installation (`github_app_installations`, migration `0044`) is the credential: it belongs to the GitHub account, covers only the repositories that account picked, and is never stored as a long-lived token — `lib/github-app-auth.ts` signs a short app JWT and mints one-hour installation tokens on demand, cached with a five-minute refresh margin (16 tests, including the PKCS#1 key GitHub hands out and the escaped newlines a `.env` produces). New endpoints: `GET /integrations/github/app/install-url`, `POST /integrations/github/app/setup`, `GET /integrations/github/app/installations[/:id/repositories]`, and one webhook at `POST /webhooks/github/app` that keeps installations in sync and fans push/pull_request events out to every project tracking that repository.
- **Both paths run side by side.** The token resolver prefers an installation and falls back to the owner's OAuth token, so projects connected before the App keep deploying untouched. The App path is tried *before* the owner lookup, which is what makes it survive the case OAuth cannot. A repository the App now covers makes the legacy per-repo webhook stand down, so a migrated project cannot deploy twice from one push. 10 tests on the resolver.
- **The OAuth app is identity-only once an App is configured** — the requested scope drops from `repo read:user user:email` to `read:user user:email`. Deployments without an App keep the old scope, so nothing breaks for them.
- **Push and pull-request handling extracted** to `lib/github-deploy-trigger.ts` so the per-project route and the App endpoint run the same code instead of two copies that drift.
- **Data-browser permissions.** `organization_members.studio_access` (`none` | `read` | `write`, migration `0043`) with `PUT /organizations/members/:userId/studio-access`. Owners and admins keep full access by virtue of their role; everyone else defaults to none, so nothing changes for an organisation that does not opt in. A read grant browses tables, rows, indexes, diagnostics and read-only console queries; every write — row edits, DDL, imports, write-mode queries, cancels — needs a write grant. `listTables` reports the caller's level so the UI can hide what would 403. **26 access-control tests** with the repositories and SSH mocked (role gate, cross-organisation 404, engine gate, container state, read-vs-write split) plus 6 on the API-key scope middleware.
- **Query cancellation.** `POST /studio/cancel` stops a running statement — `pg_cancel_backend` scoped to the current database, or an ownership check followed by `KILL QUERY` on MySQL. Cancelling something that already finished reports that, rather than failing.
- **SSH connection pooling rolled out.** The pool had existed for a long time but only the studio used it; 12 short, frequent operations across metrics, log collection, app-sleep, usage metering, health scans, container resolution and remote cleanup now reuse a pooled connection instead of paying a fresh handshake (~250-500ms) every time. Deployments, backups, server provisioning, certbot and user cron keep their own connection: they run long or stream for minutes, and OpenSSH caps concurrent channels per connection. A pooled client now ignores `disconnect()` from its callers — the pool's reaper owns the lifecycle — so a shared connection can never be closed out from under another caller.
- **`npm run lint` works again.** The backend had ESLint 9 installed but no config file at all, so linting never ran. Added a flat config (typescript-eslint, non-type-checked so it stays fast) and cleared what it found: 33 pieces of dead code removed (unused imports, unused bindings whose calls were kept, two unreferenced private functions), a lexical declaration escaped from a `case` arm, `catch {}` on shutdown paths allowed, and control-character regexes permitted since sanitisation is exactly what they do. 69 errors → 0; the 28 remaining `any` uses are warnings so new ones still surface.
- **Studio engine layer extracted and tested against real databases.** The SQL the studio generates, the command that carries it and the parsing of what comes back now live in `lib/studio-sql.ts` / `lib/studio-nosql.ts` — pure modules with no SSH, database or HTTP — leaving the services to own auth, sessions and orchestration (`database-studio.service.ts` 1635 → ~1150 lines, sessions shared via `studio-session.service.ts`). On top of that: **50 integration tests** (`npm run test:studio`) that boot real PostgreSQL 16, MySQL 8.0, MongoDB 7 and Redis 7 containers and run the exact command production sends, with only the SSH hop replaced. They already earned their keep — they caught mongosh returning a REPL prompt instead of script output (every Mongo call would have failed in production) and an envelope parser that broke on any payload containing an `ok` field. Plus 60 new unit tests on the builders and parsers. Backend suite: 198 unit tests, 50 integration.
- **Index management and query diagnostics.** `GET/POST/DELETE /studio/indexes` lists, creates and drops indexes (method from a per-engine allowlist, columns checked against the table, the primary key refused), and `GET /studio/performance` reports the slowest statements (`pg_stat_statements` / `performance_schema`) and what is running right now — an unavailable statistics source is reported to the UI, never thrown.
- **MongoDB and Redis studios.** New `/studio/mongo/*` (collections, paged documents with a user-supplied filter and sort, insert/replace/delete by `_id`, create/drop collection) and `/studio/redis/*` (cursor SCAN with pattern, per-type value preview, TTL, string edit, bulk delete). Each engine gets its own injection defence: for Mongo every piece of user input enters the script as a `JSON.stringify` string literal parsed with `EJSON.parse`, so it is data and never code; for Redis the Lua program is fixed and every value is hex-encoded into ARGV and decoded inside Lua, which is also what makes binary keys and values survive the round trip.
- **CSV import.** `POST /studio/import` appends a batch of rows (max 500 per request, client loops for progress) with every cell escaped exactly like a hand-edited value; empty cells become NULL unless the caller opts out.
- **SQL console became a real console.** `GET /studio/schema` returns every table with its columns in one round trip (the editor's autocomplete source, capped at 500 tables); `POST /studio/query` takes a `maxRows` ceiling and now reports the statement's `command` and, where the engine tells us, the number of rows it `affected` (psql's command tag; `ROW_COUNT()` on MySQL); and `POST /studio/query/export` streams a query's full result as CSV or JSON, always read-only, up to 20k rows. CSV writing is RFC 4180 (5 unit tests).
- **Studio latency work — the transport was the cost, not the SQL.** Every request used to pay a fresh SSH handshake (~250-500ms) plus a `docker exec` spawn (~150-400ms) for a query that runs in single-digit milliseconds, and reading rows paid the exec twice because the catalog lookup was its own round trip. Now: the studio uses the existing `getSSHConnection` pool instead of dialling a new connection each time (a pooled connection that died between requests is re-acquired *before* sending, never retried after, so a write can't apply twice); resolved table schemas are cached for 60s and invalidated by our own DDL, which takes paging/sorting/filtering down to one round trip; and unfiltered row counts stop at 10k and fall back to the planner's estimate (`reltuples` / `TABLE_ROWS`, flagged as `totalEstimated`) so a large table is never scanned to draw a page number.
- **Safety rails on the studio.** The SQL script is base64'd onto the client's stdin (the shell never sees user input); identifiers are resolved against the live catalog before they can appear in a statement; literals are escaped with the session pinned to a known escaping mode (`standard_conforming_strings` on / `NO_BACKSLASH_ESCAPES` off). Tables without a primary key and views are read-only, binary columns are preview-only, and every read runs in a read-only transaction. The console is read-only unless the caller explicitly opts into write mode, in which case read mode accepts a single read statement only. Statement timeout 20s, output capped, row counts capped at 100k, console results capped at 500 rows. Row edits and every console query land in the activity log (`database.data_modified`, `database.query_executed`, migration `0041`). 18 unit tests on the escaping and statement-classification rules.

## [0.2.0-beta.60] - 2026-07-20

### Added
- **Config-as-code: `pushify.yaml`.** A file at the repo root (or the project's root directory) now declares build & runtime settings and wins over dashboard values when present — the repo becomes the source of truth: `build`, `install`, `start`, `output`, `port`, `framework`, plus declared **cron jobs** (name/schedule/command/timezone, validated with the same cron/timezone rules as the UI) and **volumes** (name/path, same shell-safety validation). Cron and volume declarations sync on production deploys as **upsert-only** — removing an entry from the file never deletes data; the dashboard stays authoritative for removals. A malformed file is reported in the deploy log and ignored — it can never break a deploy. Applied on both the remote and local deploy paths; volume declarations take effect in the same deploy. 7 parser tests.

### Changed
- **Install cache now covers yarn and pnpm too** — the BuildKit cache mounts (npm + framework caches shipped earlier) gain yarn/pnpm store targets, so custom install commands hit a warm cache as well.

## [0.2.0-beta.59] - 2026-07-19

### Added
- **Notification preferences are now real.** They lived only in the browser's localStorage — the backend never saw them. New `users.notification_prefs` (migration `0038`) with `GET/PUT /auth/me/notification-prefs`, which also exposes the onboarding-email opt-out as a toggle. Two preferences gained actual consumers immediately: **securityAlerts** now gates the new-device sign-in email, and **weeklyDigest** powers a brand-new **weekly digest worker** — Mondays (UTC), opt-in only, real per-organization numbers (deployments and failures this week, active projects, running servers, credit balance), atomic per-week dedupe, and skipped entirely when there is nothing to report. `deploymentAlerts`/`productUpdates` are stored and ready for their future senders.

## [0.2.0-beta.58] - 2026-07-19

### Added
- **Onboarding email sequence (state-driven, not a dumb timer).** A new hourly worker walks organizations created in the last 30 days and sends at most one lifecycle email per state: ~day 1 "deploy your first app" (only if they haven't), ~day 3 either "need a hand?" (still no deploy) or "connect a domain" (deployed, no custom domain), day 7 "add a database" (deployed, no DB). Each email links a **signed unsubscribe URL** (`GET /auth/unsubscribe-onboarding?token=`) that sets a per-user opt-out honored by the whole sequence; sends are claimed atomically in a new `onboarding_emails` table (unique per org+email) so concurrent sweeps can never double-send, and failed sends retry next sweep. The 30-day cap guarantees existing users are never spammed at rollout. Migration `0038`* — tables `onboarding_emails`, `cancellation_feedback`, column `users.onboarding_emails_opt_out`. 6 unit tests on the state machine.
- **Cancellation exit survey** — `POST /billing/cancellation-feedback` records a one-question reason (`too_expensive | missing_features | bugs | switched | project_ended | other` + optional comment) and notifies the operator (`feedback.cancellation` admin event). Never blocks the cancel flow.

*migration file is `0037_onboarding_and_feedback`.

## [0.2.0-beta.57] - 2026-07-19

### Fixed
- **OAuth (Google/GitHub) accounts can now manage 2FA and set a password.** Accounts without a password hit dead ends on every password-confirmation flow. Now: `/auth/me` exposes `hasPassword`; disabling 2FA and regenerating backup codes accept **either** the account password **or** (for passwordless accounts) a current authenticator/backup code via the shared re-auth guard; and `/auth/me/change-password` lets a passwordless account set its **first** password without `currentPassword` (the authenticated session is the proof) — password accounts still verify the current password and the not-same-as-old rule.
- **2FA disable/backup-code regeneration was broken for everyone**: the password check passed its arguments to `verifyPassword` in the wrong order, so the correct password always failed verification. Fixed alongside the guard rework.

## [0.2.0-beta.56] - 2026-07-19

### Added
- **Full domain management for sold domains.** Customers' domains live in Pushify's reseller account, so the platform is their only control panel — this release makes it a complete one:
  - **DNS records** — list/create/update/delete A, AAAA, CNAME, MX, TXT, SRV, NS records (host/TTL/priority validation) via `/domains/:domain/dns`.
  - **Domain transfer-in** — `GET /domains/transfer/quote` prices a transfer at the TLD's renewal rate (probed live from the registrar); `POST /domains/transfer` charges the wallet, starts the transfer with the auth/EPP code (refund if it fails to start), and records it as `transfer_pending` (migration `0036`). The renewal worker now also polls in-flight transfers every sweep: completed → domain becomes active with its real expiry; cancelled/rejected → **automatic refund** + status `transfer_failed`. Start/result emails (EN/TR) + operator events.
  - **Transfer-out (ICANN compliance)** — `POST /domains/:domain/auth-code` unlocks the domain and returns its EPP code so users can leave freely; viewing it triggers a **security notice email** to the owner and an operator event.
  - **Registrar lock toggle** and **custom nameservers** (2-6, validated) — point a domain at Cloudflare or any external DNS.
  - **Email forwarding** — `info@yourdomain.com → anywhere` aliases (list/create/delete).
  - **Public availability search** — `GET /domains/public-search` (no auth, 10 req/min/IP) to power a marketing domain-search page.

## [0.2.0-beta.55] - 2026-07-19

### Added
- **Multi-year domain registration (1–5 years).** `POST /domains/purchase` and the new quote logic accept a `years` term; the total is priced as year-1 registration + (years−1) renewals on both the wholesale and retail side, so multi-year never undercuts cost. Term is stored per domain and reflected in emails/admin events.
- **Post-redirect purchase confirm** — `POST /domains/purchase/confirm` fulfills a paid checkout session directly when the user returns from Stripe (org-verified, idempotent with the webhook per session id), so domains register instantly even before the webhook lands — and local/dev setups work without `stripe listen`.
- **Pay by card when credits don't cover a domain.** New `POST /domains/purchase/checkout` creates a Stripe Checkout session for the exact quoted amount; on `checkout.session.completed` the webhook credits the wallet with the paid amount (idempotent per session id) and registers the domain through the normal purchase path. If registration fails after payment, the paid amount **stays as wallet credit** (never lost) and the operator is notified.

## [0.2.0-beta.54] - 2026-07-18

### Added
- **Domain sales (registrar reseller integration).** Users can now search, buy, and auto-connect custom domains without leaving Pushify:
  - **Registrar adapter layer** (`REGISTRAR_PROVIDER=namecom` + `NAMECOM_USERNAME`/`NAMECOM_TOKEN`, optional `NAMECOM_API_URL` for name.com's test environment). The adapter interface is provider-agnostic so higher-volume wholesalers (OpenSRS/CentralNic) can be added later without touching the product layer. Unset = feature hidden everywhere.
  - **Retail pricing with margin** — wholesale price + `DOMAIN_MARGIN_PERCENT` (default 20%), rounded up to a x.49/x.99 ending, never below cost; `DOMAIN_MAX_PRICE_CENTS` (default $300) and a premium-domain block guard against expensive surprises.
  - **API**: `GET /api/v1/domains/config` (feature discovery), `GET /domains/search?q=` (availability + retail prices across 10 popular TLDs), `POST /domains/purchase`, `GET /domains`, `PATCH /domains/:domain/auto-renew`.
  - **Payment from infra credits**: purchase debits the wallet (new `domain_purchase`/`domain_renewal` transaction types); the charge is taken first and **automatically refunded if registration fails**. WHOIS privacy is enabled on registration.
  - **Auto-connect to a project**: optional `projectId` creates apex A + www CNAME records at the registrar pointing at the project's server and registers the domain on the project (existing verify → nginx → SSL flow takes over). Best-effort — a DNS/attach hiccup never voids the purchase.
  - **Renewal worker** (12h sweep): domains expiring within 30 days auto-renew from the wallet at the registrar's live renewal price (falls back to the price captured at purchase), refund on failure; insufficient credits / auto-renew-off / failures send the owner a reminder email (throttled to one per 7 days); past-expiry domains are marked expired. New tables: `purchased_domains` (migration `0035`).
  - **Emails + admin events**: purchase/renewal confirmations and renewal reminders (EN/TR); `domain.purchased`, `domain.renewed`, `domain.renewal_failed` operator notifications.

## [0.2.0-beta.53] - 2026-07-14

### Fixed
- **Public port no longer changes on every compose-stack redeploy.** Marketplace stacks (Supabase, Cal.com, Appwrite…) re-scanned for a "free" port on each deploy while the previous stack was still running — so the stack saw its own port as busy and shifted to a new port (and a new URL) every redeploy. The port is now **sticky**: the server-side port registry (and, for stacks deployed before this fix, the `PUSHIFY_PUBLIC_PORT` recorded in the stack's `.env`) is reused as long as the project's own containers hold the port or it is otherwise free; a brand-new port is picked only on first deploy or if another process took the old one while the stack was down.
- **New port assignments now avoid every genuinely busy port.** The used-port scan only matched `127.0.0.1:` Docker bindings, but app containers publish on `0.0.0.0` — so the scan saw almost nothing, and host daemons (user services, databases) weren't checked at all. Assignment now skips all Docker-published host ports **and** all host TCP listeners, and a registry entry squatted by a foreign process is released and reassigned instead of producing a doomed `docker run`. Ownership checks are exact (`pushify-<slug>`, its `-blue`/`-green` variants, or the compose project label) so project `app` can never claim `app-2`'s port. 6 unit tests.

## [0.2.0-beta.52] - 2026-07-14

### Fixed
- **Custom env vars now reach Supabase (and other compose) containers.** Adding e.g. `GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK` in a Supabase project's Environment tab wrote it to the stack's `.env`, but Docker Compose only injects variables explicitly listed under a service's `environment:` — so the value never appeared inside the GoTrue container. Marketplace templates can now declare `envPassthrough` (service → env-key prefixes); at deploy time a `docker-compose.override.yml` is generated that forwards matching user vars to the right service (user values win over template defaults on collision; stale overrides are removed). The Supabase template forwards `GOTRUE_*` → `auth` and `PGRST_*` → `rest`, unlocking all GoTrue/PostgREST tuning knobs. Redeploy required after changing env vars, as before. 5 unit tests.

## [0.2.0-beta.51] - 2026-07-06

### Changed
- **Payment confirmation emails now link to the invoice/receipt.** The "plan activated" email includes the Stripe **hosted invoice** link (resolved from the checkout session's invoice) and the "credits added" email includes the Stripe **receipt** link (resolved from the payment intent's charge) — both best-effort: if Stripe lookup fails, the email still goes out without the link. Complements Stripe's native customer receipt/invoice emails (enabled in the dashboard) without duplicating them.

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
