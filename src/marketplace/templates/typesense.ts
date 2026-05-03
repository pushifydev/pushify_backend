import type { MarketplaceTemplate } from '../types';

export const typesense: MarketplaceTemplate = {
  id: 'typesense',
  name: 'Typesense',
  description: 'Open-source, typo-tolerant search engine optimized for instant search',
  longDescription: `Typesense is an open-source, typo-tolerant search engine optimized for
instant (typically sub-50ms) search-as-you-type experiences and developer productivity.

- **Typo-tolerant** search with built-in fuzzy matching
- **Faceted search** and dynamic filtering
- **Geo-search** with radius queries
- **Synonyms** and curated results
- **Vector search** for semantic search
- **Multi-tenancy** with scoped API keys
- Easy to use **REST API**`,
  icon: 'Search',
  category: 'devtools',
  tags: ['search', 'algolia-alternative', 'vector', 'instant-search'],
  website: 'https://typesense.org',
  documentation: 'https://typesense.org/docs/',

  deploymentType: 'single-container',
  dockerImage: 'typesense/typesense:0.25.2',
  dockerCommand: '--data-dir /data --api-key=${TYPESENSE_API_KEY} --enable-cors',
  port: 8108,
  healthCheckPath: '/health',
  envVars: [
    {
      key: 'TYPESENSE_API_KEY',
      label: 'API Key',
      description: 'Master API key for accessing Typesense',
      required: true,
      type: 'password',
      generate: 'secret',
    },
  ],
  minMemoryMb: 512,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: '0.25',
  featured: false,
  volumes: ['/data'],
};
