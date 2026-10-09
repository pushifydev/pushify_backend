import { Hono } from 'hono';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rate-limit';
import { abuseDetectionEnabled, abuseService } from '../services/abuse.service';
import type { AppEnv } from '../types';

/**
 * Anonymous abuse reports from the /abuse page. They land in the same review queue as automatic
 * findings. Only on the hosted service (ABUSE_DETECTION_ENABLED); self-hosted installs get 404.
 */
const abuseReportRouter = new Hono<AppEnv>();

const reportRateLimiter = createRateLimiter({
  namespace: 'abuse-report',
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many reports from this address, please try again later or email abuse@pushify.dev',
});

export const ABUSE_REPORT_CATEGORIES = ['proxy-vpn', 'phishing', 'malware', 'spam', 'scanning', 'copyright', 'illegal', 'other'] as const;

const reportSchema = z.object({
  url: z.string().trim().url().max(500),
  email: z.string().trim().email().max(255),
  category: z.enum(ABUSE_REPORT_CATEGORIES),
  details: z.string().trim().min(10).max(5000),
  // Honeypot: a field people never see. Bots fill it in.
  website: z.string().max(0).optional(),
});

abuseReportRouter.post('/reports', reportRateLimiter, async (c) => {
  if (!abuseDetectionEnabled()) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  const parsed = reportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: 'INVALID_REPORT', message: 'Check the URL, your email and the description (at least 10 characters).' } }, 400);
  }
  const { website: _honeypot, ...report } = parsed.data;
  const { id } = await abuseService.submitReport(report);
  return c.json({ data: { id } }, 201);
});

export { abuseReportRouter as abuseReportRoutes };
