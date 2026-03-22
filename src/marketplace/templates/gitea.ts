import type { MarketplaceTemplate } from '../types';

export const gitea: MarketplaceTemplate = {
  id: 'gitea',
  name: 'Gitea',
  description: 'Lightweight self-hosted Git service. GitHub/GitLab alternative.',
  longDescription: 'Gitea is a painless self-hosted Git service. It is lightweight, easy to install, and runs great on minimal hardware. Features include repositories, issues, pull requests, CI/CD (Gitea Actions), packages, and wikis.',
  icon: 'GitBranch',
  category: 'devtools',
  tags: ['git', 'repository', 'ci-cd', 'code-hosting'],
  website: 'https://gitea.io',
  documentation: 'https://docs.gitea.com',
  dockerImage: 'gitea/gitea:latest',
  port: 3000,
  healthCheckPath: '/api/healthz',
  envVars: [
    { key: 'GITEA__database__DB_TYPE', label: 'DB Type', description: 'Database type (sqlite3, postgres, mysql)', required: false, default: 'sqlite3', type: 'text' },
    { key: 'GITEA__server__ROOT_URL', label: 'Root URL', description: 'Public URL of your Gitea instance', required: false, type: 'url' },
    { key: 'GITEA__security__SECRET_KEY', label: 'Secret Key', description: 'Global secret key', required: true, type: 'text', generate: 'secret' },
  ],
  minMemoryMb: 128,
  minDiskGb: 2,
  version: '1.0.0',
  appVersion: '1.21',
  featured: false,
  volumes: ['/data'],
};
