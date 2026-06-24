import type { MarketplaceTemplate } from '../types';

export const strapi: MarketplaceTemplate = {
  id: 'strapi',
  name: 'Strapi',
  description: 'Open-source headless CMS with customizable API and admin panel.',
  longDescription: 'Strapi is the leading open-source headless CMS. It enables developers to build, deploy, and manage content APIs quickly. Features include a customizable admin panel, role-based access, REST & GraphQL APIs, and plugin system.',
  icon: 'Layers',
  category: 'cms',
  tags: ['headless-cms', 'api', 'graphql', 'nodejs'],
  website: 'https://strapi.io',
  documentation: 'https://docs.strapi.io',
  deploymentType: 'single-container',
  dockerImage: 'elestio/strapi-development:latest',
  port: 1337,
  healthCheckPath: '/_health',
  // Strapi needs a real database — Pushify auto-provisions Postgres and injects the
  // DATABASE_* connection env vars. (The default SQLite needs the native better-sqlite3
  // module, which isn't present in the image and makes Strapi crash-loop on boot.)
  requiresDatabase: { type: 'postgresql', version: '16' },
  envVars: [
    { key: 'DATABASE_CLIENT', label: 'Database Client', description: 'Database driver (auto-set by Pushify)', required: false, default: 'postgres', type: 'text', hidden: true },
    { key: 'DATABASE_SSL', label: 'Database SSL', description: 'Use SSL for the database connection (auto-set by Pushify)', required: false, default: 'false', type: 'text', hidden: true },
    { key: 'APP_KEYS', label: 'App Keys', description: 'Session keys (comma separated)', required: true, type: 'text', generate: 'secret', hidden: true },
    { key: 'API_TOKEN_SALT', label: 'API Token Salt', description: 'Salt for API tokens', required: true, type: 'text', generate: 'secret', hidden: true },
    { key: 'ADMIN_JWT_SECRET', label: 'Admin JWT Secret', description: 'Secret for admin JWT', required: true, type: 'text', generate: 'secret', hidden: true },
    { key: 'JWT_SECRET', label: 'JWT Secret', description: 'Secret for user JWT', required: true, type: 'text', generate: 'secret', hidden: true },
    { key: 'TRANSFER_TOKEN_SALT', label: 'Transfer Token Salt', description: 'Salt for transfer tokens', required: true, type: 'text', generate: 'secret', hidden: true },
  ],
  minMemoryMb: 1024,
  minDiskGb: 5,
  version: '1.0.1',
  appVersion: '4.25',
  featured: false,
  volumes: ['/srv/app'],
};
