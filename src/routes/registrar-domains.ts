import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { rejectApiKeyAuth } from '../middleware/apikey-auth';
import { requireMinRole } from '../lib/org-access';
import { domainPublicSearchRateLimiter } from '../middleware/rate-limit';
import { MAX_PURCHASE_YEARS, registrarDomainService } from '../services/registrar-domain.service';
import { billingService } from '../services/billing.service';
import { stripeService } from '../services/stripe.service';
import { t } from '../i18n';
import type { AppEnv } from '../types';

/**
 * Purchased-domain rows carry what we pay the registrar (wholesale and renewal wholesale).
 * Customers only ever see the retail price, so every row leaving these routes goes through here.
 */
export function toCustomerDomain<T extends Record<string, unknown>>(
  row: T
): Omit<T, 'wholesalePriceCents' | 'renewalWholesaleCents'> {
  const { wholesalePriceCents: _w, renewalWholesaleCents: _r, ...rest } = row;
  return rest;
}

function withCustomerDomain<T>(result: T): T {
  if (result && typeof result === 'object' && 'domain' in result && (result as { domain?: unknown }).domain) {
    const r = result as T & { domain: Record<string, unknown> };
    return { ...r, domain: toCustomerDomain(r.domain) };
  }
  return result;
}

/** Domain sales (registrar reseller) — /api/v1/domains */
const registrarDomainRoutes = new Hono<AppEnv>();

// Public availability search for the marketing /domains page (strictly rate-limited)
registrarDomainRoutes.get('/public-search', domainPublicSearchRateLimiter, async (c) => {
  const locale = c.get('locale');
  if (!registrarDomainService.isConfigured()) {
    return c.json({ data: [] });
  }
  const results = await registrarDomainService.search(c.req.query('q') ?? '', locale);
  return c.json({ data: results });
});

registrarDomainRoutes.use('*', authMiddleware);
// Buying, transferring and changing domains spends the wallet or can hand the domain away:
// admin and up. Reading is for every member, except email forwards (they list people's addresses).
registrarDomainRoutes.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  const min = !isRead ? 'admin' : /\/email-forwarding$/.test(c.req.path) ? 'member' : 'viewer';
  return requireMinRole(min)(c, next);
});
// Money and the transfer code need a person at the dashboard, not a script.
registrarDomainRoutes.use('/purchase', rejectApiKeyAuth());
registrarDomainRoutes.use('/purchase/*', rejectApiKeyAuth());
registrarDomainRoutes.use('/transfer', rejectApiKeyAuth());
registrarDomainRoutes.use('/:domainName/auth-code', rejectApiKeyAuth());

// Feature discovery for the dashboard (hidden when no registrar is configured)
registrarDomainRoutes.get('/config', (c) => {
  return c.json({ data: { enabled: registrarDomainService.isConfigured() } });
});

registrarDomainRoutes.get('/search', async (c) => {
  const locale = c.get('locale');
  const query = c.req.query('q') ?? '';
  const results = await registrarDomainService.search(query, locale);
  return c.json({ data: results });
});

registrarDomainRoutes.get('/', async (c) => {
  const organizationId = c.get('organizationId')!;
  const domains = await registrarDomainService.listByOrganization(organizationId);
  return c.json({ data: domains.map(toCustomerDomain) });
});

const purchaseSchema = z.object({
  domainName: z.string().min(4).max(253),
  projectId: z.string().uuid().optional(),
  years: z.number().int().min(1).max(MAX_PURCHASE_YEARS).optional(),
});

registrarDomainRoutes.post('/purchase', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const body = purchaseSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }

  const result = await registrarDomainService.purchase({
    organizationId,
    userId,
    domainName: body.data.domainName,
    years: body.data.years,
    projectId: body.data.projectId,
    locale,
  });
  return c.json({ data: withCustomerDomain(result) }, 201);
});

// Card payment path: quote → Stripe Checkout; the webhook registers the domain on payment
registrarDomainRoutes.post('/purchase/checkout', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const body = purchaseSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }

  const years = body.data.years ?? 1;
  const quote = await registrarDomainService.quote(body.data.domainName, years, locale);
  const billingInfo = await billingService.getBillingInfo(organizationId, userId, locale);

  const url = await stripeService.createDomainPurchaseSession({
    organizationId,
    userId,
    email: billingInfo.billingEmail || '',
    domainName: quote.domainName,
    years,
    amountCents: quote.retailTotalCents,
    projectId: body.data.projectId,
    locale,
  });
  return c.json({ data: { url, amountCents: quote.retailTotalCents } });
});

// Post-redirect confirm — registers the card-paid domain without waiting for the webhook
const confirmSchema = z.object({ sessionId: z.string().min(8).max(255) });

registrarDomainRoutes.post('/purchase/confirm', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const body = confirmSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }

  try {
    const result = await stripeService.confirmDomainPurchase(organizationId, body.data.sessionId);
    return c.json({ data: withCustomerDomain(result) });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === 'CHECKOUT_SESSION_INVALID' || err.message === 'CHECKOUT_ORG_MISMATCH')
    ) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
    }
    throw err;
  }
});

// ── Transfer-in ──

registrarDomainRoutes.get('/transfer/quote', async (c) => {
  const locale = c.get('locale');
  const quote = await registrarDomainService.getTransferQuote(c.req.query('domain') ?? '', locale);
  // Never expose our wholesale cost to customers
  return c.json({ data: { domainName: quote.domainName, retailCents: quote.retailCents } });
});

const transferSchema = z.object({
  domainName: z.string().min(4).max(253),
  authCode: z.string().min(1).max(255),
});

registrarDomainRoutes.post('/transfer', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const body = transferSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }
  const result = await registrarDomainService.startTransfer({
    organizationId,
    userId,
    domainName: body.data.domainName,
    authCode: body.data.authCode,
    locale,
  });
  return c.json({ data: withCustomerDomain(result) }, 201);
});

// ── Per-domain management ──

registrarDomainRoutes.get('/:domainName/details', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const details = await registrarDomainService.getDomainDetails(
    organizationId,
    c.req.param('domainName'),
    locale
  );
  return c.json({ data: withCustomerDomain(details) });
});

registrarDomainRoutes.get('/:domainName/dns', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const records = await registrarDomainService.listDnsRecords(
    organizationId,
    c.req.param('domainName'),
    locale
  );
  return c.json({ data: records });
});

registrarDomainRoutes.post('/:domainName/dns', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const record = await registrarDomainService.createDnsRecord(
    organizationId,
    c.req.param('domainName'),
    body,
    locale
  );
  return c.json({ data: record }, 201);
});

registrarDomainRoutes.put('/:domainName/dns/:recordId', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const record = await registrarDomainService.updateDnsRecord(
    organizationId,
    c.req.param('domainName'),
    c.req.param('recordId'),
    body,
    locale
  );
  return c.json({ data: record });
});

registrarDomainRoutes.delete('/:domainName/dns/:recordId', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  await registrarDomainService.deleteDnsRecord(
    organizationId,
    c.req.param('domainName'),
    c.req.param('recordId'),
    locale
  );
  return c.json({ data: { deleted: true } });
});

const lockSchema = z.object({ locked: z.boolean() });

registrarDomainRoutes.post('/:domainName/lock', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = lockSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }
  const result = await registrarDomainService.setLock(
    organizationId,
    c.req.param('domainName'),
    body.data.locked,
    locale
  );
  return c.json({ data: result });
});

registrarDomainRoutes.post('/:domainName/nameservers', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = (await c.req.json().catch(() => ({}))) as { nameservers?: unknown };
  const result = await registrarDomainService.setNameservers(
    organizationId,
    c.req.param('domainName'),
    body.nameservers,
    locale
  );
  return c.json({ data: result });
});

registrarDomainRoutes.post('/:domainName/auth-code', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const result = await registrarDomainService.getTransferOutAuthCode(
    organizationId,
    c.req.param('domainName'),
    locale
  );
  return c.json({ data: result });
});

// ── Email forwarding ──

registrarDomainRoutes.get('/:domainName/email-forwarding', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const forwardings = await registrarDomainService.listEmailForwardings(
    organizationId,
    c.req.param('domainName'),
    locale
  );
  return c.json({ data: forwardings });
});

registrarDomainRoutes.post('/:domainName/email-forwarding', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = (await c.req.json().catch(() => ({}))) as { emailBox?: unknown; emailTo?: unknown };
  const result = await registrarDomainService.addEmailForwarding(
    organizationId,
    c.req.param('domainName'),
    body,
    locale
  );
  return c.json({ data: result }, 201);
});

registrarDomainRoutes.delete('/:domainName/email-forwarding/:emailBox', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  await registrarDomainService.deleteEmailForwarding(
    organizationId,
    c.req.param('domainName'),
    c.req.param('emailBox'),
    locale
  );
  return c.json({ data: { deleted: true } });
});

const autoRenewSchema = z.object({ enabled: z.boolean() });

registrarDomainRoutes.patch('/:domainName/auto-renew', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const domainName = c.req.param('domainName');

  const body = autoRenewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }

  const updated = await registrarDomainService.setAutoRenew(
    organizationId,
    domainName,
    body.data.enabled,
    locale
  );
  return c.json({ data: toCustomerDomain(updated) });
});

export { registrarDomainRoutes };
