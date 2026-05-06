import type { MarketplaceTemplate } from '../types';

export const hasura: MarketplaceTemplate = {
  id: 'hasura',
  name: 'Hasura',
  description: 'Instant realtime GraphQL APIs on your data, with built-in authorization',
  longDescription: `Hasura is an open-source engine that gives you instant GraphQL & REST APIs
with authorization & event triggers — over Postgres, MS SQL Server, BigQuery, MySQL, and more.

- **Instant GraphQL & REST APIs** on your database
- **Granular authorization** with role-based access
- **Real-time subscriptions** out of the box
- **Event triggers** for serverless workflows
- **Schema stitching** & remote schemas
- **Caching** for high-performance APIs
- **Console UI** for managing schema, permissions, and metadata`,
  icon: 'Zap',
  category: 'devtools',
  tags: ['graphql', 'rest', 'api', 'realtime', 'backend'],
  website: 'https://hasura.io',
  documentation: 'https://hasura.io/docs/',

  deploymentType: 'single-container',
  dockerImage: 'hasura/graphql-engine:v2.40.0',
  port: 8080,
  healthCheckPath: '/healthz',
  requiresDatabase: { type: 'postgresql', version: '16' },
  envVars: [
    {
      key: 'HASURA_GRAPHQL_ADMIN_SECRET',
      label: 'Admin Secret',
      description: 'Secret for accessing the Hasura console and admin APIs',
      required: true,
      type: 'password',
      generate: 'secret',
    },
    {
      key: 'HASURA_GRAPHQL_ENABLE_CONSOLE',
      label: 'Enable Console',
      description: 'Enable the web console at /console',
      required: false,
      type: 'text',
      default: 'true',
    },
    {
      key: 'HASURA_GRAPHQL_DEV_MODE',
      label: 'Dev Mode',
      description: 'Show detailed error messages (set false for production)',
      required: false,
      type: 'text',
      default: 'false',
    },
    {
      key: 'HASURA_GRAPHQL_ENABLED_LOG_TYPES',
      label: 'Log Types',
      description: 'Which log types to enable',
      required: false,
      type: 'text',
      default: 'startup, http-log, webhook-log, websocket-log, query-log',
      hidden: true,
    },
    {
      key: 'HASURA_GRAPHQL_UNAUTHORIZED_ROLE',
      label: 'Unauthorized Role',
      description: 'Role assigned to requests without auth',
      required: false,
      type: 'text',
      default: 'anonymous',
      hidden: true,
    },
  ],
  minMemoryMb: 1024,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: '2.40',
  featured: true,
};
