import { randomUUID } from 'crypto';
import type { SiteBlock } from './block-types';
import { DEFAULT_SITE_THEME, type SiteTheme } from './theme';

const id = () => randomUUID();
const year = () => new Date().getFullYear();

/**
 * A pickable, block-based site design. Each design ships its own theme (colors/font/radius)
 * and a starter block layout so every template the user picks looks distinct out of the box.
 * Add a new design here and map an id to it in `resolveTemplateDesignKey` — no other wiring.
 */
export interface SiteTemplateDesign {
  /** Theme overrides applied on top of DEFAULT_SITE_THEME. */
  theme: Partial<SiteTheme>;
  /** Builds a fresh block set (new ids) seeded with the site name. */
  blocks: (name: string) => SiteBlock[];
}

function footer(name: string): SiteBlock {
  return {
    id: id(),
    type: 'footer',
    copyright: `© ${year()} ${name}. All rights reserved.`,
    links: [
      { label: 'Privacy', url: '/privacy' },
      { label: 'Terms', url: '/terms' },
      { label: 'Contact', url: '#contact' },
    ],
  };
}

export const SITE_TEMPLATE_DESIGNS: Record<string, SiteTemplateDesign> = {
  // ── Corporate — clean, trustworthy, blue ────────────────────────────────
  corporate: {
    theme: { primaryColor: '#2563eb', accentColor: '#3b82f6', fontFamily: 'system', borderRadius: 'md' },
    blocks: (name) => [
      { id: id(), type: 'hero', headline: `Welcome to ${name}`, subheadline: 'We help you grow with modern digital solutions built on infrastructure you control.', ctaText: 'Get in touch', ctaUrl: '#contact' },
      { id: id(), type: 'features', title: 'Why choose us', items: [
        { title: 'Fast delivery', description: 'Launch quickly on your own infrastructure.' },
        { title: 'Secure hosting', description: 'Your data stays on servers you control.' },
        { title: 'Easy updates', description: 'Edit content anytime from the Pushify Site Editor.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: '10+', label: 'Years experience' },
        { value: '500+', label: 'Projects delivered' },
        { value: '99.9%', label: 'Uptime' },
      ] },
      { id: id(), type: 'cta', title: 'Ready to start?', description: 'Contact our team today and we will get back to you within one business day.', buttonText: 'Contact us', buttonUrl: 'mailto:hello@example.com' },
      footer(name),
    ],
  },

  // ── SaaS — product landing, indigo, rounded, with pricing ───────────────
  saas: {
    theme: { primaryColor: '#6366f1', accentColor: '#8b5cf6', backgroundColor: '#fafafa', fontFamily: 'rounded', borderRadius: 'lg' },
    blocks: (name) => [
      { id: id(), type: 'hero', headline: `${name} — ship faster`, subheadline: 'The all-in-one platform your team needs to build, launch and scale. No credit card required.', ctaText: 'Start free', ctaUrl: '#signup' },
      { id: id(), type: 'features', title: 'Everything you need', items: [
        { title: 'Lightning fast', description: 'Optimized for speed from the first request.' },
        { title: 'Built to scale', description: 'Grows with you from day one to millions of users.' },
        { title: 'Secure by default', description: 'Encryption, backups and access control included.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: '12k+', label: 'Active teams' },
        { value: '4.9/5', label: 'Average rating' },
        { value: '2M+', label: 'API calls / day' },
        { value: '<50ms', label: 'Response time' },
      ] },
      { id: id(), type: 'pricing', title: 'Simple, transparent pricing', plans: [
        { name: 'Starter', price: '$0', period: '/mo', features: ['1 project', 'Community support', '1 GB storage'], ctaText: 'Get started', ctaUrl: '#signup', highlighted: false },
        { name: 'Pro', price: '$29', period: '/mo', features: ['Unlimited projects', 'Priority support', '50 GB storage', 'Custom domain'], ctaText: 'Start Pro', ctaUrl: '#signup', highlighted: true },
        { name: 'Business', price: '$99', period: '/mo', features: ['Everything in Pro', 'SSO & audit logs', 'Dedicated support'], ctaText: 'Contact sales', ctaUrl: '#contact', highlighted: false },
      ] },
      { id: id(), type: 'faq', title: 'Frequently asked questions', items: [
        { question: 'Can I cancel anytime?', answer: 'Yes — upgrade, downgrade or cancel whenever you like.' },
        { question: 'Is there a free trial?', answer: 'The Starter plan is free forever. Pro includes a 14-day trial.' },
        { question: 'Do you offer refunds?', answer: 'We offer a 30-day money-back guarantee, no questions asked.' },
      ] },
      { id: id(), type: 'cta', title: 'Start building today', description: 'Join thousands of teams already shipping with us.', buttonText: 'Create your account', buttonUrl: '#signup' },
      footer(name),
    ],
  },

  // ── Portfolio — bold, dark, image-led ───────────────────────────────────
  portfolio: {
    theme: { primaryColor: '#f59e0b', accentColor: '#fbbf24', backgroundColor: '#0f0f10', surfaceColor: '#1a1a1d', textColor: '#f5f5f5', mutedColor: '#a1a1aa', fontFamily: 'serif', borderRadius: 'sm', maxWidth: 'wide' },
    blocks: (name) => [
      { id: id(), type: 'banner', imageUrl: '', headline: name, subheadline: 'Designer · Maker · Storyteller', overlayOpacity: 0.5 },
      { id: id(), type: 'features', title: 'Selected work', items: [
        { title: 'Project One', description: 'A short line about the work and the result you delivered.' },
        { title: 'Project Two', description: 'Another highlight — the problem, your approach, the impact.' },
        { title: 'Project Three', description: 'Showcase your range with a third standout piece.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: '8 yrs', label: 'Experience' },
        { value: '120+', label: 'Projects' },
        { value: '30+', label: 'Happy clients' },
      ] },
      { id: id(), type: 'text', title: 'About', body: 'Write a short bio here. What you do, who you do it for, and what makes your work different. Keep it personal and confident.' },
      { id: id(), type: 'cta', title: 'Let’s work together', description: 'Have a project in mind? I’d love to hear about it.', buttonText: 'Get in touch', buttonUrl: 'mailto:hello@example.com' },
      footer(name),
    ],
  },

  // ── Restaurant — warm, appetizing, serif ────────────────────────────────
  restaurant: {
    theme: { primaryColor: '#b45309', accentColor: '#d97706', backgroundColor: '#fffbeb', surfaceColor: '#ffffff', textColor: '#1c1917', mutedColor: '#78716c', fontFamily: 'serif', borderRadius: 'lg' },
    blocks: (name) => [
      { id: id(), type: 'banner', imageUrl: '', headline: name, subheadline: 'Fresh, seasonal cooking — made with love', overlayOpacity: 0.45 },
      { id: id(), type: 'features', title: 'Our favourites', items: [
        { title: 'Starters', description: 'House bread, seasonal soup, garden salad.' },
        { title: 'Mains', description: 'Daily catch, slow-roast, handmade pasta.' },
        { title: 'Desserts', description: 'Classic tiramisu, warm chocolate, sorbet.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: 'Tue–Sun', label: 'Open' },
        { value: '12–23', label: 'Hours' },
        { value: '★ 4.8', label: 'Guest rating' },
      ] },
      { id: id(), type: 'faq', title: 'Good to know', items: [
        { question: 'Do you take reservations?', answer: 'Yes, book a table online or call us directly.' },
        { question: 'Are there vegetarian options?', answer: 'Always — our menu changes with the season.' },
      ] },
      { id: id(), type: 'cta', title: 'Reserve your table', description: 'Join us for lunch or dinner — walk-ins welcome too.', buttonText: 'Book a table', buttonUrl: '#reserve' },
      footer(name),
    ],
  },

  // ── E-commerce — clean store front, emerald ─────────────────────────────
  ecommerce: {
    theme: { primaryColor: '#059669', accentColor: '#10b981', fontFamily: 'system', borderRadius: 'md' },
    blocks: (name) => [
      { id: id(), type: 'hero', headline: `Shop ${name}`, subheadline: 'Quality products, delivered with care. Free shipping on orders over $50.', ctaText: 'Browse catalog', ctaUrl: '#shop' },
      { id: id(), type: 'features', title: 'Why shop with us', items: [
        { title: 'Free shipping', description: 'On all orders over $50, everywhere.' },
        { title: 'Easy returns', description: '30-day hassle-free returns.' },
        { title: 'Secure checkout', description: 'Your payment is always protected.' },
      ] },
      { id: id(), type: 'pricing', title: 'Featured products', plans: [
        { name: 'Essentials', price: '$24', period: '', features: ['Best seller', 'In stock', 'Ships today'], ctaText: 'Add to cart', ctaUrl: '#shop', highlighted: false },
        { name: 'Premium', price: '$49', period: '', features: ['Editor’s pick', 'Limited edition', 'Free gift wrap'], ctaText: 'Add to cart', ctaUrl: '#shop', highlighted: true },
        { name: 'Bundle', price: '$89', period: '', features: ['Save 20%', 'Most popular', 'Ships today'], ctaText: 'Add to cart', ctaUrl: '#shop', highlighted: false },
      ] },
      { id: id(), type: 'cta', title: 'Join our newsletter', description: 'Get 10% off your first order and early access to new drops.', buttonText: 'Subscribe', buttonUrl: '#subscribe' },
      footer(name),
    ],
  },

  // ── Blog / editorial — serif, narrow, readable ──────────────────────────
  blog: {
    theme: { primaryColor: '#111827', accentColor: '#4b5563', fontFamily: 'serif', borderRadius: 'sm', maxWidth: 'narrow' },
    blocks: (name) => [
      { id: id(), type: 'hero', headline: name, subheadline: 'Stories, guides, and updates from our team.', ctaText: 'Read the latest', ctaUrl: '#posts' },
      { id: id(), type: 'text', title: 'About this site', body: 'A short intro about what you write about and who it’s for. Replace this with your own voice — the goal is to make readers want to subscribe.' },
      { id: id(), type: 'faq', title: 'FAQ', items: [
        { question: 'How often do you publish?', answer: 'New posts go out every week. Subscribe to never miss one.' },
        { question: 'Can I contribute?', answer: 'We welcome guest posts — reach out via the contact link.' },
      ] },
      { id: id(), type: 'cta', title: 'Subscribe for updates', description: 'Get new posts delivered straight to your inbox.', buttonText: 'Subscribe', buttonUrl: '#subscribe' },
      footer(name),
    ],
  },

  // ── Booking / services — calm teal, services-led ────────────────────────
  booking: {
    theme: { primaryColor: '#0d9488', accentColor: '#14b8a6', backgroundColor: '#f0fdfa', fontFamily: 'rounded', borderRadius: 'lg' },
    blocks: (name) => [
      { id: id(), type: 'hero', headline: `Book with ${name}`, subheadline: 'Simple online booking — pick a time that works for you and we’ll take care of the rest.', ctaText: 'Book now', ctaUrl: '#book' },
      { id: id(), type: 'features', title: 'Our services', items: [
        { title: 'Consultation', description: 'A friendly first session to understand your needs.' },
        { title: 'Treatment', description: 'Tailored to you by our experienced team.' },
        { title: 'Follow-up', description: 'We check in to make sure you’re happy.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: '4.9★', label: 'Client rating' },
        { value: '5,000+', label: 'Appointments' },
        { value: 'Same day', label: 'Availability' },
      ] },
      { id: id(), type: 'faq', title: 'Before you book', items: [
        { question: 'How do I reschedule?', answer: 'Use the link in your confirmation email to change your time.' },
        { question: 'What’s your cancellation policy?', answer: 'Free cancellation up to 24 hours before your appointment.' },
      ] },
      { id: id(), type: 'cta', title: 'Ready when you are', description: 'Choose a time and book your appointment in under a minute.', buttonText: 'Book appointment', buttonUrl: '#book' },
      footer(name),
    ],
  },

  // ── Agency — confident, modern, dark accents ────────────────────────────
  agency: {
    theme: { primaryColor: '#7c3aed', accentColor: '#a855f7', backgroundColor: '#0b0b0f', surfaceColor: '#16161d', textColor: '#f4f4f5', mutedColor: '#a1a1aa', fontFamily: 'rounded', borderRadius: 'lg', maxWidth: 'wide' },
    blocks: (name) => [
      { id: id(), type: 'hero', headline: `${name} — ideas that move`, subheadline: 'A creative studio crafting brands, websites and campaigns that get results.', ctaText: 'See our work', ctaUrl: '#work' },
      { id: id(), type: 'features', title: 'What we do', items: [
        { title: 'Brand & identity', description: 'Logos, systems and guidelines that stick.' },
        { title: 'Web & product', description: 'Fast, beautiful sites and apps that convert.' },
        { title: 'Growth & content', description: 'Campaigns and content that reach the right people.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: '150+', label: 'Brands launched' },
        { value: '40+', label: 'Awards' },
        { value: '98%', label: 'Client retention' },
      ] },
      { id: id(), type: 'cta', title: 'Have a project in mind?', description: 'Tell us about your idea and we’ll get back within a day.', buttonText: 'Start a project', buttonUrl: '#contact' },
      footer(name),
    ],
  },

  // ── Event / conference — energetic, schedule-led ────────────────────────
  event: {
    theme: { primaryColor: '#db2777', accentColor: '#f472b6', backgroundColor: '#1a1025', surfaceColor: '#251635', textColor: '#fdf2f8', mutedColor: '#c4b5d4', fontFamily: 'rounded', borderRadius: 'lg' },
    blocks: (name) => [
      { id: id(), type: 'banner', imageUrl: '', headline: name, subheadline: 'The event you can’t miss · Save your spot', overlayOpacity: 0.55 },
      { id: id(), type: 'features', title: 'Why attend', items: [
        { title: 'World-class speakers', description: 'Learn from leaders shaping the industry.' },
        { title: 'Hands-on sessions', description: 'Practical workshops you can apply right away.' },
        { title: 'Network', description: 'Meet peers, partners and future collaborators.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: 'Sep 20', label: 'Date' },
        { value: '1,200+', label: 'Attendees' },
        { value: '30', label: 'Speakers' },
      ] },
      { id: id(), type: 'faq', title: 'Good to know', items: [
        { question: 'Where is it held?', answer: 'Downtown convention center — full address in your ticket email.' },
        { question: 'Are tickets refundable?', answer: 'Full refunds up to 14 days before the event.' },
      ] },
      { id: id(), type: 'cta', title: 'Get your ticket', description: 'Early-bird pricing ends soon — secure your seat today.', buttonText: 'Register now', buttonUrl: '#register' },
      footer(name),
    ],
  },

  // ── Real estate — premium, calm, trustworthy ────────────────────────────
  realestate: {
    theme: { primaryColor: '#0f766e', accentColor: '#0d9488', backgroundColor: '#f8fafc', surfaceColor: '#ffffff', textColor: '#0f172a', mutedColor: '#64748b', fontFamily: 'serif', borderRadius: 'md', maxWidth: 'wide' },
    blocks: (name) => [
      { id: id(), type: 'banner', imageUrl: '', headline: name, subheadline: 'Find a place to call home', overlayOpacity: 0.4 },
      { id: id(), type: 'features', title: 'Featured listings', items: [
        { title: 'Modern apartments', description: 'Move-in ready homes in prime locations.' },
        { title: 'Family houses', description: 'Space to grow, in quiet neighbourhoods.' },
        { title: 'Investment units', description: 'Strong yields with full management.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: '500+', label: 'Properties' },
        { value: '15 yrs', label: 'In business' },
        { value: '4.9★', label: 'Client rating' },
      ] },
      { id: id(), type: 'cta', title: 'Looking to buy or sell?', description: 'Talk to one of our agents — no obligation.', buttonText: 'Book a viewing', buttonUrl: '#contact' },
      footer(name),
    ],
  },

  // ── Medical / clinic — clean, reassuring, blue-green ────────────────────
  medical: {
    theme: { primaryColor: '#0284c7', accentColor: '#0ea5e9', backgroundColor: '#f0f9ff', surfaceColor: '#ffffff', textColor: '#0c4a6e', mutedColor: '#64748b', fontFamily: 'system', borderRadius: 'lg' },
    blocks: (name) => [
      { id: id(), type: 'hero', headline: name, subheadline: 'Compassionate care from a team you can trust. Booking online in minutes.', ctaText: 'Book an appointment', ctaUrl: '#book' },
      { id: id(), type: 'features', title: 'Our services', items: [
        { title: 'General check-ups', description: 'Routine care for the whole family.' },
        { title: 'Specialist clinics', description: 'Expert care across multiple fields.' },
        { title: 'Lab & diagnostics', description: 'On-site tests with fast results.' },
      ] },
      { id: id(), type: 'stats', items: [
        { value: '20k+', label: 'Patients' },
        { value: '24/7', label: 'Support' },
        { value: '12', label: 'Specialists' },
      ] },
      { id: id(), type: 'faq', title: 'Patient information', items: [
        { question: 'Do you accept insurance?', answer: 'We work with most major providers — bring your card to your visit.' },
        { question: 'How do I book?', answer: 'Use the online booking button or call our front desk.' },
      ] },
      { id: id(), type: 'cta', title: 'Your health comes first', description: 'Book a visit today and take the first step.', buttonText: 'Book now', buttonUrl: '#book' },
      footer(name),
    ],
  },

  // ── Gym / fitness — bold, high-energy, dark ─────────────────────────────
  gym: {
    theme: { primaryColor: '#dc2626', accentColor: '#f97316', backgroundColor: '#0a0a0a', surfaceColor: '#171717', textColor: '#fafafa', mutedColor: '#a3a3a3', fontFamily: 'rounded', borderRadius: 'sm', maxWidth: 'wide' },
    blocks: (name) => [
      { id: id(), type: 'banner', imageUrl: '', headline: name, subheadline: 'Stronger every day · Train with us', overlayOpacity: 0.55 },
      { id: id(), type: 'features', title: 'Training', items: [
        { title: 'Strength', description: 'Free weights, machines and coaching.' },
        { title: 'Conditioning', description: 'HIIT, cardio and group classes.' },
        { title: 'Personal training', description: 'One-on-one plans built around your goals.' },
      ] },
      { id: id(), type: 'pricing', title: 'Membership', plans: [
        { name: 'Day pass', price: '$12', period: '', features: ['Full gym access', 'No commitment'], ctaText: 'Buy pass', ctaUrl: '#join', highlighted: false },
        { name: 'Monthly', price: '$39', period: '/mo', features: ['Unlimited access', 'All classes', 'Free assessment'], ctaText: 'Join now', ctaUrl: '#join', highlighted: true },
        { name: 'Annual', price: '$390', period: '/yr', features: ['2 months free', 'Guest passes', 'Priority booking'], ctaText: 'Go annual', ctaUrl: '#join', highlighted: false },
      ] },
      { id: id(), type: 'cta', title: 'Start your first session free', description: 'No commitment — come train and see how it feels.', buttonText: 'Claim free trial', buttonUrl: '#join' },
      footer(name),
    ],
  },
};

/** Map a Site Studio template id (e.g. "creative-portfolio") to a design key. */
export function resolveTemplateDesignKey(templateId?: string): keyof typeof SITE_TEMPLATE_DESIGNS {
  const t = (templateId ?? '').toLowerCase();
  if (t.includes('saas') || t.includes('mvp')) return 'saas';
  if (t.includes('agency') || t.includes('studio')) return 'agency';
  if (t.includes('event') || t.includes('conference') || t.includes('meetup')) return 'event';
  if (t.includes('real-estate') || t.includes('realestate') || t.includes('property')) return 'realestate';
  if (t.includes('gym') || t.includes('fitness')) return 'gym';
  if (t.includes('medical') || t.includes('clinic') || t.includes('health') || t.includes('dental')) return 'medical';
  if (t.includes('portfolio') || t.includes('creative')) return 'portfolio';
  if (t.includes('restaurant') || t.includes('menu') || t.includes('cafe')) return 'restaurant';
  if (t.includes('ecommerce') || t.includes('store') || t.includes('shop')) return 'ecommerce';
  if (t.includes('blog') || t.includes('content') || t.includes('newsletter') || t.includes('cms')) return 'blog';
  if (t.includes('booking') || t.includes('appointment') || t.includes('salon')) return 'booking';
  return 'corporate';
}

export function getTemplateDesign(templateId?: string): SiteTemplateDesign {
  return SITE_TEMPLATE_DESIGNS[resolveTemplateDesignKey(templateId)];
}

/** Display metadata for the design gallery (label + category per design key). */
const DESIGN_LABELS: Record<string, { label: string; category: string }> = {
  corporate: { label: 'Corporate', category: 'business' },
  saas: { label: 'SaaS', category: 'business' },
  portfolio: { label: 'Portfolio', category: 'creative' },
  restaurant: { label: 'Restaurant', category: 'food' },
  ecommerce: { label: 'Store', category: 'ecommerce' },
  blog: { label: 'Blog', category: 'content' },
  booking: { label: 'Booking', category: 'services' },
  agency: { label: 'Agency', category: 'creative' },
  event: { label: 'Event', category: 'events' },
  realestate: { label: 'Real Estate', category: 'business' },
  medical: { label: 'Medical', category: 'health' },
  gym: { label: 'Fitness', category: 'health' },
};

export interface DesignSummary {
  key: string;
  label: string;
  category: string;
  theme: SiteTheme;
}

/** Exact design lookup by key (for "apply this template"). */
export function getDesignByKey(key: string): SiteTemplateDesign | undefined {
  return SITE_TEMPLATE_DESIGNS[key];
}

/** All available designs with display metadata + full theme — powers the in-editor gallery. */
export function listDesigns(): DesignSummary[] {
  return Object.keys(SITE_TEMPLATE_DESIGNS).map((key) => ({
    key,
    label: DESIGN_LABELS[key]?.label ?? key,
    category: DESIGN_LABELS[key]?.category ?? 'other',
    theme: { ...DEFAULT_SITE_THEME, ...SITE_TEMPLATE_DESIGNS[key].theme },
  }));
}
