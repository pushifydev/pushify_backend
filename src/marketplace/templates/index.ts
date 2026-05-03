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
import { supabaseTemplate } from './supabase';
import { pocketbase } from './pocketbase';
import { meilisearch } from './meilisearch';
import { typesense } from './typesense';
import { directus } from './directus';
import { hasura } from './hasura';
import { appwrite } from './appwrite';
import { vaultwarden } from './vaultwarden';
import { nocodb } from './nocodb';
import { umami } from './umami';
import { nextcloud } from './nextcloud';
import { codeServer } from './code-server';
import { calcom } from './calcom';

export const templates: MarketplaceTemplate[] = [
  // ── Backend-as-a-Service / Database platforms ──
  supabaseTemplate,
  appwrite,
  pocketbase,
  hasura,
  directus,
  nocodb,
  // ── Search engines ──
  meilisearch,
  typesense,
  // ── CMS ──
  wordpress,
  ghost,
  strapi,
  // ── Productivity / Collaboration ──
  nextcloud,
  calcom,
  // ── DevTools ──
  codeServer,
  vaultwarden,
  n8n,
  uptimeKuma,
  gitea,
  portainer,
  // ── Storage / Analytics ──
  minio,
  umami,
  plausible,
  // ── Standalone databases ──
  postgresql,
  redis,
];

export function getTemplateById(id: string): MarketplaceTemplate | undefined {
  return templates.find((t) => t.id === id);
}
