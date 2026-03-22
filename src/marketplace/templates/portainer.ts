import type { MarketplaceTemplate } from '../types';

export const portainer: MarketplaceTemplate = {
  id: 'portainer',
  name: 'Portainer',
  description: 'Container management UI for Docker. Visualize and manage your containers.',
  longDescription: 'Portainer is a lightweight management UI that allows you to easily manage Docker environments. It provides a web-based interface for managing containers, images, volumes, and networks without needing to use the CLI.',
  icon: 'Container',
  category: 'devtools',
  tags: ['docker', 'containers', 'management', 'ui'],
  website: 'https://www.portainer.io',
  documentation: 'https://docs.portainer.io',
  dockerImage: 'portainer/portainer-ce:latest',
  port: 9000,
  healthCheckPath: '/api/status',
  envVars: [],
  minMemoryMb: 64,
  minDiskGb: 1,
  version: '1.0.0',
  appVersion: '2.19',
  featured: false,
  volumes: ['/data', '/var/run/docker.sock:/var/run/docker.sock'],
};
