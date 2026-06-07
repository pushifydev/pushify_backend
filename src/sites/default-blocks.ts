import { randomUUID } from 'crypto';
import type { SiteBlock } from './block-types';

function id(): string {
  return randomUUID();
}

export function defaultBlocksForTemplate(templateId?: string, siteName?: string): SiteBlock[] {
  const name = siteName || 'Your Business';

  const corporate: SiteBlock[] = [
    {
      id: id(),
      type: 'hero',
      headline: `Welcome to ${name}`,
      subheadline: 'We help you grow with modern digital solutions.',
      ctaText: 'Get in touch',
      ctaUrl: '#contact',
    },
    {
      id: id(),
      type: 'features',
      title: 'Why choose us',
      items: [
        { title: 'Fast delivery', description: 'Launch quickly on your own infrastructure.' },
        { title: 'Secure hosting', description: 'Your data stays on servers you control.' },
        { title: 'Easy updates', description: 'Edit content anytime from Pushify Site Editor.' },
      ],
    },
    {
      id: id(),
      type: 'text',
      title: 'About us',
      body: 'Tell your story here. Replace this text with your company mission, values, and what makes you different.',
    },
    {
      id: id(),
      type: 'cta',
      title: 'Ready to start?',
      description: 'Contact our team today and we will get back to you within one business day.',
      buttonText: 'Contact us',
      buttonUrl: 'mailto:hello@example.com',
    },
    {
      id: id(),
      type: 'footer',
      copyright: `© ${new Date().getFullYear()} ${name}. All rights reserved.`,
      links: [
        { label: 'Privacy', url: '/privacy' },
        { label: 'Contact', url: '#contact' },
      ],
    },
  ];

  if (templateId?.includes('ecommerce') || templateId === 'ecommerce-store') {
    return [
      {
        id: id(),
        type: 'hero',
        headline: `Shop at ${name}`,
        subheadline: 'Quality products, delivered with care.',
        ctaText: 'Browse catalog',
        ctaUrl: '#shop',
      },
      ...corporate.slice(1),
    ];
  }

  if (templateId?.includes('blog') || templateId === 'content-blog') {
    return [
      {
        id: id(),
        type: 'hero',
        headline: name,
        subheadline: 'Stories, guides, and updates from our team.',
        ctaText: 'Read latest',
        ctaUrl: '#posts',
      },
      ...corporate.slice(2),
    ];
  }

  return corporate;
}
