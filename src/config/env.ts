import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  /** Public API origin (no trailing slash) — GitHub/GitLab webhook install URLs */
  API_BASE_URL: z
    .string()
    .url()
    .transform((url) => url.replace(/\/$/, ''))
    .optional(),

  // Database
  DATABASE_URL: z.string().url(),
  /** Max connections per process (API and worker each have their own pool) */
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  PG_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  PG_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),

  // Redis
  REDIS_URL: z.string().url().optional(),
  /** Dashboard GET /overview cache TTL (seconds); 0 disables */
  DASHBOARD_OVERVIEW_CACHE_TTL_SEC: z.coerce.number().int().min(0).max(300).default(45),
  /** Delay between SSH metrics collection per deploy server (ms) */
  METRICS_SERVER_STAGGER_MS: z.coerce.number().int().min(0).max(60_000).default(2000),

  /**
   * api — HTTP + WebSocket only (scale behind load balancer)
   * worker — background jobs only (deploy, metrics, queues)
   * all — single process (local dev)
   */
  PROCESS_ROLE: z.enum(['api', 'worker', 'all']).default('all'),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),

  // Cors
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // GitHub OAuth
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CALLBACK_URL: z.string().url().optional(),

  // GitLab OAuth (gitlab.com or self-hosted)
  GITLAB_CLIENT_ID: z.string().optional(),
  GITLAB_CLIENT_SECRET: z.string().optional(),
  GITLAB_CALLBACK_URL: z.string().url().optional(),
  GITLAB_BASE_URL: z.string().url().optional(),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

  // Frontend URL (for links in notifications, commit status, etc.)
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  // Gmail SMTP (for email notifications)
  GMAIL_USER: z.string().email().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  GMAIL_FROM_NAME: z.string().default('Pushify'),

  // Preview Deployments
  PREVIEW_BASE_URL: z.string().optional(),
  WILDCARD_SSL_PATH: z.string().optional(), // e.g. /etc/letsencrypt/live/pushify.dev-0001
  // Dedicated runner server pool (comma-separated `servers` row ids) that free/unassigned
  // deploys land on, keeping untrusted workloads off the control-plane host. A project is
  // stickily mapped to one runner (deterministic by project id) so its redeploys stay put.
  // Unset → deploys fall back to local. `PUSHIFY_RUNNER_SERVER_ID` (single) is still honored.
  PUSHIFY_RUNNER_SERVER_IDS: z.string().optional(),
  PUSHIFY_RUNNER_SERVER_ID: z.string().optional(),

  // AI Assistant
  ANTHROPIC_API_KEY: z.string().optional(),

  /**
   * Number of trusted reverse-proxy hops in front of the app (e.g. 1 when behind a
   * single nginx/load balancer). Controls how the client IP is derived for rate limiting:
   * 0 (default) → use the real socket address and IGNORE X-Forwarded-For (not spoofable);
   * N → read the Nth-from-right entry of X-Forwarded-For. Set this in production behind a
   * proxy, otherwise an attacker can rotate X-Forwarded-For to bypass IP rate limits.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  // Rate Limiting (see middleware/rate-limit.ts)
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  /** Login, register, refresh, OAuth callbacks — per IP, per minute */
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(20),
  /** Unauthenticated `/api/*` routes — per IP, per minute (authenticated routes use plan limits) */
  RATE_LIMIT_API_MAX: z.coerce.number().default(200),
  /**
   * Interactive dashboard (JWT session) — per org, per minute. The browser dashboard polls
   * logs/status/metrics, so it needs far more headroom than a programmatic API key. This bound
   * only guards against a runaway client loop; API keys still use the per-plan apiRequestsPerMinute.
   */
  RATE_LIMIT_SESSION_MAX: z.coerce.number().default(600),
  /** GitHub/Stripe webhook routes — per project or IP, per minute */
  RATE_LIMIT_WEBHOOK_MAX: z.coerce.number().default(60),
  /** Manual deploy / redeploy / rollback — per project or IP, per hour */
  RATE_LIMIT_DEPLOY_TRIGGER_MAX: z.coerce.number().default(20),
  /** Forgot / reset password — per IP, per 15 minutes */
  RATE_LIMIT_PASSWORD_RESET_MAX: z.coerce.number().default(3),
  /** Sensitive routes — per IP, per hour */
  RATE_LIMIT_SENSITIVE_MAX: z.coerce.number().default(10),

  // Deployment Concurrency Limits
  MAX_CONCURRENT_DEPLOYS_PER_SERVER: z.coerce.number().default(2),
  MAX_CONCURRENT_DEPLOYS_TOTAL: z.coerce.number().default(5),

  // Docker Resource Limits
  DOCKER_MEMORY_LIMIT: z.string().default('768m'),
  DOCKER_CPU_LIMIT: z.string().default('0.5'),
  DOCKER_BUILD_MEMORY_LIMIT: z.string().default('2g'),
  DOCKER_BUILD_CPU_LIMIT: z.string().default('1'),
  DOCKER_BUILD_TIMEOUT: z.coerce.number().default(600), // seconds

  /** Root FS usage % on deploy servers — warn / block deploy */
  SERVER_DISK_WARN_PERCENT: z.coerce.number().default(85),
  SERVER_DISK_CRITICAL_PERCENT: z.coerce.number().default(95),

  // Stripe (optional — for payment processing)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  /** Live/test Price IDs — override hardcoded defaults in lib/stripe.ts */
  STRIPE_PRICE_HOBBY_MONTHLY: z.string().optional(),
  STRIPE_PRICE_HOBBY_YEARLY: z.string().optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
  STRIPE_PRICE_PRO_YEARLY: z.string().optional(),
  STRIPE_PRICE_BUSINESS_MONTHLY: z.string().optional(),
  STRIPE_PRICE_BUSINESS_YEARLY: z.string().optional(),

  /** Margin % on managed infra provider list price (default 20) */
  INFRA_MARGIN_PERCENT: z.coerce.number().min(0).max(100).default(20),
  /** EUR→USD floor/fallback rate — used when the live FX fetch fails or returns a lower value (default 1.08) */
  INFRA_EUR_TO_USD_RATE: z.coerce.number().positive().default(1.08),
  /** Safety buffer % added on top of the live EUR→USD rate to absorb intraday swings (default 2) */
  INFRA_FX_BUFFER_PERCENT: z.coerce.number().min(0).max(50).default(2),
  /** Flat per-server provider surcharge in EUR added before margin — covers extras like IPv4 (~0.50). Default 0 = off */
  INFRA_PROVIDER_SURCHARGE_EUR: z.coerce.number().min(0).default(0),
  /** Warn by email when infra wallet balance falls below this (USD cents, default $10) */
  INFRA_LOW_BALANCE_WARN_CENTS: z.coerce.number().int().min(0).default(1000),

  // Encryption
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be a 64-character hex string (use: openssl rand -hex 32)'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export type Env = z.infer<typeof envSchema>;
