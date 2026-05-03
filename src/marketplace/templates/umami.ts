import type { MarketplaceTemplate } from '../types';

export const umami: MarketplaceTemplate = {
  id: 'umami',
  name: 'Umami',
  description: 'Privacy-friendly, open-source Google Analytics alternative',
  longDescription: `Umami is a simple, fast, privacy-focused alternative to Google Analytics.

- **No cookies** — no GDPR / cookie banner needed
- **Privacy-first** — anonymized data, no personal info
- **Lightweight tracker** (~2KB script)
- **Beautiful dashboards** with realtime data
- **Multi-site** support from a single instance
- **Custom events** and goals tracking
- **Open source** with 22K+ stars`,
  icon: 'BarChart3',
  category: 'analytics',
  tags: ['analytics', 'privacy', 'google-analytics-alternative', 'gdpr'],
  website: 'https://umami.is',
  documentation: 'https://umami.is/docs/',

  deploymentType: 'single-container',
  dockerImage: 'ghcr.io/umami-software/umami:postgresql-latest',
  port: 3000,
  healthCheckPath: '/api/heartbeat',
  requiresDatabase: { type: 'postgresql', version: '16' },
  envVars: [
    {
      key: 'APP_SECRET',
      label: 'App Secret',
      description: 'Random string for cookies and session encryption',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'HASH_SALT',
      label: 'Hash Salt',
      description: 'Salt used to hash visitor IPs (privacy)',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'DATABASE_TYPE',
      label: 'Database Type',
      description: 'Database driver (auto-set by Pushify)',
      required: false,
      type: 'text',
      default: 'postgresql',
      hidden: true,
    },
  ],
  minMemoryMb: 512,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: 'latest',
  featured: true,
};
