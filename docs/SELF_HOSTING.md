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

### Private registries and image deploys

**Settings → Private registries** stores a login per registry for the organization (`ghcr.io`,
`registry.gitlab.com`, a self-hosted `registry.example.com:5000` — host only, no scheme). Before
each build and pull the deploy signs in on the server with them, into a directory it deletes
afterwards, so a Dockerfile can `FROM` a private base image. The token is write-only: it can be
replaced but never read back.

A project can also deploy its repository as a **Docker Compose stack**: put the compose file's
path in project settings → *Docker Compose file*. The stack comes up from the checkout, so
`build:` contexts work as they do locally. Only the served service is published on the host (nginx
proxies it); the other services keep talking to each other by name inside the stack, and their own
`ports:` are not published — a compose file that maps `5432:5432` would otherwise put the database
on the internet. The field is empty by default and a compose file is never picked up on its own.

A project can also deploy a **ready image** instead of a repository: put the reference in project
settings → *Docker image* (`ghcr.io/acme/api:1.4`) and every deploy pulls that reference again —
moving the tag and redeploying ships the new image. Such a project needs a server; the no-server
fallback cannot do it.

### Single sign-on

**Settings → Single sign-on** connects the organization's own identity provider over OpenID
Connect (Okta, Entra ID, Google Workspace, Auth0, Keycloak). Enter the issuer, the client id and
secret, and the email domains the provider signs in; the page shows the redirect URI to paste at
the provider. Turning on *Require single sign-on* stops passwords, GitHub and Google from working
for those domains, so disabling someone at the provider is enough to lock them out. Two-factor
authentication still applies on top.

The redirect URI is derived from `API_BASE_URL` (falling back to `FRONTEND_URL`), so set that to
the address the dashboard actually reaches before configuring a connection.

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
checks the dump (size, gzip integrity, pg_dump's completion marker), keeps 14 days locally
and — with `BACKUP_RCLONE_REMOTE` (any rclone remote) — copies every dump off the machine,
lists it back, and prunes copies older than `BACKUP_REMOTE_KEEP_DAYS` (60) there. Any failure
exits non-zero; `BACKUP_HEARTBEAT_URL` is pinged on success and at `<url>/fail` on failure
(healthchecks.io, Uptime Kuma push monitors), so a backup that stops running gets noticed.
A backup on the same disk is not a backup.

Off-site to a Hetzner Storage Box, encrypted before it leaves the machine (the dump holds
user emails and password hashes):

```bash
# 1. rclone, and an SSH key for the Storage Box (enable SSH in its settings; port 23)
curl -fsSL https://rclone.org/install.sh | sudo bash
ssh-keygen -t ed25519 -N '' -f /root/.ssh/storagebox
cat /root/.ssh/storagebox.pub | ssh -p 23 uXXXXXX@uXXXXXX.your-storagebox.de install-ssh-key

# 2. the Storage Box, and an encrypting remote on top of it
rclone config create storagebox sftp host=uXXXXXX.your-storagebox.de user=uXXXXXX port=23 key_file=/root/.ssh/storagebox
rclone mkdir storagebox:pushify-backups
openssl rand -base64 32 > /root/offsite-crypt-password.txt
rclone config create offsite crypt remote=storagebox:pushify-backups \
  password="$(cat /root/offsite-crypt-password.txt)" --obscure
# → store /root/offsite-crypt-password.txt in your password manager, then delete it:
#   without it the off-site copies cannot be read.

# 3. try it, then schedule it
BACKUP_RCLONE_REMOTE=offsite: /opt/pushify/pushify_backend/scripts/backup-control-plane.sh
rclone ls offsite:
```

```bash
15 3 * * * BACKUP_RCLONE_REMOTE=offsite: BACKUP_HEARTBEAT_URL=https://hc-ping.com/<uuid> /opt/pushify/pushify_backend/scripts/backup-control-plane.sh >> /var/log/pushify-backup.log 2>&1
```

Restore: `rclone copy offsite:pushify-control-plane-<stamp>.sql.gz .` then
`gunzip -c pushify-control-plane-<stamp>.sql.gz | psql "$DATABASE_URL"` into an empty database.
Secrets in it are encrypted with the backend's `ENCRYPTION_KEY` — keep the backend `.env` in
your password manager too, or the restored platform can't read them.

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
