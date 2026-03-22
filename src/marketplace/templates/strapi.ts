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
  dockerImage: 'elestio/strapi-development:latest',
  port: 1337,
  healthCheckPath: '/_health',
  envVars: [
    { key: 'DATABASE_CLIENT', label: 'DB Client', description: 'Database type (sqlite, postgres, mysql)', required: false, default: 'sqlite', type: 'text' },
    { key: 'APP_KEYS', label: 'App Keys', description: 'Session keys (comma separated)', required: true, type: 'text', generate: 'secret' },
    { key: 'API_TOKEN_SALT', label: 'API Token Salt', description: 'Salt for API tokens', required: true, type: 'text', generate: 'secret' },
    { key: 'ADMIN_JWT_SECRET', label: 'Admin JWT Secret', description: 'Secret for admin JWT', required: true, type: 'text', generate: 'secret' },
    { key: 'JWT_SECRET', label: 'JWT Secret', description: 'Secret for user JWT', required: true, type: 'text', generate: 'secret' },
  ],
  minMemoryMb: 512,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: '4.25',
  featured: false,
  volumes: ['/srv/app'],
};
