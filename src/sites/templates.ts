import type { SiteStudioTemplate } from './types';

export const siteStudioTemplates: SiteStudioTemplate[] = [
  // ── Static sites (Pushify-native, no CMS app) ────────────────────────────
  // Published as static HTML and served directly by Nginx. Built and edited entirely
  // in the Pushify Site Editor — no WordPress/Strapi/etc. to run or maintain.
  {
    id: 'static-business',
    name: 'Business Website',
    tagline: 'A polished one-page site for any business',
    description: 'A fast, no-maintenance marketing site you edit visually in Pushify and publish as static HTML.',
    longDescription: 'Perfect for small businesses and landing pages. No database, no app to keep updated — just a clean, fast site served straight from Nginx. Edit everything in the drag-and-drop Site Editor and hit Publish.',
    category: 'corporate',
    stack: 'static',
    icon: 'Globe',
    accent: '#2563eb',
    deployment: 'static',
    featured: true,
    estimatedMinutes: 2,
    features: ['No CMS to maintain', 'Instant, static-fast loads', 'Drag-and-drop editing', 'Custom domain + SSL'],
    setupGuide: [
      { title: 'Pick your design', description: 'Your site starts from a ready-made layout — edit any text or block.' },
      { title: 'Edit visually', description: 'Use the Site Editor to drag, drop and rewrite content.' },
      { title: 'Publish', description: 'Hit Publish to push the static site live on your domain.' },
    ],
  },
  {
    id: 'static-agency',
    name: 'Agency / Studio',
    tagline: 'Showcase your work and win clients',
    description: 'A bold, modern studio site — services, work and a clear call to action — published as static HTML.',
    longDescription: 'For agencies, studios and freelancers. A confident dark design that puts your work front and centre, with zero backend to maintain.',
    category: 'portfolio',
    stack: 'static',
    icon: 'Sparkles',
    accent: '#7c3aed',
    deployment: 'static',
    featured: true,
    estimatedMinutes: 2,
    features: ['Distinctive design', 'Portfolio-ready', 'No CMS to maintain', 'Custom domain + SSL'],
    setupGuide: [
      { title: 'Pick your design', description: 'Start from the agency layout and make it yours.' },
      { title: 'Add your work', description: 'Edit the highlights, stats and services in the Site Editor.' },
      { title: 'Publish', description: 'Go live on your domain in seconds.' },
    ],
  },
  {
    id: 'static-portfolio',
    name: 'Personal Portfolio',
    tagline: 'A striking personal site',
    description: 'A dark, elegant portfolio for designers, developers and makers — static and lightning fast.',
    longDescription: 'Show your work, tell your story and share contact details. No CMS, no maintenance — just a beautiful personal site you fully control.',
    category: 'portfolio',
    stack: 'static',
    icon: 'User',
    accent: '#f59e0b',
    deployment: 'static',
    featured: false,
    estimatedMinutes: 2,
    features: ['Elegant dark theme', 'Project highlights', 'No CMS to maintain', 'Custom domain + SSL'],
    setupGuide: [
      { title: 'Pick your design', description: 'Start from the portfolio layout.' },
      { title: 'Make it yours', description: 'Edit your bio, work and links in the Site Editor.' },
      { title: 'Publish', description: 'Share your live site on your own domain.' },
    ],
  },
  {
    id: 'static-event',
    name: 'Event / Landing',
    tagline: 'Promote an event and drive sign-ups',
    description: 'An energetic event page with schedule, speakers and a strong call to action — static and fast.',
    longDescription: 'For conferences, meetups and product launches. A focused landing page designed to convert visitors into registrations, with nothing to maintain.',
    category: 'corporate',
    stack: 'static',
    icon: 'CalendarDays',
    accent: '#db2777',
    deployment: 'static',
    featured: false,
    estimatedMinutes: 2,
    features: ['Conversion-focused', 'Schedule & speakers', 'No CMS to maintain', 'Custom domain + SSL'],
    setupGuide: [
      { title: 'Pick your design', description: 'Start from the event layout.' },
      { title: 'Add details', description: 'Edit the date, speakers and CTA in the Site Editor.' },
      { title: 'Publish', description: 'Launch your event page on your domain.' },
    ],
  },

  // ── WordPress (4) ─────────────────────────────────────────────
  {
    id: 'ecommerce-store',
    name: 'E-Commerce Store',
    tagline: 'Sell online with WooCommerce on your own server',
    description:
      'Launch a full online store with product catalog, cart, checkout, and your choice of payment gateways.',
    longDescription:
      'A production-ready WooCommerce stack on WordPress. After launch, install Stripe, PayPal, or regional payment plugins from the WordPress admin — your keys stay on your server. Sell globally from day one.',
    category: 'ecommerce',
    stack: 'wordpress',
    icon: 'ShoppingBag',
    accent: '#22c55e',
    marketplaceTemplateId: 'wordpress',
    featured: true,
    estimatedMinutes: 12,
    features: [
      'Product catalog & categories',
      'Cart & checkout',
      'Order management',
      'SEO-ready storefront',
      'Admin dashboard (WP)',
      'SSL on your domain',
    ],
    paymentIntegrations: [
      { id: 'iyzico', name: 'iyzico', region: 'tr', setupNote: 'Install the official iyzico WooCommerce plugin after setup.' },
      { id: 'paytr', name: 'PayTR', region: 'tr', setupNote: 'Connect PayTR merchant credentials in WooCommerce settings.' },
      { id: 'stripe', name: 'Stripe', region: 'global', setupNote: 'Use WooCommerce Stripe plugin for cards and wallets worldwide.' },
      { id: 'param', name: 'Param', region: 'tr', setupNote: 'Available via Turkish WooCommerce payment extensions.' },
    ],
    setupGuide: [
      { title: 'Complete WordPress setup', description: 'Open your site URL, finish the 5-minute WordPress installer, and set your store name.' },
      { title: 'Install WooCommerce', description: 'Plugins → Add New → search "WooCommerce" → Install & activate the wizard.' },
      { title: 'Connect payments', description: 'WooCommerce → Settings → Payments → enable Stripe, PayPal, or your regional gateway and add API keys.' },
      { title: 'Add products & go live', description: 'Create products, configure shipping/tax, and point your custom domain in Pushify.' },
    ],
    suggestedPlugins: ['woocommerce', 'iyzico-woocommerce', 'woocommerce-paytr'],
  },
  {
    id: 'corporate-website',
    name: 'Corporate Website',
    tagline: 'Professional company site in minutes',
    description:
      'Polished business presence with pages, contact forms, and a theme-ready WordPress CMS.',
    longDescription:
      'WordPress powers agencies and enterprises worldwide. Pick a business theme after launch, add your services, team, and contact page — all editable without code.',
    category: 'corporate',
    stack: 'wordpress',
    icon: 'Building2',
    accent: '#6366f1',
    marketplaceTemplateId: 'wordpress',
    featured: true,
    estimatedMinutes: 10,
    features: [
      'Multi-page structure',
      'Contact forms (plugin)',
      'Blog / news section',
      'Media library',
      'Role-based editors',
      'Custom domain + SSL',
    ],
    setupGuide: [
      { title: 'Run WordPress installer', description: 'Visit your live URL and complete the admin account setup.' },
      { title: 'Choose a business theme', description: 'Appearance → Themes → install a free corporate theme (e.g. Astra, Kadence).' },
      { title: 'Build core pages', description: 'Create Home, About, Services, and Contact pages from the block editor.' },
      { title: 'Connect your domain', description: 'Add a custom domain in Pushify project settings and update DNS records.' },
    ],
  },
  {
    id: 'creative-portfolio',
    name: 'Creative Portfolio',
    tagline: 'Showcase work with a visual, gallery-first site',
    description:
      'Portfolio for designers, photographers, and freelancers — gallery blocks and case studies.',
    longDescription:
      'WordPress with block editor galleries and portfolio themes. Highlight projects, testimonials, and a contact CTA on your own infrastructure.',
    category: 'portfolio',
    stack: 'wordpress',
    icon: 'Palette',
    accent: '#f59e0b',
    marketplaceTemplateId: 'wordpress',
    featured: false,
    estimatedMinutes: 10,
    features: [
      'Image galleries',
      'Project case studies',
      'About & contact pages',
      'Social links',
      'Mobile responsive themes',
      'Fast CDN-ready deploy',
    ],
    setupGuide: [
      { title: 'Install portfolio theme', description: 'Pick a photography/portfolio theme from the WordPress theme directory.' },
      { title: 'Add project galleries', description: 'Use the Gallery block for each client or personal project.' },
      { title: 'Write your story', description: 'Create an About page with bio, skills, and download links.' },
      { title: 'Share your live URL', description: 'Attach your custom domain for a professional portfolio link.' },
    ],
  },
  {
    id: 'restaurant-menu',
    name: 'Restaurant & Menu',
    tagline: 'Menu, reservations, and location for local businesses',
    description:
      'Restaurant site with menu pages, opening hours, maps, and contact — easy for staff to update.',
    longDescription:
      'WordPress with a restaurant theme or menu plugin. Update daily specials without a developer; customers find hours, address, and phone on mobile.',
    category: 'restaurant',
    stack: 'wordpress',
    icon: 'UtensilsCrossed',
    accent: '#f97316',
    marketplaceTemplateId: 'wordpress',
    featured: false,
    estimatedMinutes: 10,
    features: [
      'Digital menu pages',
      'Opening hours widget',
      'Location & map embed',
      'Reservation form (plugin)',
      'Photo gallery',
      'Turkish + multilingual ready',
    ],
    setupGuide: [
      { title: 'Choose restaurant theme', description: 'Install a cafe/restaurant WordPress theme with menu layouts.' },
      { title: 'Enter menu items', description: 'Add categories (starters, mains, drinks) and prices in pages or a menu plugin.' },
      { title: 'Add location & hours', description: 'Embed Google Maps and set opening hours in the footer or widget.' },
      { title: 'Enable reservations', description: 'Optional: install a booking plugin or link to WhatsApp / phone.' },
    ],
  },

  // ── Ghost (2) ─────────────────────────────────────────────────
  {
    id: 'professional-blog',
    name: 'Professional Blog',
    tagline: 'Fast, beautiful publishing with Ghost',
    description:
      'Modern blog with built-in SEO, newsletters, and a distraction-free editor.',
    longDescription:
      'Ghost is built for writers and publishers. No plugin maze — focus on content, memberships, and email newsletters from day one.',
    category: 'blog',
    stack: 'ghost',
    icon: 'PenLine',
    accent: '#a78bfa',
    marketplaceTemplateId: 'ghost',
    featured: true,
    estimatedMinutes: 8,
    features: [
      'Modern editor',
      'Built-in SEO',
      'Newsletter ready',
      'Memberships (optional)',
      'Fast Node.js stack',
      'Automatic SSL',
    ],
    setupGuide: [
      { title: 'Create admin account', description: 'Open /ghost/ on your site URL and register the owner account.' },
      { title: 'Configure site URL', description: 'If you added a custom domain, update Settings → General → Site URL.' },
      { title: 'Publish first posts', description: 'Write posts, set featured images, and configure navigation.' },
      { title: 'Enable newsletter (optional)', description: 'Connect Mailgun or similar in Ghost settings for email digests.' },
    ],
  },
  {
    id: 'newsletter-membership',
    name: 'Newsletter & Membership',
    tagline: 'Paid subscriptions and member-only content',
    description:
      'Monetize your audience with Ghost memberships, tiers, and native newsletters.',
    longDescription:
      'Ideal for creators, journalists, and experts who want recurring revenue. Ghost handles paywalls, Stripe billing, and member emails out of the box.',
    category: 'newsletter',
    stack: 'ghost',
    icon: 'Mail',
    accent: '#ec4899',
    marketplaceTemplateId: 'ghost',
    featured: false,
    estimatedMinutes: 10,
    features: [
      'Paid memberships',
      'Free & paid tiers',
      'Native newsletters',
      'Stripe billing (Ghost)',
      'Member portal',
      'Content paywalls',
    ],
    paymentIntegrations: [
      { id: 'stripe', name: 'Stripe', region: 'global', setupNote: 'Connect Stripe in Ghost Admin → Settings → Membership for subscriptions.' },
    ],
    setupGuide: [
      { title: 'Set up Ghost admin', description: 'Register at /ghost/ and configure your publication name and branding.' },
      { title: 'Enable memberships', description: 'Settings → Membership → turn on paid plans and connect Stripe.' },
      { title: 'Create tiers & benefits', description: 'Define free and paid tiers with exclusive content tags.' },
      { title: 'Launch your newsletter', description: 'Publish welcome post and send your first member email.' },
    ],
  },

  // ── Strapi (1) ────────────────────────────────────────────────
  {
    id: 'headless-cms',
    name: 'Headless CMS (Strapi)',
    tagline: 'API-first content for custom frontends',
    description:
      'Strapi admin for content teams; connect Next.js, mobile, or any frontend via REST/GraphQL.',
    longDescription:
      'For teams that want a separated frontend. Strapi manages content; you deploy your Next.js app as a separate Pushify project later.',
    category: 'corporate',
    stack: 'strapi',
    icon: 'Layers',
    accent: '#3b82f6',
    marketplaceTemplateId: 'strapi',
    featured: false,
    estimatedMinutes: 15,
    features: [
      'REST & GraphQL API',
      'Admin panel',
      'Media library',
      'Roles & permissions',
      'Content types builder',
      'Plugin ecosystem',
    ],
    setupGuide: [
      { title: 'Create Strapi admin', description: 'Open your Strapi URL and register the first administrator.' },
      { title: 'Define content types', description: 'Content-Type Builder → create collections for pages, posts, or products.' },
      { title: 'Configure API tokens', description: 'Settings → API Tokens → create a read token for your frontend.' },
      { title: 'Deploy your frontend', description: 'Create a new Pushify project from GitHub for Next.js and point it at Strapi.' },
    ],
  },

  // ── Directus (1) ──────────────────────────────────────────────
  {
    id: 'directus-corporate',
    name: 'Corporate CMS (Directus)',
    tagline: 'Visual admin + instant API — no WordPress',
    description:
      'Modern headless CMS with a no-code admin UI. Better for teams who want structured content and a custom frontend.',
    longDescription:
      'Directus sits on PostgreSQL and exposes REST/GraphQL instantly. Marketing teams edit in a polished admin app; developers connect Next.js or mobile apps. No PHP, no plugin conflicts.',
    category: 'corporate',
    stack: 'directus',
    icon: 'Database',
    accent: '#0ea5e9',
    marketplaceTemplateId: 'directus',
    featured: true,
    estimatedMinutes: 14,
    launchFields: [
      {
        envKey: 'ADMIN_EMAIL',
        label: 'Admin email',
        description: 'Email for the first Directus administrator',
        type: 'email',
        required: true,
      },
    ],
    features: [
      'No-code admin app',
      'REST + GraphQL API',
      'File library & transforms',
      'Roles & permissions',
      'Flows & webhooks',
      'PostgreSQL included',
    ],
    setupGuide: [
      { title: 'Log in to Directus', description: 'Open your site URL and sign in with the admin email you provided at launch.' },
      { title: 'Model your content', description: 'Create collections for pages, team members, services, and blog posts.' },
      { title: 'Invite your team', description: 'Settings → Users → add editors with limited roles.' },
      { title: 'Connect a frontend', description: 'Deploy a Next.js site via Pushify Projects and fetch content from the Directus API.' },
    ],
  },

  // ── PocketBase (1) ────────────────────────────────────────────
  {
    id: 'saas-mvp',
    name: 'SaaS / App MVP',
    tagline: 'Auth, database & API in one lightweight backend',
    description:
      'Ship a landing page plus user accounts fast. PocketBase replaces Firebase for self-hosted MVPs.',
    longDescription:
      'PocketBase bundles SQLite, auth, file storage, and a REST API in a single container. Pair with a static landing page or a separate Next.js frontend deployed on Pushify.',
    category: 'saas',
    stack: 'pocketbase',
    icon: 'Zap',
    accent: '#eab308',
    marketplaceTemplateId: 'pocketbase',
    featured: true,
    estimatedMinutes: 8,
    launchFields: [
      {
        envKey: 'POCKETBASE_ADMIN_EMAIL',
        label: 'Admin email',
        description: 'Superuser email for the PocketBase admin panel',
        type: 'email',
        required: true,
      },
    ],
    features: [
      'Built-in authentication',
      'Realtime subscriptions',
      'File uploads',
      'Admin dashboard',
      'REST API',
      'Single-container deploy',
    ],
    setupGuide: [
      { title: 'Open admin panel', description: 'Visit /_/ on your server URL and confirm the superuser account.' },
      { title: 'Create collections', description: 'Define users, products, or waitlist tables in the admin UI.' },
      { title: 'Deploy your frontend', description: 'Create a Pushify project from GitHub (Next.js, Vue, etc.) and call the PocketBase API.' },
      { title: 'Configure auth rules', description: 'Set collection API rules for public vs authenticated access.' },
    ],
  },

  // ── Cal.com (2) ───────────────────────────────────────────────
  {
    id: 'appointment-booking',
    name: 'Online Appointments',
    tagline: 'Calendly-style booking on your own server',
    description:
      'Public booking page for consultants, clinics, and salons — calendar sync and reminders included.',
    longDescription:
      'Cal.com is an open-source scheduling platform. Share a booking link, connect Google/Outlook calendars, and accept meetings without monthly SaaS fees.',
    category: 'booking',
    stack: 'calcom',
    icon: 'Calendar',
    accent: '#14b8a6',
    marketplaceTemplateId: 'calcom',
    featured: true,
    estimatedMinutes: 18,
    features: [
      'Public booking pages',
      'Google / Outlook sync',
      'Video meeting links',
      'Team round-robin',
      'Email reminders',
      'Embed on any website',
    ],
    setupGuide: [
      { title: 'Create organizer account', description: 'Open your Cal.com URL and complete the first-user setup wizard.' },
      { title: 'Set availability', description: 'Configure working hours, buffers, and timezone.' },
      { title: 'Connect calendars', description: 'Settings → Calendars → link Google or Outlook to prevent double bookings.' },
      { title: 'Share booking link', description: 'Copy your event link or embed it on your WordPress / landing page.' },
    ],
  },
  {
    id: 'clinic-salon-booking',
    name: 'Clinic & Salon Booking',
    tagline: 'Multi-staff scheduling for health & beauty',
    description:
      'Let customers pick services and staff members — ideal for dentists, aesthetics, barbers, and spas.',
    longDescription:
      'Same Cal.com engine with a workflow tuned for service businesses: multiple event types, staff calendars, and intake forms for client notes.',
    category: 'booking',
    stack: 'calcom',
    icon: 'Clock',
    accent: '#06b6d4',
    marketplaceTemplateId: 'calcom',
    featured: false,
    estimatedMinutes: 20,
    features: [
      'Multiple service types',
      'Per-staff calendars',
      'Custom intake forms',
      'SMS/email reminders',
      'Buffer between appointments',
      'Turkish timezone default',
    ],
    setupGuide: [
      { title: 'Add team members', description: 'Invite each specialist as a user with their own availability.' },
      { title: 'Create service events', description: 'e.g. "Haircut 30min", "Dental checkup 45min" with correct durations.' },
      { title: 'Add intake questions', description: 'Collect phone, notes, or allergies on the booking form.' },
      { title: 'Put link on your site', description: 'Add the booking URL to Instagram bio, WhatsApp, or your restaurant site.' },
    ],
  },
];

export function getSiteTemplateById(id: string): SiteStudioTemplate | undefined {
  return siteStudioTemplates.find((t) => t.id === id);
}
