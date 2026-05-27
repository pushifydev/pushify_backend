import type { MarketplaceTemplate } from '../types';

const composeFile = `services:
  calcom:
    image: calcom/cal.com:latest
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - \${KONG_HTTP_PORT:-3000}:3000
    extra_hosts:
      - "PUSHIFY_CALCOM_EXTRA_HOST_PLACEHOLDER:host-gateway"
    depends_on:
      database:
        condition: service_healthy
      redis:
        condition: service_started
    environment:
      DATABASE_URL: postgres://calcom:\${POSTGRES_PASSWORD}@database:5432/calendso
      DATABASE_DIRECT_URL: postgres://calcom:\${POSTGRES_PASSWORD}@database:5432/calendso
      REDIS_URL: redis://redis:6379
      JWT_SECRET: \${JWT_SECRET}
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: \${NEXT_PUBLIC_WEBAPP_URL}
      CALENDSO_ENCRYPTION_KEY: \${CALENDSO_ENCRYPTION_KEY}
      NEXT_PUBLIC_WEBAPP_URL: \${NEXT_PUBLIC_WEBAPP_URL}
      NEXT_PUBLIC_WEBSITE_URL: \${NEXT_PUBLIC_WEBAPP_URL}
      NEXT_PUBLIC_API_V2_URL: \${NEXT_PUBLIC_WEBAPP_URL}/api/v2
      ALLOWED_HOSTNAMES: '"PUSHIFY_CALCOM_ALLOWED_HOST_PLACEHOLDER"'
      DATABASE_HOST: database:5432
      WEBAPP_URL: \${NEXT_PUBLIC_WEBAPP_URL}
      NODE_ENV: production
      AUTH_TRUST_HOST: "true"
      ORGANIZATIONS_ENABLED: "false"
      CALCOM_TELEMETRY_DISABLED: "1"
      NEXT_PUBLIC_LICENSE_CONSENT: agree
      LICENSE: agree
      STRIPE_PRIVATE_KEY: \${STRIPE_PRIVATE_KEY}
      STRIPE_API_KEY: \${STRIPE_API_KEY}
      STRIPE_WEBHOOK_SECRET: \${STRIPE_WEBHOOK_SECRET}
      EMAIL_FROM: \${EMAIL_FROM:-noreply@example.com}
      EMAIL_SERVER_HOST: \${SMTP_HOST:-}
      EMAIL_SERVER_PORT: \${SMTP_PORT:-587}
      EMAIL_SERVER_USER: \${SMTP_USER:-}
      EMAIL_SERVER_PASSWORD: \${SMTP_PASS:-}

  database:
    image: postgres:16-alpine
    restart: unless-stopped
    env_file:
      - .env
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U calcom -d calendso"]
      interval: 5s
      timeout: 5s
      retries: 10
    environment:
      POSTGRES_USER: calcom
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: calendso
    volumes:
      - calcom-db:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --save 60 1 --loglevel warning

volumes:
  calcom-db:
`;

export const calcom: MarketplaceTemplate = {
  id: 'calcom',
  name: 'Cal.com',
  description: 'Open-source Calendly alternative — schedule meetings without back-and-forth emails',
  longDescription: `Cal.com is the open-source alternative to Calendly. Self-host a beautiful
scheduling tool that connects to all your calendars and integrates with the apps you love.

- **Beautiful booking pages** — public scheduling links
- **Calendar integrations** — Google, Outlook, iCloud, Office 365
- **Video conferencing** — Zoom, Google Meet, Daily.co built-in
- **Custom forms** — collect info during booking
- **Team scheduling** — round-robin, collective, managed events
- **Workflows** — automated reminders, follow-ups
- **Embed everywhere** — inline, popup, or redirect
- 30K+ stars on GitHub`,
  icon: 'Clock',
  category: 'automation',
  tags: ['scheduling', 'calendar', 'calendly-alternative', 'meetings'],
  website: 'https://cal.com',
  documentation: 'https://cal.com/docs/self-hosting',

  deploymentType: 'docker-compose',
  composeFile,
  composePublicService: 'calcom',
  composePublicPort: 3000,

  port: 3000,
  healthCheckPath: '/api/health',
  envVars: [
    {
      key: 'POSTGRES_PASSWORD',
      label: 'Database Password',
      description: 'Password for the bundled PostgreSQL database',
      required: true,
      type: 'password',
      generate: 'password',
      hidden: true,
    },
    {
      key: 'NEXTAUTH_SECRET',
      label: 'Auth Secret',
      description: 'Secret for signing user session tokens',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'CALENDSO_ENCRYPTION_KEY',
      label: 'Encryption Key',
      description: '32-character key for encrypting integration credentials',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'JWT_SECRET',
      label: 'JWT Secret',
      description: 'Secret for API tokens (auto-generated)',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'NEXT_PUBLIC_WEBAPP_URL',
      label: 'Public URL',
      description: 'Public URL where Cal.com is reachable (auto-set by Pushify)',
      required: false,
      type: 'url',
      hidden: true,
    },
  ],
  minMemoryMb: 2048,
  minDiskGb: 5,
  version: '1.1.0',
  appVersion: 'latest',
  featured: true,
  volumes: ['calcom-db'],
};
