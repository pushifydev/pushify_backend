import { en, type TranslationKeys } from './locales/en';
import { tr } from './locales/tr';

export type SupportedLocale = 'en' | 'tr';

const translations: Record<SupportedLocale, TranslationKeys> = {
  en,
  tr,
};

export const DEFAULT_LOCALE: SupportedLocale = 'en';
export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'tr'];

/**
 * Parse Accept-Language header and return the best matching locale
 */
export function parseAcceptLanguage(header: string | undefined): SupportedLocale {
  if (!header) return DEFAULT_LOCALE;

  // Parse Accept-Language header (e.g., "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7")
  const languages = header
    .split(',')
    .map((lang) => {
      const [code, qValue] = lang.trim().split(';q=');
      return {
        code: code.split('-')[0].toLowerCase(), // Get base language code
        q: qValue ? parseFloat(qValue) : 1.0,
      };
    })
    .sort((a, b) => b.q - a.q);

  // Find the first supported locale
  for (const lang of languages) {
    if (SUPPORTED_LOCALES.includes(lang.code as SupportedLocale)) {
      return lang.code as SupportedLocale;
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Get translation function for a specific locale
 */
export function getTranslations(locale: SupportedLocale): TranslationKeys {
  return translations[locale] || translations[DEFAULT_LOCALE];
}

/**
 * Helper to get a nested translation value
 */
export function t(
  locale: SupportedLocale,
  category: keyof TranslationKeys,
  key: string
): string {
  const trans = translations[locale] || translations[DEFAULT_LOCALE];
  const categoryTrans = trans[category] as Record<string, string>;
  return categoryTrans[key] || key;
}

// Re-export types
export type { TranslationKeys };
