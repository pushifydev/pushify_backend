import type { MarketplaceTemplate } from '../types';
import { wordpress } from './wordpress';
import { strapi } from './strapi';
import { n8n } from './n8n';
import { uptimeKuma } from './uptime-kuma';
import { ghost } from './ghost';
import { minio } from './minio';
import { gitea } from './gitea';
import { portainer } from './portainer';
import { plausible } from './plausible';
import { redis } from './redis';
import { postgresql } from './postgresql';

export const templates: MarketplaceTemplate[] = [
  wordpress,
  n8n,
  uptimeKuma,
  strapi,
  ghost,
  minio,
  gitea,
  portainer,
  plausible,
  redis,
  postgresql,
];

export function getTemplateById(id: string): MarketplaceTemplate | undefined {
  return templates.find((t) => t.id === id);
}
