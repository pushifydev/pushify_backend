import crypto from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env';
import { opsSignalsService } from '../services/ops-signals.service';
import { opsGrowthService } from '../services/ops-growth.service';
import type { AppEnv } from '../types';

/**
 * Machine-to-machine, read-only operational signals for the operations agent (pushify-hq).
 *
 * Separate from /api/v1/admin on purpose: that API is for a person with 2FA and never accepts
 * a key. This one accepts exactly one bearer token (OPS_READ_TOKEN) and returns aggregate,
 * scrubbed signals — nothing that identifies a customer beyond an id. Unset token, missing
 * header or wrong token all answer 404, the same as an unknown URL.
 */
const opsRouter = new Hono<AppEnv>();

const digest = (value: string) => crypto.createHash('sha256').update(value).digest();

export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  // Equal-length digests: timingSafeEqual never throws and the comparison leaks nothing about length.
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

async function requireOpsToken(c: Context<AppEnv>, next: Next) {
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!tokenMatches(presented, env.OPS_READ_TOKEN)) {
    throw new HTTPException(404, { message: 'Not found' });
  }
  c.header('Cache-Control', 'no-store');
  await next();
}

// Registered once for every route here; ops.test.ts walks the route table to prove it.
opsRouter.use('*', requireOpsToken);

opsRouter.get('/signals', async (c) => {
  const raw = c.req.query('since');
  const since = raw ? new Date(raw) : undefined;
  return c.json({ data: await opsSignalsService.getSignals({ since: since && !Number.isNaN(since.getTime()) ? since : undefined }) });
});

opsRouter.get('/growth', async (c) => c.json({ data: await opsGrowthService.getGrowth() }));

export { opsRouter as opsRoutes };
