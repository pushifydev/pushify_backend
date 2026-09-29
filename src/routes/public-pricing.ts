import { Hono } from 'hono';
import { createRateLimiter } from '../middleware/rate-limit';
import { isPublicPriceRegion, publicPricingService } from '../services/public-pricing.service';
import type { AppEnv } from '../types';

/**
 * Anonymous, read-only prices for the marketing pricing page. Customer prices only; see
 * public-pricing.service.ts for what is (and is not) exposed.
 */
const publicPricingRouter = new Hono<AppEnv>();

const publicPricingRateLimiter = createRateLimiter({
  namespace: 'public-pricing',
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: 'Too many requests, please try again in a minute',
});

publicPricingRouter.get('/managed-server-prices', publicPricingRateLimiter, async (c) => {
  const region = c.req.query('region') || 'fsn1';
  if (!isPublicPriceRegion(region)) {
    return c.json({ error: { code: 'INVALID_REGION', message: 'Unknown region' } }, 400);
  }
  try {
    const data = await publicPricingService.getManagedServerPrices(region);
    // Browsers may reuse it for 5 minutes, shared caches (Cloudflare) for an hour.
    c.header('Cache-Control', 'public, max-age=300, s-maxage=3600');
    return c.json({ data });
  } catch {
    return c.json({ error: { code: 'PRICES_UNAVAILABLE', message: 'Prices are temporarily unavailable' } }, 503);
  }
});

export { publicPricingRouter as publicPricingRoutes };
