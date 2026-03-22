import type { MarketplaceTemplate } from '../types';

export const uptimeKuma: MarketplaceTemplate = {
  id: 'uptime-kuma',
  name: 'Uptime Kuma',
  description: 'Self-hosted monitoring tool like Uptime Robot. Beautiful status pages included.',
  longDescription: 'Uptime Kuma is a self-hosted monitoring tool. Monitor HTTP, TCP, DNS, and more with a beautiful UI. Features include status pages, notifications via 90+ services (Telegram, Discord, Slack, Email), and multi-language support.',
  icon: 'Activity',
  category: 'monitoring',
  tags: ['monitoring', 'uptime', 'status-page', 'alerts'],
  website: 'https://uptime.kuma.pet',
  documentation: 'https://github.com/louislam/uptime-kuma/wiki',
  dockerImage: 'louislam/uptime-kuma:latest',
  port: 3001,
  healthCheckPath: '/',
  envVars: [],
  minMemoryMb: 128,
  minDiskGb: 1,
  version: '1.0.0',
  appVersion: '1.23',
  featured: true,
  volumes: ['/app/data'],
};
