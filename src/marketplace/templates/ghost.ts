import type { MarketplaceTemplate } from '../types';

export const ghost: MarketplaceTemplate = {
  id: 'ghost',
  name: 'Ghost',
  description: 'Professional publishing platform for blogs, newsletters, and paid subscriptions.',
  longDescription: 'Ghost is a powerful open-source publishing platform for professional bloggers and publishers. Built on Node.js, it features a modern editor, built-in SEO, native newsletters, memberships, and paid subscriptions out of the box.',
  icon: 'Pen',
  category: 'cms',
  tags: ['blog', 'newsletter', 'publishing', 'nodejs'],
  website: 'https://ghost.org',
  documentation: 'https://ghost.org/docs',
  dockerImage: 'ghost:5-alpine',
  port: 2368,
  healthCheckPath: '/ghost/api/v4/admin/site/',
  envVars: [
    { key: 'url', label: 'Site URL', description: 'Public URL of your Ghost site', required: true, type: 'url' },
    { key: 'database__client', label: 'DB Client', description: 'Database client', required: false, default: 'sqlite3', type: 'text' },
    { key: 'database__connection__filename', label: 'DB Path', description: 'SQLite database path', required: false, default: '/var/lib/ghost/content/data/ghost.db', type: 'text' },
  ],
  minMemoryMb: 256,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: '5.82',
  featured: false,
  volumes: ['/var/lib/ghost/content'],
};
