import type { MarketplaceTemplate } from '../types';

export const plausible: MarketplaceTemplate = {
  id: 'plausible',
  name: 'Plausible Analytics',
  description: 'Privacy-friendly web analytics. Simple, lightweight Google Analytics alternative.',
  longDescription: 'Plausible Analytics is a lightweight and open-source web analytics tool. It does not use cookies, is fully compliant with GDPR, CCPA, and PECR, and the script is less than 1KB. A privacy-friendly alternative to Google Analytics.',
  icon: 'BarChart3',
  category: 'analytics',
  tags: ['analytics', 'privacy', 'web-analytics', 'gdpr'],
  website: 'https://plausible.io',
  documentation: 'https://plausible.io/docs',
  dockerImage: 'ghcr.io/plausible/community-edition:v2',
  port: 8000,
  healthCheckPath: '/api/health',
  envVars: [
    { key: 'BASE_URL', label: 'Base URL', description: 'Public URL of your Plausible instance', required: true, type: 'url' },
    { key: 'SECRET_KEY_BASE', label: 'Secret Key', description: 'Secret key for sessions (min 64 chars)', required: true, type: 'text', generate: 'secret' },
    { key: 'DATABASE_URL', label: 'Database URL', description: 'PostgreSQL connection string', required: true, type: 'text' },
    { key: 'CLICKHOUSE_DATABASE_URL', label: 'ClickHouse URL', description: 'ClickHouse connection string', required: true, type: 'text' },
  ],
  minMemoryMb: 512,
  minDiskGb: 5,
  requiresDatabase: { type: 'postgresql' },
  version: '1.0.0',
  appVersion: '2.1',
  featured: false,
  volumes: [],
};
