import type { MarketplaceTemplate } from '../types';

export const nocodb: MarketplaceTemplate = {
  id: 'nocodb',
  name: 'NocoDB',
  description: 'Open-source Airtable alternative — turn any database into a smart spreadsheet',
  longDescription: `NocoDB is an open-source Airtable alternative. It works on top of any
relational database (MySQL, PostgreSQL, SQL Server, SQLite, MariaDB) and provides a
spreadsheet-like UI to manage data.

- **Spreadsheet UI** for any SQL database
- **REST + GraphQL APIs** auto-generated
- **Roles & permissions** with granular access
- **Form, Gallery, Kanban, Grid** views
- **Webhooks & Zapier** integrations
- **Collaborative** real-time editing
- 50K+ stars on GitHub`,
  icon: 'Database',
  category: 'cms',
  tags: ['airtable-alternative', 'no-code', 'spreadsheet', 'database-ui'],
  website: 'https://nocodb.com',
  documentation: 'https://docs.nocodb.com',

  deploymentType: 'single-container',
  dockerImage: 'nocodb/nocodb:latest',
  port: 8080,
  healthCheckPath: '/api/v1/health',
  requiresDatabase: { type: 'postgresql', version: '16' },
  envVars: [
    {
      key: 'NC_AUTH_JWT_SECRET',
      label: 'JWT Secret',
      description: 'Secret for signing user session tokens',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'NC_DB',
      label: 'Database Connection String',
      description: 'Auto-built by Pushify if database is provisioned (leave blank)',
      required: false,
      type: 'text',
      hidden: true,
    },
    {
      key: 'NC_PUBLIC_URL',
      label: 'Public URL',
      description: 'Public URL where NocoDB is reachable (auto-set by Pushify)',
      required: false,
      type: 'url',
      hidden: true,
    },
    {
      key: 'NC_DISABLE_TELE',
      label: 'Disable Telemetry',
      description: 'Disable usage telemetry sent to NocoDB',
      required: false,
      type: 'text',
      default: 'true',
      hidden: true,
    },
  ],
  minMemoryMb: 512,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: 'latest',
  featured: true,
};
