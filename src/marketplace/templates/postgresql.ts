import type { MarketplaceTemplate } from '../types';

export const postgresql: MarketplaceTemplate = {
  id: 'postgresql',
  name: 'PostgreSQL',
  description: 'The most advanced open-source relational database.',
  longDescription: 'PostgreSQL is a powerful, open-source object-relational database system with over 35 years of active development. It has earned a strong reputation for reliability, feature robustness, and performance.',
  icon: 'Database',
  category: 'database',
  tags: ['database', 'sql', 'relational', 'acid'],
  website: 'https://www.postgresql.org',
  documentation: 'https://www.postgresql.org/docs/',
  dockerImage: 'postgres:16-alpine',
  port: 5432,
  healthCheckPath: '/',
  envVars: [
    { key: 'POSTGRES_USER', label: 'Username', description: 'Superuser username', required: true, default: 'postgres', type: 'text' },
    { key: 'POSTGRES_PASSWORD', label: 'Password', description: 'Superuser password', required: true, type: 'password', generate: 'password' },
    { key: 'POSTGRES_DB', label: 'Database', description: 'Default database name', required: false, default: 'postgres', type: 'text' },
  ],
  minMemoryMb: 128,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: '16',
  featured: false,
  volumes: ['/var/lib/postgresql/data'],
};
