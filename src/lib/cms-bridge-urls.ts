import type { SiteStudioStack } from '../sites/types';

export interface CmsBridgeUrls {
  adminUrl: string | null;
  previewUrl: string | null;
  docsUrl: string | null;
  label: string;
}

// `static` sites have no CMS admin, so they intentionally have no entry — getCmsBridgeUrls
// returns a null adminUrl for any stack not listed here.
const STACK_PATHS: Partial<Record<SiteStudioStack, { path: string; label: string; docs?: string }>> = {
  wordpress: { path: '/wp-admin/', label: 'WordPress Admin', docs: 'https://wordpress.org/documentation/' },
  ghost: { path: '/ghost/', label: 'Ghost Admin', docs: 'https://ghost.org/docs/' },
  strapi: { path: '/admin', label: 'Strapi Admin', docs: 'https://docs.strapi.io/' },
  directus: { path: '/admin', label: 'Directus Studio', docs: 'https://docs.directus.io/' },
  pocketbase: { path: '/_/', label: 'PocketBase Admin', docs: 'https://pocketbase.io/docs/' },
  calcom: { path: '/auth/login', label: 'Cal.com', docs: 'https://cal.com/docs' },
};

export function getCmsBridgeUrls(
  stack: SiteStudioStack | string | undefined,
  baseUrl: string | null,
): CmsBridgeUrls {
  if (!baseUrl || !stack || !(stack in STACK_PATHS)) {
    return { adminUrl: null, previewUrl: baseUrl, docsUrl: null, label: 'CMS' };
  }

  const meta = STACK_PATHS[stack as SiteStudioStack];
  if (!meta) {
    return { adminUrl: null, previewUrl: baseUrl, docsUrl: null, label: 'CMS' };
  }
  const origin = baseUrl.replace(/\/$/, '');

  return {
    adminUrl: `${origin}${meta.path}`,
    previewUrl: origin,
    docsUrl: meta.docs ?? null,
    label: meta.label,
  };
}
