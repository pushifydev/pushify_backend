import type { MarketplaceTemplate } from '../types';

export const meilisearch: MarketplaceTemplate = {
  id: 'meilisearch',
  name: 'Meilisearch',
  description: 'Lightning-fast, open-source search engine — Algolia alternative',
  longDescription: `Meilisearch is a powerful, fast, open-source, easy to use, and deploy search engine.
Both searching and indexing are highly customizable. Features such as typo tolerance, filters,
and synonyms are provided out-of-the-box.

- **Sub-50ms response times** for most queries
- **Typo-tolerant** search with smart corrections
- **Faceted search** and filtering
- **Geo-search** support
- **Multi-tenant** with API key management
- Used in production by **Louis Vuitton, OpenAI, Lacoste**`,
  icon: 'Search',
  category: 'devtools',
  tags: ['search', 'algolia-alternative', 'full-text'],
  website: 'https://www.meilisearch.com',
  documentation: 'https://www.meilisearch.com/docs',

  deploymentType: 'single-container',
  dockerImage: 'getmeili/meilisearch:v1.10',
  port: 7700,
  healthCheckPath: '/health',
  envVars: [
    {
      key: 'MEILI_MASTER_KEY',
      label: 'Master Key',
      description: 'Master API key for protected access (min 16 chars)',
      required: true,
      type: 'password',
      generate: 'secret',
    },
    {
      key: 'MEILI_ENV',
      label: 'Environment',
      description: 'Set to "production" for prod, "development" for dev (enables web UI)',
      required: false,
      type: 'text',
      default: 'production',
    },
    {
      key: 'MEILI_NO_ANALYTICS',
      label: 'Disable Analytics',
      description: 'Disable telemetry sent to Meilisearch',
      required: false,
      type: 'text',
      default: 'true',
    },
  ],
  minMemoryMb: 512,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: '1.10',
  featured: true,
  volumes: ['/meili_data'],
};
