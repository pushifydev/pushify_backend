# Pushify backend — scaling guide

## Process roles

| `PROCESS_ROLE` | Runs | Use case |
|----------------|------|----------|
| `all` | API + all background workers | Local dev (`npm run dev`) |
| `api` | HTTP API + WebSocket only | Production behind load balancer |
| `worker` | Deploy, metrics, health, BullMQ, etc. | Separate VM / container |

Production (recommended):

```bash
# Instance(s) behind reverse proxy / LB
PROCESS_ROLE=api npm run start:api

# One or more worker instances (deploy leader lock uses Redis when REDIS_URL is set)
PROCESS_ROLE=worker npm run start:worker
```

Until you split processes, keep `PROCESS_ROLE=all` on a single server (current live setup).

## Redis (`REDIS_URL`)

Required for production multi-instance:

- Plan-based API rate limits (shared counters)
- WebSocket events across API pods
- Deploy worker leader election (only one poller when multiple worker replicas)
- BullMQ (notifications, server setup/status)
- GitHub / Stripe webhook deduplication

Verify at startup: logs should include `Redis connection verified`.

## PostgreSQL pool

Each Node process has its own pool (`PG_POOL_MAX`, default 20).

Ensure Postgres `max_connections` exceeds:

```
(API_replicas × PG_POOL_MAX) + (worker_replicas × PG_POOL_MAX) + margin
```

Use [PgBouncer](https://www.pgbouncer.org/) if you run many API replicas.

## Deployment concurrency

Tune on the **worker** service:

- `MAX_CONCURRENT_DEPLOYS_TOTAL` (default 5)
- `MAX_CONCURRENT_DEPLOYS_PER_SERVER` (default 2)

Heavy builds share CPU with other workers on the same machine — prefer a dedicated worker VM with more RAM/CPU.

## Rollout checklist

1. Confirm `REDIS_URL` on live (done).
2. Deploy new backend build.
3. **Phase A** — same server, `PROCESS_ROLE=all` (no behavior change).
4. **Phase B** — add worker service with `PROCESS_ROLE=worker`, switch API to `PROCESS_ROLE=api`.
5. Scale API horizontally; keep 1–2 worker replicas (Redis deploy lock prevents duplicate deploy polling).
6. Monitor: CPU, memory, 429 rate, deploy queue time, Postgres connections.

## Deploy queue (BullMQ)

When `REDIS_URL` is set, pending deployments are enqueued immediately (`deploy-{id}` job dedupe) and processed by a BullMQ worker. A reconcile loop every 15s re-queues any orphaned `pending` rows. Concurrency slots use Redis counters (global + per-server) so multiple worker VMs stay safe.

Without Redis, the worker falls back to the legacy 5s DB poll loop.

Env: `MAX_CONCURRENT_DEPLOYS_TOTAL`, `MAX_CONCURRENT_DEPLOYS_PER_SERVER`.

## Dashboard cache

`GET /dashboard/overview` is cached in Redis per org + locale (`DASHBOARD_OVERVIEW_CACHE_TTL_SEC`, default 45). Set `0` to disable.

## Metrics collection

SSH/docker stats are collected per deploy server with `METRICS_SERVER_STAGGER_MS` delay between servers (default 2000ms) to avoid connection storms.
