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

  // Frontend URL (for links in notifications, commit status, etc.)
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  // Gmail SMTP (for email notifications)
  GMAIL_USER: z.string().email().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  GMAIL_FROM_NAME: z.string().default('Pushify'),

  // Preview Deployments
  PREVIEW_BASE_URL: z.string().optional(),

  // AI Assistant
  ANTHROPIC_API_KEY: z.string().optional(),

  // Rate Limiting
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(5), // Max auth requests per minute
  RATE_LIMIT_API_MAX: z.coerce.number().default(100), // Max API requests per minute
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export type Env = z.infer<typeof envSchema>;
