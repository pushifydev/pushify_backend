# Self-Hosting Pushify

Run the whole Pushify platform — dashboard, API, deploy worker, Postgres and Redis — on your own
machine with Docker. One command:

```bash
curl -fsSL https://raw.githubusercontent.com/pushifydev/pushify_backend/master/selfhost/install.sh | bash
```

When it finishes, open `http://<your-server>:3000`, create your account, and you have your own
Pushify.

## Requirements

- Linux server (2 GB RAM minimum, 4 GB recommended), or macOS for local evaluation
- Docker Engine 24+ with the Compose v2 plugin
- `git`, `curl`, `openssl` (present on virtually every distro)

## What the installer does

1. Clones `pushify_backend` and `pushify_frontend` into `./pushify/` (override with `PUSHIFY_DIR`).
2. Generates `.env` with random secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, DB password) and your
   server's public address.
3. Builds the Docker images and starts the stack:

| Service | Image | Role |
|---|---|---|
| `frontend` | Next.js standalone | Dashboard on port **3000** |
| `api` | Node 22 | REST API + WebSockets on port **4000** |
| `worker` | same image | Builds & deploys, metrics, backups, notifications |
| `migrate` | same image | One-shot schema migration on every start |
| `postgres` | postgres:16 | Platform database (persistent volume `pgdata`) |
| `redis` | redis:7 | Queues, rate limits, cache (volume `redisdata`) |

Re-running the installer updates the code and rebuilds; your `.env` and data volumes are kept.

## How deploys work when self-hosted

The control plane runs in containers and deliberately has **no access to the host's Docker or
nginx**. Applications deploy to **servers you attach over SSH** — exactly how Pushify Cloud
works:

1. Dashboard → **Servers → Add existing server** (BYOS).
2. Enter the server's IP + root SSH credentials. **This can be the same machine** the control
   plane runs on, or any other VPS.
3. Pushify installs Docker + nginx on it automatically and runs all builds, containers, vhosts
   and SSL certificates there.

This keeps untrusted app builds isolated from the platform itself — one server or many, same
model.

## Configuration

Everything lives in `pushify/.env`. Required values are generated for you; optional integrations
(all disabled until set — see `selfhost/.env.example` and `pushify_backend/.env.example` for the
full catalog):

- `GMAIL_USER` / `GMAIL_APP_PASSWORD` — email notifications & verification mails
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` — GitHub sign-in (and repo
  access when no GitHub App is configured)
- `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_WEBHOOK_SECRET` —
  the GitHub App used for repository access (see below)
- `HETZNER_API_TOKEN` — one-click managed server provisioning (BYOS works without it)
- `ANTHROPIC_API_KEY` — the AI assistant

Apply changes with `docker compose up -d`. **Exception:** `PUSHIFY_API_URL` is baked into the
dashboard at build time — after changing it run `docker compose build frontend && docker compose up -d`.

### GitHub App (recommended for repository access)

Without an App, Pushify clones with the OAuth token of whoever owns the organisation — which
means the `repo` scope over **every** repository that person can reach, and deploys that stop
working the day they leave or revoke the grant. A GitHub App fixes both: access belongs to the
GitHub account, is limited to the repositories you pick, and is never stored as a long-lived
token.

Create one at **Settings → Developer settings → GitHub Apps → New GitHub App**:

| Field | Value |
| --- | --- |
| Homepage URL | your `PUSHIFY_FRONTEND_URL` |
| Callback URL | `<PUSHIFY_FRONTEND_URL>/auth/github/app-setup` |
| Setup URL | `<PUSHIFY_FRONTEND_URL>/auth/github/app-setup` (tick *Redirect on update*) |
| Webhook URL | `<PUSHIFY_API_URL>/api/v1/webhooks/github/app` |
| Webhook secret | any random string — put the same value in `GITHUB_APP_WEBHOOK_SECRET` |

Repository permissions: **Contents** read-only, **Metadata** read-only, **Pull requests**
read & write (PR comments), **Commit statuses** read & write.
Subscribe to events: **Push**, **Pull request**.

Then generate a private key, convert it (GitHub hands out PKCS#1, Node needs PKCS#8):

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
```

Put the App id, the app slug from its URL, the contents of `app.pkcs8.pem` and the webhook secret
into `.env`, then `docker compose up -d`. Existing OAuth-connected projects keep deploying exactly
as before — the App is used only where an installation covers the repository.

### Custom domain + HTTPS for the dashboard

Put your own reverse proxy (nginx, Caddy, Traefik) in front of ports 3000/4000, set
`PUSHIFY_FRONTEND_URL` / `PUSHIFY_API_URL` to the public `https://` URLs, set
`TRUSTED_PROXY_HOPS=1`, then rebuild the frontend as above.

## Operations

```bash
cd pushify
docker compose ps                  # status
docker compose logs -f api worker  # live logs
docker compose down                # stop (data volumes survive)
docker compose exec postgres pg_dump -U pushify pushify > backup.sql   # DB backup
```

**Automate it.** `scripts/backup-control-plane.sh` dumps the control-plane database nightly,
keeps 14 days locally and — with `BACKUP_RCLONE_REMOTE=b2:my-bucket` (any rclone remote) —
copies every dump off the machine. A backup on the same disk is not a backup.

```bash
15 3 * * * BACKUP_RCLONE_REMOTE=b2:pushify-backups /opt/pushify/pushify_backend/scripts/backup-control-plane.sh >> /var/log/pushify-backup.log 2>&1
```

**Update:** re-run the installer, or `git -C pushify_backend pull && git -C pushify_frontend pull
&& docker compose up -d --build`. Migrations run automatically on start.

## Troubleshooting

- **API unhealthy on first boot** — usually a migration still running or a bad `.env` value:
  `docker compose logs migrate api`.
- **Dashboard can't reach the API** — `PUSHIFY_API_URL` must be reachable *from the browser*
  (server IP or domain, not `localhost`, unless you're on the same machine). Rebuild the
  frontend after fixing.
- **Deploy fails with "Docker is not available on this machine"** — the project has no deploy
  server attached; add one (see *How deploys work*).
- **Emails not sending** — `GMAIL_USER`/`GMAIL_APP_PASSWORD` unset; notifications are skipped
  silently until configured.
