import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { verifyUnsubscribeToken } from '../lib/onboarding';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const PREF_KEYS = ['deploymentAlerts', 'securityAlerts', 'weeklyDigest', 'productUpdates'] as const;
const DEFAULT_PREFS: Record<string, boolean> = {
  deploymentAlerts: true,
  securityAlerts: true,
  weeklyDigest: false,
  productUpdates: false,
};

const prefsSchema = z
  .object({
    deploymentAlerts: z.boolean().optional(),
    securityAlerts: z.boolean().optional(),
    weeklyDigest: z.boolean().optional(),
    productUpdates: z.boolean().optional(),
    /** true = receive onboarding emails (maps to !onboardingEmailsOptOut) */
    onboardingEmails: z.boolean().optional(),
  })
  .strict();

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

// ── Authenticated notification preferences ──

onboardingRoutes.get('/me/notification-prefs', authMiddleware, async (c) => {
  const userId = c.get('userId')!;
  const [user] = await db
    .select({ prefs: users.notificationPrefs, optOut: users.onboardingEmailsOptOut })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const prefs = { ...DEFAULT_PREFS, ...(user?.prefs ?? {}) };
  return c.json({ data: { ...prefs, onboardingEmails: !user?.optOut } });
});

onboardingRoutes.put('/me/notification-prefs', authMiddleware, async (c) => {
  const userId = c.get('userId')!;
  const body = prefsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'Invalid preferences' } }, 400);
  }

  const [user] = await db
    .select({ prefs: users.notificationPrefs, optOut: users.onboardingEmailsOptOut })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const merged: Record<string, boolean> = { ...DEFAULT_PREFS, ...(user?.prefs ?? {}) };
  for (const key of PREF_KEYS) {
    const value = body.data[key];
    if (typeof value === 'boolean') merged[key] = value;
  }

  const update: Record<string, unknown> = { notificationPrefs: merged, updatedAt: new Date() };
  if (typeof body.data.onboardingEmails === 'boolean') {
    update.onboardingEmailsOptOut = !body.data.onboardingEmails;
  }
  await db.update(users).set(update).where(eq(users.id, userId));

  const optOut =
    typeof body.data.onboardingEmails === 'boolean'
      ? !body.data.onboardingEmails
      : !!user?.optOut;
  return c.json({ data: { ...merged, onboardingEmails: !optOut } });
});

export { onboardingRoutes };
