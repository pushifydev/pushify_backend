# Jenkins — Pushify backend deploy

Backend build uses **tsup** (Rollup). On Linux CI, if `npm ci` fails with missing `@rollup/rollup-linux-x64-gnu`, run after `npm ci`:

```bash
npm install @rollup/rollup-linux-x64-gnu@4.57.0 --no-save
```

(`package.json` optionalDependencies + `jenkins-deploy.sh` handle this automatically.)

## One-time server setup

1. Node.js **20 LTS** and `pm2` globally:

```bash
sudo npm install -g pm2
pm2 startup   # follow printed instructions (systemd)
```

2. Clone or Jenkins workspace path, e.g. `/var/www/pushify/pushify_backend`.

3. Create `.env` on the server (never commit). Copy from `.env.example` and set production values:

   - `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`
   - `API_BASE_URL=https://api.pushify.dev` (no trailing slash; used for GitHub webhooks)
   - `CORS_ORIGIN`, `FRONTEND_URL`, Stripe, GitHub OAuth, etc.

4. Create PM2 config:

```bash
cp ecosystem.config.example.cjs ecosystem.config.cjs
```

Edit only non-secret overrides in `ecosystem.config.cjs` if needed; secrets stay in `.env`.

---

## Jenkins job (recommended shell)

### Standalone repo (`pushifydev/pushify_backend`) — your setup

Jenkins workspace **is** the backend root (`/var/lib/jenkins/workspace/pushify_backend`).
Do **not** `cd` into `pushify_backend/pushify_backend` (that path does not exist).

```bash
set -euo pipefail
chmod +x "${WORKSPACE}/scripts/jenkins-deploy.sh"
sudo -E bash "${WORKSPACE}/scripts/jenkins-deploy.sh"
```

Or inline (no nested `cd`):

```bash
set -euo pipefail
cd "${WORKSPACE}"
npm ci
npm run build
npm run db:migrate
sudo pm2 reload ecosystem.config.cjs --update-env || sudo pm2 start ecosystem.config.cjs
sudo pm2 save
```

### Monorepo (backend in subdirectory)

```bash
export BACKEND_DIR="${WORKSPACE}/pushify_backend"
chmod +x "${BACKEND_DIR}/scripts/jenkins-deploy.sh"
sudo -E bash "${BACKEND_DIR}/scripts/jenkins-deploy.sh"
```

`jenkins-deploy.sh` auto-detects `WORKSPACE` (standalone vs monorepo).

Use `sudo` only if Jenkins user ≠ user that owns PM2; otherwise drop `sudo`.

### Replace your old steps

| Old (remove) | Why |
|--------------|-----|
| `rm -rf node_modules package-lock.json` | Breaks reproducible builds; use `npm ci` |
| `npm install @rollup/rollup-linux-x64-gnu` | Frontend only |
| `pm2 start` every deploy | Creates duplicate processes; use `reload` |

---

## Jenkins pipeline (Declarative) example

```groovy
pipeline {
  agent any
  environment {
    BACKEND_DIR = "${WORKSPACE}/pushify_backend"
  }
  stages {
    stage('Deploy API') {
      steps {
        sh '''
          chmod +x "${BACKEND_DIR}/scripts/jenkins-deploy.sh"
          bash "${BACKEND_DIR}/scripts/jenkins-deploy.sh"
        '''
      }
    }
  }
  post {
    success {
      echo 'Backend deployed — check pm2 logs'
    }
  }
}
```

---

## PM2 processes

### Phase A (now) — single app

`ecosystem.config.cjs` → `pushify-backend`, `PROCESS_ROLE=all`, `dist/index.js`.

Same as today: one VM runs API + deploy worker + metrics.

### Phase B (later) — API + worker split

Two apps in `ecosystem.config.example.cjs` (uncomment worker block):

| PM2 name | Script | `PROCESS_ROLE` |
|----------|--------|----------------|
| `pushify-api` | `dist/index.js` | `api` |
| `pushify-worker` | `dist/worker.js` | `worker` |

Requires new build (`dist/worker.js` from `npm run build`). Same `.env` on both.

---

## Post-deploy checks

```bash
pm2 logs pushify-backend --lines 50
curl -sS https://api.pushify.dev/api/v1/health
```

Logs should include `Redis connection verified` when `REDIS_URL` is set.

---

## Jenkins credentials (optional)

Store `.env` as a **Secret file** credential and inject before deploy:

```bash
cp "$ENV_FILE_CREDENTIAL" "${BACKEND_DIR}/.env"
chmod 600 "${BACKEND_DIR}/.env"
bash "${BACKEND_DIR}/scripts/jenkins-deploy.sh"
```

Never store secrets inside `ecosystem.config.cjs` in the job config.

---

## Migrations

`jenkins-deploy.sh` runs `npm run db:migrate` when `.env` exists. For zero-downtime, run migrations in a separate maintenance job if you prefer.

See also [SCALING.md](./SCALING.md) and [PRODUCTION.md](../../docs/PRODUCTION.md).
