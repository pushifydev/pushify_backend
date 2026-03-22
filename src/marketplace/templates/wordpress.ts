import type { MarketplaceTemplate } from '../types';

export const wordpress: MarketplaceTemplate = {
  id: 'wordpress',
  name: 'WordPress',
  description: 'The most popular open-source CMS powering 40% of the web.',
  longDescription: 'WordPress is a free and open-source content management system. It is the most popular website builder, powering over 40% of all websites on the internet. Features include themes, plugins, a visual editor, and a robust REST API.',
  icon: 'FileText',
  category: 'cms',
  tags: ['blog', 'website', 'cms', 'php'],
  website: 'https://wordpress.org',
  documentation: 'https://developer.wordpress.org',
  dockerImage: 'wordpress:6.4-apache',
  port: 80,
  healthCheckPath: '/',
  envVars: [
    { key: 'WORDPRESS_DB_HOST', label: 'Database Host', description: 'MySQL database host', required: true, type: 'text' },
    { key: 'WORDPRESS_DB_USER', label: 'Database User', description: 'MySQL database user', required: true, default: 'wordpress', type: 'text' },
    { key: 'WORDPRESS_DB_PASSWORD', label: 'Database Password', description: 'MySQL database password', required: true, type: 'password', generate: 'password' },
    { key: 'WORDPRESS_DB_NAME', label: 'Database Name', description: 'MySQL database name', required: true, default: 'wordpress', type: 'text' },
  ],
  minMemoryMb: 256,
  minDiskGb: 2,
  requiresDatabase: { type: 'mysql', version: '8.0' },
  version: '1.0.0',
  appVersion: '6.4',
  featured: true,
  volumes: ['/var/www/html'],
};
