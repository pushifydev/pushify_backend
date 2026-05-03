import type { MarketplaceTemplate } from '../types';

export const pocketbase: MarketplaceTemplate = {
  id: 'pocketbase',
  name: 'PocketBase',
  description: 'Open-source backend in a single file — Realtime, Auth, File Storage, REST API',
  longDescription: `PocketBase is an open source backend consisting of:

- Embedded **SQLite** database with realtime subscriptions
- Built-in **Auth** management with multiple providers
- Convenient **Admin Dashboard** UI
- Simple **REST-ish API** for managing your data
- **File storage** with image transformations

Ships as a single executable file — no external dependencies. Perfect for SaaS,
mobile apps, and rapid prototyping.

**After deploy:** Visit \`/_/\` (e.g. http://your-host:port/_/) to create your
first superuser via the setup wizard. The env vars are stored for reference
but the first admin must be created through the web UI.`,
  icon: 'Database',
  category: 'database',
  tags: ['backend', 'sqlite', 'realtime', 'auth', 'firebase-alternative'],
  website: 'https://pocketbase.io',
  documentation: 'https://pocketbase.io/docs/',

  deploymentType: 'single-container',
  dockerImage: 'ghcr.io/muchobien/pocketbase:latest',
  port: 8090,
  healthCheckPath: '/api/health',
  envVars: [
    {
      key: 'POCKETBASE_ADMIN_EMAIL',
      label: 'Admin Email',
      description: 'Email for the initial superuser account',
      required: true,
      type: 'email',
    },
    {
      key: 'POCKETBASE_ADMIN_PASSWORD',
      label: 'Admin Password',
      description: 'Password for the initial superuser (min 10 chars)',
      required: true,
      type: 'password',
      generate: 'password',
    },
  ],
  minMemoryMb: 256,
  minDiskGb: 1,
  version: '1.0.0',
  appVersion: '0.22',
  featured: true,
  volumes: ['/pb_data'],
};
