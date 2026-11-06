# Backend API contracts for pending dashboard features

Contracts for the dashboard features whose backend part is done but whose UI is not. Every field
name below is taken from the route, service or schema file named in the section; nothing is
inferred. When one of those files changes, update this document in the same change.

Most of these endpoints are plain Hono routes and therefore **do not appear** in the generated
OpenAPI document (`/api/v1/doc`, Swagger UI at `/api/docs`). The exceptions are noted per section.

The response shapes of sections 1 and 3 are checked by `src/routes/api-contracts.test.ts`.

| # | Feature | Endpoint(s) | Exists |
|---|---------|-------------|--------|
| 1 | Traffic analytics | `GET /api/v1/projects/:projectId/analytics` | yes |
| 2 | Organization-wide 2FA | `GET /api/v1/organizations`, `PUT /api/v1/organizations/two-factor-policy`, `403 ORG_2FA_REQUIRED` | yes |
| 3 | Server health (OS patches, reboot) | `GET /api/v1/servers/:serverId/health` | yes |
| 4 | Self-host version / security release | `GET /api/v1/admin/platform/version` | yes (platform admins only) |
| 5 | `.env.example` import | `GET /api/v1/integrations/github/repos/:owner/:repo/env-keys`, `GET /api/v1/integrations/gitlab/projects/:projectId/env-keys` | yes |
| 6a | PR preview list | `GET /api/v1/projects/:projectId/previews`, `…/previews/active` | yes (read-only) |
| 6b | PR preview actions (redeploy / close) | `POST /api/v1/projects/:projectId/previews/:previewId/redeploy`, `…/close` | yes (no delete) |
| 6c | Volume backups | — | **no** |
| 7 | Log and metric drains | `GET/POST /api/v1/log-drains`, `PATCH/DELETE /api/v1/log-drains/:id`, `POST /api/v1/log-drains/:id/test`, `POST /api/v1/log-drains/sync` | yes |

## Conventions (all sections)

- **Auth.** `Authorization: Bearer <access token>` (dashboard session, JWT) or an API key
  `pk_live_…` (as `Authorization: Bearer pk_live_…` or `X-API-Key: pk_live_…`).
  Source: `src/middleware/auth.ts`, `src/middleware/apikey-auth.ts`.
- **API key scopes** are only checked for API key requests (`requireScope`); a session is not
  scope-checked. Scope list: `src/db/schema/apikeys.ts` (`API_KEY_SCOPES`).
- **Roles**: `owner` > `admin` > `member` > `viewer` (`src/lib/org-access.ts`). A member restricted
  to some projects gets `404` for other projects (`src/lib/member-project-scope.ts`).
- **Success body**: `{ "data": … }` (some writes add `"message"`).
- **Error body** (`src/middleware/error-handler.ts`):

  ```json
  { "error": { "code": "FORBIDDEN", "message": "Forbidden" } }
  ```

  `code` is the service's own code when it sets one (e.g. `ORG_2FA_REQUIRED`), otherwise derived
  from the status: `400 BAD_REQUEST`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`,
  `409 CONFLICT`, `429 RATE_LIMITED`, `500 INTERNAL_ERROR`. `message` is localized
  (`Accept-Language`: `en`, `tr`); the English texts below come from `src/i18n/locales/en.ts`.
- **Errors any session request on these routes can get**:

  | Status | `code` | When |
  |--------|--------|------|
  | 401 | `UNAUTHORIZED` | missing / invalid / expired token or API key |
  | 403 | `ORG_2FA_REQUIRED` | the organization requires 2FA and the user has none (section 2) |
  | 403 | `ORGANIZATION_PENDING_DELETION` | the organization is scheduled for deletion |
  | 403 | `IP_NOT_ALLOWED` | self-host `ADMIN_ALLOWED_CIDRS` is set and the client is outside it |
  | 429 | `RATE_LIMITED` | rate limit hit |
  | 404 | `NOT_FOUND` | an id in the path is not a UUID (Postgres `22P02`) |

---

## 1. Traffic analytics

`GET /api/v1/projects/:projectId/analytics?range=24h|7d`

- **Source**: `src/routes/metrics.ts` (route), `src/services/traffic-analytics.service.ts`
  (`getProjectAnalytics`), `src/lib/traffic-analytics.ts` (`TrafficAnalytics`, `TrafficPoint`,
  `buildTrafficAnalytics`), `src/db/schema/traffic.ts` (`project_traffic_hourly`).
- **Auth**: session or API key. **Scope**: `metrics:read`.
- **Role**: any member of the project's organization (viewer and up); restricted members only for
  their projects.
- **Query**: `range` — `24h` (default when missing or empty) or `7d`. Anything else is `400`.
- **Body**: none.

### Response `200`

```json
{
  "data": {
    "enabled": true,
    "range": "24h",
    "bucket": "hour",
    "retentionDays": 14,
    "totals": {
      "requests": 200,
      "status2xx": 180,
      "status3xx": 5,
      "status4xx": 10,
      "status5xx": 5,
      "bytesSent": 1048576,
      "errorRate4xx": 0.05,
      "errorRate5xx": 0.025,
      "p95LatencyMs": 250
    },
    "series": [
      {
        "hour": "2026-11-05T13:00:00.000Z",
        "requests": 0,
        "status2xx": 0,
        "status3xx": 0,
        "status4xx": 0,
        "status5xx": 0,
        "bytesSent": 0,
        "p95LatencyMs": null
      },
      {
        "hour": "2026-11-06T12:00:00.000Z",
        "requests": 200,
        "status2xx": 180,
        "status3xx": 5,
        "status4xx": 10,
        "status5xx": 5,
        "bytesSent": 1048576,
        "p95LatencyMs": 250
      }
    ]
  }
}
```

(Shortened: a real `24h` answer has 24 points; only the first and the last are shown.)

| Field | Type | Notes |
|-------|------|-------|
| `enabled` | boolean | `false` when `TRAFFIC_ANALYTICS_ENABLED=false` on the API or the project has `settings.trafficAnalytics: false`. Stored rows are still returned. |
| `range` | `"24h"` \| `"7d"` | echo of the query |
| `bucket` | `"hour"` | always hourly |
| `retentionDays` | number | `14` (`TRAFFIC_RETENTION_DAYS`) |
| `totals.requests`, `status2xx`…`status5xx`, `bytesSent` | number | sums over the range; `bytesSent` is response body bytes |
| `totals.errorRate4xx`, `errorRate5xx` | number | 0–1, `0` when there were no requests |
| `totals.p95LatencyMs` | number \| null | p95 request time over the range; `null` when no request time was recorded |
| `series` | array | exactly 24 (`24h`) or 168 (`7d`) points, oldest first, the last one is the current hour; hours without traffic are zeros |
| `series[].hour` | string (ISO, UTC) | start of the hour |
| `series[].p95LatencyMs` | number \| null | `null` for an hour without request times |

The per-project opt-out is `PATCH /api/v1/projects/:projectId/settings` with
`{ "trafficAnalytics": false }` (validated in `src/lib/repo-settings-validate.ts`).

### Errors

Access is checked before the range, so a bad project id wins over a bad range.

| Status | `code` | `message` / when |
|--------|--------|------------------|
| 400 | `BAD_REQUEST` | `range must be one of: 24h, 7d` |
| 403 | `FORBIDDEN` | `Forbidden` — project of another organization, caller not a member; API key without `metrics:read` (`API key does not have required permissions`) |
| 404 | `NOT_FOUND` | `Project not found` — unknown project, or outside a restricted member's projects |

---

## 2. Organization-wide 2FA policy

- **Source**: `src/routes/organizations.ts` (`GET /`, `PUT /two-factor-policy`),
  `src/services/organization.service.ts` (`getOrganization`, `setTwoFactorPolicy`),
  `src/lib/org-two-factor.ts` (enforcement, exemptions, `orgTwoFactorRequiredError`),
  `src/middleware/auth.ts` (where it is enforced), `src/db/schema/organizations.ts`
  (`requireTwoFactor` / `require_two_factor`).

### 2.1 Read: `GET /api/v1/organizations`

- **Auth**: session or API key (no scope check on this router). **Role**: any member.
- **Response `200`**: the caller's current organization row plus `role`. The policy is
  `requireTwoFactor`. Other columns of `organizations` are returned too; only the relevant ones are
  shown here.

```json
{
  "data": {
    "id": "3f1c…",
    "name": "Acme",
    "slug": "acme",
    "plan": "pro",
    "requireTwoFactor": false,
    "createdAt": "2026-01-10T09:00:00.000Z",
    "updatedAt": "2026-11-01T12:00:00.000Z",
    "role": "owner"
  }
}
```

The caller's own 2FA state is `GET /api/v1/auth/2fa/status` (`src/routes/twoFactor.ts`).

| Status | `code` | `message` |
|--------|--------|-----------|
| 403 | `FORBIDDEN` | `You do not have access to this organization` |
| 404 | `NOT_FOUND` | `Organization not found` |

### 2.2 Update: `PUT /api/v1/organizations/two-factor-policy`

- **Auth**: **session only** — every non-GET route of this router rejects API keys.
- **Role**: `owner`. Turning it on also needs the owner's own 2FA.
- **Body**: `{ "requireTwoFactor": boolean }` (required). Setting the current value again is a
  no-op `200` (no audit entry).
- **Response `200`**:

```json
{
  "data": { "requireTwoFactor": true },
  "message": "Two-factor requirement updated"
}
```

| Status | `code` | `message` / when |
|--------|--------|------------------|
| 400 | `BAD_REQUEST` | `Invalid request data` — body missing, not JSON or `requireTwoFactor` not a boolean |
| 400 | `TWO_FACTOR_NOT_ENABLED` | `Enable two-factor authentication on your own account before requiring it for the organization` |
| 403 | `FORBIDDEN` | `Only the organization owner can perform this action` (admin, member, viewer); `You do not have access to this organization` (not a member); `This endpoint requires a dashboard session token, not an API key` |
| 404 | `NOT_FOUND` | `Organization not found` |

### 2.3 What a member without 2FA gets: `403 ORG_2FA_REQUIRED`

While `requireTwoFactor` is `true`, every session (JWT) request to an organization-scoped route by
a user without TOTP enabled — reads and writes, the owner included — is refused by
`authMiddleware` with:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "error": {
    "code": "ORG_2FA_REQUIRED",
    "message": "This organization requires two-factor authentication. Enable it under Settings → Security to continue."
  }
}
```

(Turkish message for `Accept-Language: tr` from `src/i18n/locales/tr.ts`.) There is no `details`
field.

Still allowed for that user (`EXEMPT_FROM_ORG_TWO_FACTOR` in `src/lib/org-two-factor.ts`), so the
UI can send them to 2FA setup:

- `/api/v1/auth/2fa` and everything under it (setup, enable, status)
- `/api/v1/auth/me` and everything under it
- `POST /api/v1/auth/logout`
- `POST /api/v1/organizations/switch`
- `GET /api/v1/organizations/mine`

Not affected: API key requests (the policy is not applied to API keys yet). Signing in with SSO does
not satisfy the policy. The policy is cached for up to 30 s per API process, so other processes
pick up a change within that time.

---

## 3. Server health report (disk, orphans, OS patches, reboot)

`GET /api/v1/servers/:serverId/health`

- **Source**: `src/routes/servers.ts` (route), `src/lib/server-health-scan.ts`
  (`ServerHealthReport`, `OrphanContainer`), `src/lib/server-disk-check.ts`
  (`ServerDiskCheckResult`), `src/lib/server-patch-status.ts` (`ServerPatchStatus`),
  `src/services/server.service.ts` (`getServer`, access check).
- **Auth**: session or API key. **Scope**: `servers:read`.
- **Role**: any member of the organization.
- **Query / body**: none. The scan runs live over SSH on every call (no caching); the patch check
  alone may take up to 30 s (`PATCH_COMMAND_TIMEOUT_SECONDS`). It is read-only: nothing is
  installed and no `apt update` is run, so counts are as fresh as the server's own apt cache.

### Response `200`

```json
{
  "data": {
    "disk": {
      "ok": true,
      "usedPercent": 41,
      "availGb": 50,
      "mount": "/",
      "warn": false,
      "critical": false,
      "message": "💾 Disk OK: 41% used (50 GB free on /)",
      "measured": true
    },
    "orphans": [
      { "name": "pushify-old", "slug": "old", "status": "Exited (0) 3 days ago", "ports": "" }
    ],
    "pushifyContainerCount": 2,
    "patch": {
      "pending": 12,
      "security": 3,
      "rebootRequired": true,
      "unattendedUpgrades": { "enabled": true, "lastRunAt": "2026-10-26T07:33:20.000Z" },
      "checkedAt": "2026-11-06T12:34:00.000Z"
    }
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `disk.ok` | boolean | `false` when critical |
| `disk.usedPercent`, `disk.availGb` | number | root filesystem |
| `disk.warn`, `disk.critical` | boolean | thresholds `SERVER_DISK_WARN_PERCENT` (85) / `SERVER_DISK_CRITICAL_PERCENT` (95) |
| `disk.message` | string | English, not localized |
| `disk.measured` | boolean | `false` when `df` gave nothing usable; the numbers are then placeholders |
| `orphans[]` | `{ name, slug, status, ports }` (all strings) | `pushify-*` containers that match no active project of the organization |
| `pushifyContainerCount` | number | all `pushify-*` containers, running or not |
| `patch.pending` | number \| `"unknown"` | packages with a newer version |
| `patch.security` | number \| `"unknown"` | of those, from a security pocket |
| `patch.rebootRequired` | boolean \| `"unknown"` | `/var/run/reboot-required` exists |
| `patch.unattendedUpgrades.enabled` | boolean \| `"unknown"` | installed, enabled in `APT::Periodic`, timer not disabled |
| `patch.unattendedUpgrades.lastRunAt` | string (ISO) \| null | `null` when it never ran or is not known |
| `patch.checkedAt` | string (ISO) | time of this check |

`"unknown"` is a literal string. All patch fields are `"unknown"` (and `lastRunAt` `null`) on a
non-Debian/Ubuntu server or when the patch command fails; the rest of the report is still
returned. Managed and connected (BYOS) servers return the same fields.

### Errors

| Status | `code` | `message` / when |
|--------|--------|------------------|
| 400 | `SERVER_NOT_READY` | `Server setup must be completed before running a health scan` — `setupStatus` is not `completed` |
| 400 | `SSH_UNAVAILABLE` | same message — no IPv4 or no stored SSH key |
| 403 | `FORBIDDEN` | `You do not have access to this organization`; API key without `servers:read` |
| 404 | `NOT_FOUND` | `Server not found` — not in the caller's organization |
| 500 | `INTERNAL_ERROR` | `An unexpected error occurred` — SSH connection or the disk/container commands failed |

---

## 4. Self-host version / security release

`GET /api/v1/admin/platform/version`

- **Source**: `src/routes/admin.ts` (`platformVersionRoute`), `src/lib/platform-version.ts`
  (`PlatformVersionStatus`, `getPlatformVersion`), `src/middleware/require-platform-admin.ts`.
- **Auth**: **session only** (API keys get `404`). **Who**: platform operators — account email in
  `ADMIN_EMAILS` **and** 2FA enabled. This is not an organization role; there is no endpoint for
  ordinary users or org owners.
- **Query / body**: none.
- **OpenAPI**: declared with `createRoute` but `hide: true`, so it is not in `/api/v1/doc`.

### Response `200` (always 200 for an operator)

```json
{
  "data": {
    "current": "0.9.2",
    "latest": {
      "version": "0.9.3",
      "tag": "v0.9.3",
      "name": "v0.9.3",
      "url": "https://github.com/pushifydev/pushify_backend/releases/tag/v0.9.3",
      "publishedAt": "2026-11-04T10:00:00Z"
    },
    "updateAvailable": true,
    "securityRelease": true,
    "check": "ok",
    "checkedAt": "2026-11-06T09:00:00.000Z"
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `current` | string \| null | running version (`package.json`) |
| `latest` | object \| null | newest published GitHub release; `null` when `check` is not `ok` or there is none |
| `latest.version`, `latest.tag` | string | `version` is the tag without `v` |
| `latest.name`, `latest.url`, `latest.publishedAt` | string \| null | `url` only when it is a release page of this repository |
| `updateAvailable` | boolean | a release newer than `current` exists |
| `securityRelease` | boolean | at least one release newer than `current` is marked as a security release |
| `check` | `"ok"` \| `"disabled"` \| `"unavailable"` | `disabled`: `PUSHIFY_DISABLE_UPDATE_CHECK=true`; `unavailable`: GitHub could not be reached (not cached, retried next call) |
| `checkedAt` | string (ISO) \| null | when the releases were fetched; results are cached 6 h |

### Errors

| Status | `code` | `message` / when |
|--------|--------|------------------|
| 403 | `FORBIDDEN` | `Two-factor authentication is required for the admin panel — enable it under Settings → Security` (operator email without 2FA) |
| 404 | `NOT_FOUND` | `The requested resource was not found` — not an operator, or an API key |

---

## 5. `.env.example` import (env key detection)

Detection for the new-project wizard. Returns **names only, never values**. The first of
`.env.example`, `.env.sample`, `.env.template` found in the root directory is used (files over
64 KB are ignored). Saving the chosen keys is the existing bulk endpoint
`POST /api/v1/projects/:projectId/env/bulk` (`src/routes/envvars.ts`, scope `envvars:write`,
documented in `/api/v1/doc`).

- **Source**: `src/routes/github.ts` and `src/routes/gitlab.ts` (`envKeysRoute`,
  `EnvKeyDetectionSchema`), `src/lib/env-example-keys.ts` (`EnvExampleDetection`,
  `parseEnvExampleKeys`), `detectEnvKeys` in `src/services/github.service.ts` /
  `src/services/gitlab.service.ts`.
- **Auth**: **session only** (both integration routers reject API keys). No organization role:
  it uses the caller's own connected GitHub / GitLab account.
- **OpenAPI**: both are `createRoute` routes and appear in `/api/v1/doc` (tags `GitHub`, `GitLab`).

### Endpoints

| Method | Path | Path params |
|--------|------|-------------|
| GET | `/api/v1/integrations/github/repos/:owner/:repo/env-keys` | `owner`, `repo`: strings |
| GET | `/api/v1/integrations/gitlab/projects/:projectId/env-keys` | `projectId`: GitLab project id (number) |

**Query** (both): `branch` (optional; GitHub falls back to `main`), `rootDirectory` (optional,
max 255 chars, repository-relative).

### Response `200`

```json
{
  "data": {
    "source": "apps/web/.env.example",
    "keys": [
      { "key": "DATABASE_URL", "hasDefault": true },
      { "key": "STRIPE_SECRET_KEY", "hasDefault": false }
    ]
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `source` | string \| null | repository path of the file used; `null` when none was found |
| `keys[].key` | string | `^[A-Z][A-Z0-9_]*$`, ≤ 255 chars (same rule as env var create/bulk); invalid names are dropped |
| `keys[].hasDefault` | boolean | the example file had a non-blank value |

No file found is `200` with `{ "source": null, "keys": [] }`, not an error.

### Errors

| Status | `code` | `message` / when |
|--------|--------|------------------|
| 400 | `BAD_REQUEST` | `rootDirectory` leaves the repository or is otherwise invalid (`validateRepoRelativePath` message) |
| 400 | — | zod-openapi validation failure (e.g. non-numeric GitLab `projectId`, `rootDirectory` > 255): body is `{ "success": false, "error": … }`, not the usual error envelope |
| 403 | `FORBIDDEN` | `This endpoint requires a dashboard session token, not an API key` |
| 404 | `NOT_FOUND` | `GitHub is not connected` — the caller has no GitHub / GitLab integration (the GitLab route uses the same i18n key) |

---

## 6. PR previews and volume backups

### 6a. PR preview list — exists (read-only)

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/v1/projects/:projectId/previews` | the project's last 50 previews (open and closed), newest first |
| GET | `/api/v1/projects/:projectId/previews/active` | previews with `closedAt = null`, newest first |

- **Source**: `src/routes/previews.ts`, `src/services/preview.service.ts`
  (`getPreviewsByProject`, `getActivePreviewsByProject`), `src/repositories/preview.repository.ts`,
  `src/db/schema/previews.ts` (`preview_deployments`).
- **Auth**: session or API key. **Scope**: `projects:read`. **Role**: viewer and up.

```json
{
  "data": [
    {
      "id": "5a0e…",
      "projectId": "0b9f…",
      "deploymentId": "c1d2…",
      "prNumber": 42,
      "prTitle": "Add pricing page",
      "prBranch": "feature/pricing",
      "baseBranch": "main",
      "previewUrl": "https://…",
      "containerName": "pushify-preview-web-pr-42",
      "hostPort": 3142,
      "githubCommentId": 1234567890,
      "status": "running",
      "createdAt": "2026-11-05T10:00:00.000Z",
      "updatedAt": "2026-11-05T10:03:00.000Z",
      "closedAt": null
    }
  ]
}
```

`status`: `pending` | `building` | `running` | `stopped` | `failed`. Nullable: `deploymentId`,
`prTitle`, `previewUrl`, `containerName`, `hostPort`, `githubCommentId`, `closedAt`.

Errors: `403 FORBIDDEN` (not a member / API key without `projects:read`), `404 NOT_FOUND`
`Project not found`.

Previews are created and updated by Git webhooks (GitHub `pull_request` in
`src/routes/webhooks.ts` and `src/lib/github-deploy-trigger.ts`, GitLab `merge_request` in
`src/routes/webhooks.ts`), which also close them when the PR / MR closes; section 6b redeploys or
closes one by hand. A new push to a PR whose preview was closed by hand deploys it again (and
clears `closedAt`), as a reopened PR does. They are switched on per project with
`PATCH /api/v1/projects/:projectId/settings` and body `{ "previewDeploymentsEnabled": true }`
(settings are merged; scope `projects:write`; role member and up; `403` when the plan has no
preview deployments — `planLimitsService.assertPreviewDeploymentsAllowed`).

### 6b. PR preview actions — exist (redeploy, close)

| Method | Path | Does | Success |
|--------|------|------|---------|
| POST | `/api/v1/projects/:projectId/previews/:previewId/redeploy` | queues a new preview deployment of the **head of the PR branch** (`prBranch`; no pinned commit), same container and URL as a webhook push | `201` |
| POST | `/api/v1/projects/:projectId/previews/:previewId/close` | the PR-closed teardown (`cleanupPreview`): stops and removes the preview container and image, removes its nginx vhost, port, firewall rule and Cloudflare preview subdomain, marks the record closed (`status: "stopped"`, `closedAt` set) and updates the PR comment. Production and staging are not touched (only `<slug>-pr-<n>` names) | `200` |

- **Source**: `src/routes/previews.ts`, `src/services/preview.service.ts` (`redeployPreview`,
  `closePreview`, which call `createOrUpdatePreview` / `cleanupPreview`, the webhook code paths).
- **Auth**: session or API key. **Scope**: `projects:write`. **Role**: member and up (viewer `403`).
- **Body**: none.
- **Audit log**: `preview.redeployed` (`metadata`: `previewId`, `prNumber`, `deploymentId`) and
  `preview.closed` (`metadata`: `previewId`, `prNumber`).

Response: `{ "data": <preview>, "message": … }`, the preview in the shape of section 6a, after the
action. Redeploy: `status: "pending"` and the new `deploymentId` (follow it with the deployment
endpoints); `message` `Preview redeploy started`. Close: `status: "stopped"`, `closedAt` set;
`message` `Preview deployment closed`.

Errors:

| Status | `code` | `message` / when |
|--------|--------|------------------|
| 400 | `BAD_REQUEST` | redeploy only: `Preview deployments are disabled for this project` (also for Site Studio / uploaded static sites, whose publish path would overwrite production) |
| 402 | `UNKNOWN_ERROR` | redeploy only: organization billing past due (`assertOrganizationCanMutateResources`) |
| 403 | `FORBIDDEN` | redeploy only: billing suspended, organization pending deletion, plan without preview deployments or over a deploy / build-minutes quota (`planLimitsService`) |
| 403 | `FORBIDDEN` | viewer, not a member, or an API key without `projects:write` |
| 404 | `NOT_FOUND` | `Project not found`, or `Preview deployment not found` (no such preview in this project) |
| 409 | `CONFLICT` | `This preview deployment is closed` — redeploying or closing a preview with `closedAt` set |

There is still **no** endpoint to delete a preview record or change preview settings per preview.

### 6c. Volume backups — **do not exist**

There is **no** endpoint to back up, list backups of, download or restore a project volume. The
volume API is only:

| Method | Path | Scope | Role |
|--------|------|-------|------|
| GET | `/api/v1/projects/:projectId/volumes` | `projects:read` | viewer+ |
| POST | `/api/v1/projects/:projectId/volumes` | `projects:write` | member+ |
| DELETE | `/api/v1/projects/:projectId/volumes/:volumeId` | `projects:write` | member+ |

Source: `src/routes/project-volumes.ts`, `src/services/project-volume.service.ts`,
`src/db/schema/project-volumes.ts`. A volume is `{ id, projectId, name, containerPath, createdAt }`;
`POST` takes `{ "name": string, "containerPath": string }` (max 5 volumes per project) and answers
`201`. The backup endpoints under `/api/v1/databases/:id/backups` (`src/routes/databases.ts`) are
for managed databases only and do not cover project volumes. A volume backup UI needs a backend
change first.

---

## 7. Log and metric drains

A drain sends container logs (and optionally container and host metrics) of the organization's
**own servers** to an external tool. A Vector agent (`pushify_log_agent` container) is installed,
updated or removed on each server whenever a drain changes and when a server finishes setup.
Projects on Pushify's shared runners are **not** covered.

- **Source**: `src/routes/log-drains.ts`, `src/services/log-drain.service.ts` (`PublicLogDrain`,
  `LogDrainInput`, `LogDrainTestResult`, `LogAgentSyncResult`), `src/lib/log-drains.ts`
  (validation, agent configuration), `src/db/schema/log-drains.ts` (`log_drains`).
- **Auth**: **session only** (API keys get `403`). **Role**: list — any member; everything else —
  `owner` / `admin`.
- **Audit log**: `log_drain.created`, `log_drain.updated` (`metadata.secretChanged`),
  `log_drain.deleted`. The secret is never in the audit log.

### Drain object

```json
{
  "id": "5a0e…",
  "projectId": null,
  "name": "Grafana Cloud",
  "type": "loki",
  "endpoint": "https://logs-prod-eu-west-0.grafana.net",
  "options": { "username": "123456" },
  "hasSecret": true,
  "sendLogs": true,
  "sendMetrics": false,
  "enabled": true,
  "lastTestedAt": "2026-11-06T12:00:00.000Z",
  "lastTestOk": true,
  "lastTestError": null,
  "createdAt": "2026-11-06T11:58:00.000Z",
  "updatedAt": "2026-11-06T11:58:00.000Z"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `projectId` | string \| null | `null` = every project on the organization's servers; a project id = only that project's containers (no host metrics) |
| `type` | `"http"` \| `"loki"` \| `"datadog"` \| `"elastic"` \| `"s3"` | |
| `endpoint` | string \| null | http(s) URL, no credentials in it. Required for `http`, `loki` (base URL; `/loki/api/v1/push` is appended), `elastic`; optional S3-compatible endpoint for `s3`; always `null` for `datadog` |
| `options` | object | per type, see below; unknown keys are dropped |
| `hasSecret` | boolean | the secret itself is **never** returned |
| `sendLogs`, `sendMetrics` | boolean | at least one is `true`; defaults `true` / `false` |
| `enabled` | boolean | a disabled drain stays stored but is left out of the agent |
| `lastTestOk`, `lastTestError` | boolean \| null, string \| null | outcome of the last connection test |

| `type` | `options` | `secret` |
|--------|-----------|----------|
| `http` | `username?` | optional: Bearer token, or the password when `username` is set (Basic) |
| `loki` | `username?` | optional: Bearer token, or the password when `username` is set (Grafana Cloud: user id + token) |
| `datadog` | `site?` (default `datadoghq.com`; e.g. `datadoghq.eu`, `us5.datadoghq.com`, `ddog-gov.com`) | **required**: API key |
| `elastic` | `username?`, `index?` (default `pushify-logs`) | optional: password with `username`, else an API key (`Authorization: ApiKey …`) |
| `s3` | `bucket`, `region` (`auto` for R2), `accessKeyId` (all required), `prefix?` (default `pushify/`) | **required**: secret access key |

Every shipped event carries `pushify.project` (slug), `pushify.project_id` (empty for a project
created after the last sync), `pushify.environment` (`production` \| `staging` \| `preview`),
`pushify.service` (`app` \| `worker:<name>` \| `database`), `pushify.server`, `pushify.server_id`
and `pushify.kind` (`log` \| `container_metrics` \| `host_metrics`). Loki gets `project`,
`environment`, `service`, `server`, `kind` and `source=pushify` as labels. Container metrics are
`cpu_percent`, `memory_percent`, `pids` every 30 s (Datadog: gauges `pushify.container_*`); host
metrics come from Vector's `host_metrics` (cpu, memory, load, network, disk, host). Except for
Datadog, metrics are sent as JSON log events. Logs are shipped as the app writes them: Pushify's
secret masking of the logs it stores does not apply to drains.

### Endpoints

| Method | Path | Body | Success |
|--------|------|------|---------|
| GET | `/api/v1/log-drains` | — | `200 { "data": [<drain>…] }`, newest first |
| POST | `/api/v1/log-drains` | `{ name, type, projectId?, endpoint?, secret?, options?, sendLogs?, sendMetrics?, enabled? }` | `201 { "data": <drain> }` |
| PATCH | `/api/v1/log-drains/:id` | any of the create fields; `secret` omitted keeps it, `null` / `""` removes it | `200 { "data": <drain> }` |
| DELETE | `/api/v1/log-drains/:id` | — | `200 { "data": { "success": true } }` |
| POST | `/api/v1/log-drains/:id/test` | — | `200 { "data": <test result> }` |
| POST | `/api/v1/log-drains/sync` | — | `200 { "data": [<sync result>…] }` |

`name`: 1–100 characters. `secret`: at most 4096 characters, no line breaks or control characters.
Create, update and delete answer before the agent is updated (it runs in the background); call
`sync` to apply and see the outcome.

**Test result** — one test event is sent **from the Pushify API** (not from the servers), with a
10 s timeout; the outcome is also stored on the drain (`lastTestedAt`, `lastTestOk`, `lastTestError`):

```json
{ "ok": false, "status": 401, "message": "HTTP 401: {\"error\":\"invalid token\"}", "testedAt": "2026-11-06T12:00:00.000Z" }
```

`status` is `null` when no HTTP answer came (timeout, DNS, TLS). An endpoint on a private address
is not tested (`ok: false`, message starts with `Not tested:`) — the agent on the servers may still
reach it. Any secret is replaced by `***` in `message`.

**Sync result** — one entry per server of the organization (shared runners excluded); the run
waits for every server (first install pulls the agent image, so allow a few minutes):

```json
[
  { "serverId": "…", "serverName": "prod-1", "status": "installed", "drains": 2, "message": null },
  { "serverId": "…", "serverName": "old", "status": "skipped", "drains": 0, "message": "server is not running or not reachable over SSH" }
]
```

`status`: `installed` (started or restarted with a new configuration), `unchanged`, `removed` (no
drain applies any more), `skipped`, `failed` (`message` says why, e.g. `invalid-config`,
`image-pull-failed`, `docker-missing` or an SSH error). A failed run leaves the running agent as it
was. `message` may be `no-systemd-no-container-metrics` on a server without systemd.

### Errors

| Status | `code` | `message` / when |
|--------|--------|------------------|
| 400 | `BAD_REQUEST` | validation, e.g. `type must be one of: http, loki, datadog, elastic, s3`, `endpoint is required for loki drains`, `secret is required for datadog drains`, `options.bucket must be a valid S3 bucket name`, `enable at least one of sendLogs and sendMetrics` |
| 403 | `FORBIDDEN` | `This endpoint requires a dashboard session token, not an API key`; `You do not have access to this organization` (not a member); `Only owners and admins can perform this action` (member / viewer on writes, test and sync) |
| 404 | `NOT_FOUND` | `Log drain not found` (not in the caller's organization); `Project not found` for a `projectId` outside the organization |
