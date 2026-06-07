export type SiteFontFamily = 'system' | 'serif' | 'rounded' | 'mono';
export type SiteBorderRadius = 'none' | 'sm' | 'md' | 'lg';
export type SiteMaxWidth = 'narrow' | 'default' | 'wide';

export interface SiteTheme {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  mutedColor: string;
  fontFamily: SiteFontFamily;
  borderRadius: SiteBorderRadius;
  maxWidth: SiteMaxWidth;
}

export const DEFAULT_SITE_THEME: SiteTheme = {
  primaryColor: '#6366f1',
  accentColor: '#818cf8',
  backgroundColor: '#fafafa',
  surfaceColor: '#ffffff',
  textColor: '#18181b',
  mutedColor: '#71717a',
  fontFamily: 'system',
  borderRadius: 'md',
  maxWidth: 'default',
};

export function normalizeSiteTheme(theme?: Partial<SiteTheme> | null): SiteTheme {
  return { ...DEFAULT_SITE_THEME, ...theme };
}

export function themeToCss(theme: SiteTheme): string {
  const fonts: Record<SiteFontFamily, string> = {
    system: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    serif: 'Georgia,"Times New Roman",serif',
    rounded: '"Nunito",system-ui,sans-serif',
    mono: 'ui-monospace,SFMono-Regular,Menlo,monospace',
  };
  const radius: Record<SiteBorderRadius, string> = {
    none: '0',
    sm: '.375rem',
    md: '.75rem',
    lg: '1.25rem',
  };
  const width: Record<SiteMaxWidth, string> = {
    narrow: '720px',
    default: '960px',
    wide: '1140px',
  };

  return `
    :root{
      --primary:${theme.primaryColor};
      --accent:${theme.accentColor};
      --bg:${theme.backgroundColor};
      --surface:${theme.surfaceColor};
      --text:${theme.textColor};
      --muted:${theme.mutedColor};
      --radius:${radius[theme.borderRadius]};
      --max:${width[theme.maxWidth]};
    }
    body{font-family:${fonts[theme.fontFamily]};color:var(--text);background:var(--bg)}
  `.trim();
}
