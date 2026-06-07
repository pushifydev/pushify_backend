import { randomUUID } from 'crypto';
import type { SiteBlock, SiteBlockType } from './block-types';

function id(): string {
  return randomUUID();
}

export function createDefaultBlock(type: SiteBlockType, siteName = 'Your Business'): SiteBlock {
  const year = new Date().getFullYear();

  switch (type) {
    case 'hero':
      return {
        id: id(),
        type: 'hero',
        headline: `Welcome to ${siteName}`,
        subheadline: 'Build something remarkable with a page that converts.',
        ctaText: 'Get started',
        ctaUrl: '#contact',
      };
    case 'features':
      return {
        id: id(),
        type: 'features',
        title: 'Why choose us',
        items: [
          { title: 'Fast setup', description: 'Launch in minutes on your own server.' },
          { title: 'Full control', description: 'Your content and data stay with you.' },
          { title: 'Easy updates', description: 'Edit anytime from Pushify Site Editor.' },
        ],
      };
    case 'text':
      return {
        id: id(),
        type: 'text',
        title: 'About',
        body: 'Tell your story here. Share your mission, values, and what makes you different.',
      };
    case 'cta':
      return {
        id: id(),
        type: 'cta',
        title: 'Ready to start?',
        description: 'Contact us today — we respond within one business day.',
        buttonText: 'Contact us',
        buttonUrl: 'mailto:hello@example.com',
      };
    case 'faq':
      return {
        id: id(),
        type: 'faq',
        title: 'Frequently asked questions',
        items: [
          { question: 'How do I get started?', answer: 'Sign up and follow the setup guide in your dashboard.' },
          { question: 'Can I use my own domain?', answer: 'Yes — add a custom domain in project settings with SSL.' },
        ],
      };
    case 'pricing':
      return {
        id: id(),
        type: 'pricing',
        title: 'Simple pricing',
        plans: [
          {
            name: 'Starter',
            price: '$9',
            period: '/mo',
            features: ['1 site', 'SSL included', 'Email support'],
            ctaText: 'Choose Starter',
            ctaUrl: '#',
            highlighted: false,
          },
          {
            name: 'Pro',
            price: '$29',
            period: '/mo',
            features: ['Unlimited pages', 'Priority support', 'Custom domain'],
            ctaText: 'Choose Pro',
            ctaUrl: '#',
            highlighted: true,
          },
        ],
      };
    case 'banner':
      return {
        id: id(),
        type: 'banner',
        imageUrl: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&q=80',
        headline: 'Make an impression',
        subheadline: 'A full-width banner with your message front and center.',
        overlayOpacity: 0.45,
      };
    case 'stats':
      return {
        id: id(),
        type: 'stats',
        items: [
          { value: '10k+', label: 'Happy customers' },
          { value: '99.9%', label: 'Uptime' },
          { value: '24/7', label: 'Support' },
        ],
      };
    case 'footer':
      return {
        id: id(),
        type: 'footer',
        copyright: `© ${year} ${siteName}. All rights reserved.`,
        links: [
          { label: 'Privacy', url: '/privacy' },
          { label: 'Contact', url: '#contact' },
        ],
      };
  }
}
