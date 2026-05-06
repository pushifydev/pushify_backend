import type { MarketplaceTemplate } from '../types';

export const nextcloud: MarketplaceTemplate = {
  id: 'nextcloud',
  name: 'NextCloud',
  description: 'Self-hosted productivity platform — files, calendar, contacts, and more',
  longDescription: `Nextcloud is a content collaboration platform that enables you to access, share,
and collaborate across your devices.

- **File sync & share** — Google Drive / Dropbox alternative
- **Calendar & Contacts** — replace Google Calendar/Contacts
- **Photos** — automatic uploads from mobile
- **Office suite** — collaborative editing (Collabora/OnlyOffice)
- **Talk** — video calls and chat
- **End-to-end encryption** support
- **400+ apps** in the marketplace
- Used by **Deutsche Bahn, EU Commission, ownCloud**`,
  icon: 'HardDrive',
  category: 'storage',
  tags: ['cloud-storage', 'file-share', 'collaboration', 'google-drive-alternative'],
  website: 'https://nextcloud.com',
  documentation: 'https://docs.nextcloud.com',

  deploymentType: 'single-container',
  dockerImage: 'nextcloud:29-apache',
  port: 80,
  healthCheckPath: '/status.php',
  requiresDatabase: { type: 'postgresql', version: '16' },
  envVars: [
    {
      key: 'NEXTCLOUD_ADMIN_USER',
      label: 'Admin Username',
      description: 'Username for the initial admin account',
      required: true,
      type: 'text',
      default: 'admin',
    },
    {
      key: 'NEXTCLOUD_ADMIN_PASSWORD',
      label: 'Admin Password',
      description: 'Password for the initial admin account (min 10 characters recommended)',
      required: true,
      type: 'password',
      generate: 'password',
    },
    {
      key: 'NEXTCLOUD_TRUSTED_DOMAINS',
      label: 'Trusted Domains',
      description: 'Space-separated list of domains allowed to access Nextcloud (use * for any)',
      required: false,
      type: 'text',
      default: '*',
    },
    {
      key: 'POSTGRES_HOST',
      label: 'Postgres Host',
      description: 'Auto-set by Pushify',
      required: false,
      type: 'text',
      hidden: true,
    },
  ],
  minMemoryMb: 1024,
  minDiskGb: 10,
  version: '1.0.0',
  appVersion: '29',
  featured: true,
  volumes: ['/var/www/html'],
};
