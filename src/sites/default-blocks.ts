import type { SiteBlock } from './block-types';
import type { SiteTheme } from './theme';
import { getTemplateDesign } from './site-templates';

/**
 * Starter blocks for a freshly launched Site Studio project. The actual designs live in
 * `site-templates.ts` — this just resolves the right one for the template id.
 */
export function defaultBlocksForTemplate(templateId?: string, siteName?: string): SiteBlock[] {
  return getTemplateDesign(templateId).blocks(siteName || 'Your Business');
}

/** Theme overrides for a template (merged on top of DEFAULT_SITE_THEME by the caller). */
export function defaultThemeForTemplate(templateId?: string): Partial<SiteTheme> {
  return getTemplateDesign(templateId).theme;
}
