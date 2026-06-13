export type SiteBlockType =
  | 'hero'
  | 'features'
  | 'text'
  | 'cta'
  | 'faq'
  | 'pricing'
  | 'banner'
  | 'stats'
  | 'footer';

export interface SiteSeo {
  title: string;
  description: string;
  ogImage: string;
  keywords: string;
}

export interface HeroBlock {
  id: string;
  type: 'hero';
  headline: string;
  subheadline: string;
  ctaText: string;
  ctaUrl: string;
}

export interface FeatureItem {
  title: string;
  description: string;
}

export interface FeaturesBlock {
  id: string;
  type: 'features';
  title: string;
  items: FeatureItem[];
}

export interface TextBlock {
  id: string;
  type: 'text';
  title: string;
  body: string;
}

export interface CtaBlock {
  id: string;
  type: 'cta';
  title: string;
  description: string;
  buttonText: string;
  buttonUrl: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface FaqBlock {
  id: string;
  type: 'faq';
  title: string;
  items: FaqItem[];
}

export interface PricingPlan {
  name: string;
  price: string;
  period: string;
  features: string[];
  ctaText: string;
  ctaUrl: string;
  highlighted: boolean;
}

export interface PricingBlock {
  id: string;
  type: 'pricing';
  title: string;
  plans: PricingPlan[];
}

export interface BannerBlock {
  id: string;
  type: 'banner';
  imageUrl: string;
  headline: string;
  subheadline: string;
  overlayOpacity: number;
}

export interface StatItem {
  value: string;
  label: string;
}

export interface StatsBlock {
  id: string;
  type: 'stats';
  items: StatItem[];
}

export interface FooterLink {
  label: string;
  url: string;
}

export interface FooterBlock {
  id: string;
  type: 'footer';
  copyright: string;
  links: FooterLink[];
}

export type SiteBlock =
  | HeroBlock
  | FeaturesBlock
  | TextBlock
  | CtaBlock
  | FaqBlock
  | PricingBlock
  | BannerBlock
  | StatsBlock
  | FooterBlock;

/** A single page of a multi-page site. The first page (slug '') is the home page. */
export interface SitePage {
  id: string;
  title: string;
  /** URL path segment. Empty string = home (served at /). */
  slug: string;
  blocks: SiteBlock[];
  seo: SiteSeo;
}

export type CmsMode = 'builtin' | 'strapi' | 'directus';

export interface CmsConfig {
  mode: CmsMode;
  apiUrl?: string;
  apiToken?: string;
  collection?: string;
  hasApiToken?: boolean;
}

export const DEFAULT_SEO: SiteSeo = {
  title: '',
  description: '',
  ogImage: '',
  keywords: '',
};

export const BLOCK_TYPE_ORDER: SiteBlockType[] = [
  'hero',
  'banner',
  'features',
  'stats',
  'text',
  'pricing',
  'faq',
  'cta',
  'footer',
];
