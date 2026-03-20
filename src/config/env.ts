import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url().optional(),

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

  // AI Assistant
  ANTHROPIC_API_KEY: z.string().optional(),

  // Rate Limiting
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(5), // Max auth requests per minute
  RATE_LIMIT_API_MAX: z.coerce.number().default(100), // Max API requests per minute

  // Deployment Concurrency Limits
  MAX_CONCURRENT_DEPLOYS_PER_SERVER: z.coerce.number().default(2),
  MAX_CONCURRENT_DEPLOYS_TOTAL: z.coerce.number().default(5),

  // Docker Resource Limits
  DOCKER_MEMORY_LIMIT: z.string().default('512m'),
  DOCKER_CPU_LIMIT: z.string().default('0.5'),
  DOCKER_BUILD_MEMORY_LIMIT: z.string().default('1g'),
  DOCKER_BUILD_CPU_LIMIT: z.string().default('1'),
  DOCKER_BUILD_TIMEOUT: z.coerce.number().default(600), // seconds

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
