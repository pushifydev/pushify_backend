import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { verifyUnsubscribeToken } from '../lib/onboarding';
import type { AppEnv } from '../types';

/** Public unsubscribe for lifecycle emails — linked from every onboarding email. */
const onboardingRoutes = new Hono<AppEnv>();

onboardingRoutes.get('/unsubscribe-onboarding', async (c) => {
  const token = c.req.query('token') ?? '';
  const userId = await verifyUnsubscribeToken(token);
  if (!userId) {
    return c.html('<p style="font-family:sans-serif;padding:40px;">Invalid or expired link.</p>', 400);
  }
  await db
    .update(users)
    .set({ onboardingEmailsOptOut: true, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return c.html(
    '<div style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;">' +
      '<h2>You are unsubscribed</h2>' +
      '<p style="color:#555;">You will not receive onboarding emails anymore. Transactional emails (billing, security) are unaffected.</p>' +
      '<a href="https://pushify.dev" style="color:#6366f1;">Back to Pushify</a></div>'
  );
});

export { onboardingRoutes };
