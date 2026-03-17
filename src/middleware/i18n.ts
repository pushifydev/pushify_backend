import type { Context, Next } from 'hono';
import { parseAcceptLanguage, type SupportedLocale } from '../i18n';

/**
 * i18n middleware - detects locale from Accept-Language header
 * and sets it in the context for use in responses
 */
export async function i18nMiddleware(c: Context, next: Next) {
  const acceptLanguage = c.req.header('Accept-Language');
  const locale = parseAcceptLanguage(acceptLanguage);

  c.set('locale', locale);

  await next();
}

/**
 * Helper to get locale from context
 */
export function getLocale(c: Context): SupportedLocale {
  return c.get('locale') || 'en';
}
