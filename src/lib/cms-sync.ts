import { decrypt } from './encryption';
import { logger } from './logger';
import type { CmsConfig, SiteBlock, SiteSeo } from '../sites/block-types';

export interface CmsSyncResult {
  ok: boolean;
  message: string;
}

function blocksToPlainText(blocks: SiteBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'hero':
          return `${b.headline}\n${b.subheadline}`;
        case 'features':
          return `${b.title}\n${b.items.map((i) => `${i.title}: ${i.description}`).join('\n')}`;
        case 'text':
          return `${b.title}\n${b.body}`;
        case 'cta':
          return `${b.title}\n${b.description}`;
        case 'footer':
          return b.copyright;
        case 'faq':
          return `${b.title}\n${b.items.map((i) => `${i.question}: ${i.answer}`).join('\n')}`;
        case 'pricing':
          return `${b.title}\n${b.plans.map((p) => `${p.name} ${p.price}${p.period}`).join('\n')}`;
        case 'banner':
          return `${b.headline}\n${b.subheadline}`;
        case 'stats':
          return b.items.map((s) => `${s.value} ${s.label}`).join('\n');
        default:
          return '';
      }
    })
    .join('\n\n');
}

/**
 * Phase 3 — push SEO + block summary to Strapi or Directus when configured.
 */
export async function syncToHeadlessCms(
  cms: CmsConfig,
  seo: SiteSeo,
  blocks: SiteBlock[],
): Promise<CmsSyncResult> {
  if (cms.mode === 'builtin' || !cms.apiUrl) {
    return { ok: true, message: 'Built-in CMS — content stored in Pushify' };
  }

  const token = cms.apiToken?.includes(':')
    ? decrypt(cms.apiToken)
    : cms.apiToken;

  if (!token) {
    return { ok: false, message: 'CMS API token is required for sync' };
  }

  const base = cms.apiUrl.replace(/\/$/, '');
  const collection = cms.collection || 'pages';
  const body = {
    data: {
      title: seo.title,
      slug: 'pushify-home',
      description: seo.description,
      content: blocksToPlainText(blocks),
    },
  };

  try {
    if (cms.mode === 'strapi') {
      const res = await fetch(`${base}/api/${collection}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, message: `Strapi sync failed: ${res.status} ${text.slice(0, 200)}` };
      }
      return { ok: true, message: 'Synced to Strapi' };
    }

    if (cms.mode === 'directus') {
      const res = await fetch(`${base}/items/${collection}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body.data),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, message: `Directus sync failed: ${res.status} ${text.slice(0, 200)}` };
      }
      return { ok: true, message: 'Synced to Directus' };
    }

    return { ok: false, message: 'Unsupported CMS mode' };
  } catch (err) {
    logger.warn({ err, mode: cms.mode }, 'CMS sync error');
    return { ok: false, message: err instanceof Error ? err.message : 'CMS sync failed' };
  }
}
