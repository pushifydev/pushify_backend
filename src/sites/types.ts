export type SiteStudioCategory =
  | 'ecommerce'
  | 'corporate'
  | 'blog'
  | 'portfolio'
  | 'restaurant'
  | 'newsletter'
  | 'booking'
  | 'saas';

export type SiteStudioStack =
  | 'static'
  | 'wordpress'
  | 'ghost'
  | 'strapi'
  | 'directus'
  | 'pocketbase'
  | 'calcom';

export interface SiteStudioLaunchField {
  envKey: string;
  label: string;
  description: string;
  type: 'email' | 'text';
  required: boolean;
}

export interface PaymentIntegrationInfo {
  id: string;
  name: string;
  region: 'tr' | 'global';
  setupNote: string;
}

export interface SetupGuideStep {
  title: string;
  description: string;
}

export interface SiteStudioTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  longDescription: string;
  category: SiteStudioCategory;
  /** Underlying platform shown to users (not always WordPress) */
  stack: SiteStudioStack;
  icon: string;
  accent: string;
  /**
   * 'cms' (default) deploys the underlying app container (WordPress/Strapi/…).
   * 'static' skips any app deploy — the block-based site is published as static HTML
   * and served directly by Nginx (no CMS).
   */
  deployment?: 'cms' | 'static';
  /** Underlying marketplace app to deploy — required for 'cms', unused for 'static'. */
  marketplaceTemplateId?: string;
  /** Extra fields collected in launch wizard (e.g. admin email) */
  launchFields?: SiteStudioLaunchField[];
  featured: boolean;
  estimatedMinutes: number;
  features: string[];
  paymentIntegrations?: PaymentIntegrationInfo[];
  setupGuide: SetupGuideStep[];
  presetEnvVars?: Record<string, string>;
  suggestedPlugins?: string[];
}
