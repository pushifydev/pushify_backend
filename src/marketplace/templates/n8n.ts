import type { MarketplaceTemplate } from '../types';

export const n8n: MarketplaceTemplate = {
  id: 'n8n',
  name: 'n8n',
  description: 'Workflow automation tool with 400+ integrations. Self-hosted alternative to Zapier.',
  longDescription: 'n8n is a free and open-source workflow automation tool. It connects your apps, services, and APIs to automate tasks without writing code. With 400+ integrations and a visual workflow builder, n8n is the self-hosted alternative to Zapier and Make.',
  icon: 'Zap',
  category: 'automation',
  tags: ['automation', 'workflow', 'integrations', 'no-code'],
  website: 'https://n8n.io',
  documentation: 'https://docs.n8n.io',
  dockerImage: 'n8nio/n8n:latest',
  port: 5678,
  healthCheckPath: '/healthz',
  envVars: [
    { key: 'N8N_BASIC_AUTH_ACTIVE', label: 'Enable Auth', description: 'Enable basic authentication', required: false, default: 'true', type: 'text' },
    { key: 'N8N_BASIC_AUTH_USER', label: 'Auth User', description: 'Basic auth username', required: true, default: 'admin', type: 'text' },
    { key: 'N8N_BASIC_AUTH_PASSWORD', label: 'Auth Password', description: 'Basic auth password', required: true, type: 'password', generate: 'password' },
    { key: 'N8N_ENCRYPTION_KEY', label: 'Encryption Key', description: 'Key for encrypting credentials', required: true, type: 'text', generate: 'secret' },
    { key: 'WEBHOOK_URL', label: 'Webhook URL', description: 'External URL for webhooks', required: false, type: 'url' },
  ],
  minMemoryMb: 256,
  minDiskGb: 1,
  version: '1.0.0',
  appVersion: '1.64',
  featured: true,
  volumes: ['/home/node/.n8n'],
};
