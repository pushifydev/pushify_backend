import type { MarketplaceTemplate } from '../types';

export const directus: MarketplaceTemplate = {
  id: 'directus',
  name: 'Directus',
  description: 'Open-source headless CMS and instant REST + GraphQL API for any SQL database',
  longDescription: `Directus is an Open Data Platform built to democratize the database. It provides
everyone on your team, regardless of technical skill, equal access to data and digital file
asset management.

- **Headless CMS** with a beautiful no-code admin app
- **Instant REST + GraphQL API** for any SQL database
- **File library** with image transformations
- **Roles & permissions** with granular access control
- **Webhooks & flows** for automation
- **Real-time updates** via subscriptions
- **Multi-language** content management`,
  icon: 'FileText',
  category: 'cms',
  tags: ['cms', 'headless', 'graphql', 'rest', 'admin'],
  website: 'https://directus.io',
  documentation: 'https://docs.directus.io',

  deploymentType: 'single-container',
  dockerImage: 'directus/directus:11',
  port: 8055,
  healthCheckPath: '/server/health',
  requiresDatabase: { type: 'postgresql', version: '16' },
  envVars: [
    {
      key: 'ADMIN_EMAIL',
      label: 'Admin Email',
      description: 'Email for the initial admin user',
      required: true,
      type: 'email',
    },
    {
      key: 'ADMIN_PASSWORD',
      label: 'Admin Password',
      description: 'Password for the initial admin user',
      required: true,
      type: 'password',
      generate: 'password',
    },
    {
      key: 'KEY',
      label: 'Secret Key',
      description: 'Random string for cookies and tokens',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'SECRET',
      label: 'JWT Secret',
      description: 'Secret used to sign JWT tokens',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'DB_CLIENT',
      label: 'Database Client',
      description: 'Database driver (auto-set by Pushify)',
      required: false,
      type: 'text',
      default: 'pg',
      hidden: true,
    },
  ],
  minMemoryMb: 1024,
  minDiskGb: 5,
  version: '1.0.0',
  appVersion: '11',
  featured: true,
  volumes: ['/directus/uploads'],
};
