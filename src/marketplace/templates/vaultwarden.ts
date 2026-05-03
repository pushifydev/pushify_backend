import type { MarketplaceTemplate } from '../types';

export const vaultwarden: MarketplaceTemplate = {
  id: 'vaultwarden',
  name: 'Vaultwarden',
  description: 'Self-hosted Bitwarden — secure password manager for individuals and teams',
  longDescription: `Vaultwarden is an unofficial Bitwarden compatible server written in Rust,
formerly known as bitwarden_rs. Lighter than the official server and works with all
official Bitwarden clients (web, desktop, mobile, browser extensions).

- **End-to-end encrypted** password vault
- **All Bitwarden clients** work out of the box
- **2FA / TOTP** built-in authenticator
- **Organizations** for team password sharing
- **Send** secure file/text sharing
- **Lightweight** — runs on as little as 64MB RAM`,
  icon: 'Lock',
  category: 'devtools',
  tags: ['security', 'password-manager', 'bitwarden', 'self-hosted'],
  website: 'https://github.com/dani-garcia/vaultwarden',
  documentation: 'https://github.com/dani-garcia/vaultwarden/wiki',

  deploymentType: 'single-container',
  dockerImage: 'vaultwarden/server:latest',
  port: 80,
  healthCheckPath: '/alive',
  envVars: [
    {
      key: 'ADMIN_TOKEN',
      label: 'Admin Token',
      description: 'Token for accessing /admin panel — keep secret!',
      required: true,
      type: 'password',
      generate: 'secret',
    },
    {
      key: 'SIGNUPS_ALLOWED',
      label: 'Allow Public Signups',
      description: 'Set to "false" after creating your account to prevent strangers from registering',
      required: false,
      type: 'text',
      default: 'true',
    },
    {
      key: 'WEBSOCKET_ENABLED',
      label: 'Enable WebSocket',
      description: 'Real-time vault sync across clients',
      required: false,
      type: 'text',
      default: 'true',
      hidden: true,
    },
    {
      key: 'DOMAIN',
      label: 'Domain',
      description: 'Public URL where Vaultwarden is reachable (e.g. https://vault.yourdomain.com)',
      required: false,
      type: 'url',
    },
  ],
  minMemoryMb: 256,
  minDiskGb: 1,
  version: '1.0.0',
  appVersion: 'latest',
  featured: true,
  volumes: ['/data'],
};
