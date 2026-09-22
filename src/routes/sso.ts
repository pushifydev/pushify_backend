import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ssoService } from '../services/sso.service';
import { authMiddleware } from '../middleware/auth';
import { env } from '../config/env';
import type { AppEnv } from '../types';

/**
 * Single sign-on. The two callback-flow routes are public by necessity — the person using them
 * has no session yet — and everything that configures a connection needs one.
 */
const ssoRouter = new Hono<AppEnv>();

/** Does this address sign in through a provider, and must it? Drives the login form. */
ssoRouter.get('/check', async (c) => {
  const email = c.req.query('email') || '';
  const connection = await ssoService.connectionForEmail(email);
  return c.json({
    data: { available: !!connection, enforced: !!connection?.enforced },
  });
});

/** Step one: send the browser to the provider. */
ssoRouter.get('/start', async (c) => {
  const email = c.req.query('email') || '';
  const { url } = await ssoService.start(email);
  // A browser follows the redirect; a fetch() can read the URL instead
  if ((c.req.header('accept') || '').includes('application/json')) return c.json({ data: { url } });
  return c.redirect(url, 302);
});

/** Step two: the provider sends the browser back here. */
ssoRouter.get('/callback', async (c) => {
  const dashboard = env.FRONTEND_URL.replace(/\/+$/, '');
  const failure = (message: string) => c.redirect(`${dashboard}/login?error=${encodeURIComponent(message)}`, 302);

  const providerError = c.req.query('error_description') || c.req.query('error');
  if (providerError) return failure(providerError);

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return failure('The identity provider sent an incomplete answer');

  try {
    const result = await ssoService.complete(code, state, {
      ipAddress: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
      userAgent: c.req.header('user-agent') || undefined,
    });

    // The dashboard finishes the sign-in: it stores the tokens, or asks for the second factor
    const params = result.requiresTwoFactor
      ? new URLSearchParams({ twoFactorToken: result.twoFactorToken })
      : new URLSearchParams({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    return c.redirect(`${dashboard}/login/sso?${params.toString()}`, 302);
  } catch (err) {
    return failure(err instanceof HTTPException ? err.message : 'The sign-in could not be completed');
  }
});

// ── Configuration (a session, and the organization's owner) ──
ssoRouter.use('/connection', authMiddleware);

ssoRouter.get('/connection', async (c) => {
  const connection = await ssoService.get(c.get('organizationId')!, c.get('userId')!, c.get('locale'));
  return c.json({ data: connection });
});

ssoRouter.put('/connection', async (c) => {
  const connection = await ssoService.save(
    c.get('organizationId')!,
    c.get('userId')!,
    await c.req.json(),
    c.get('locale')
  );
  return c.json({ data: connection });
});

ssoRouter.delete('/connection', async (c) => {
  const result = await ssoService.remove(c.get('organizationId')!, c.get('userId')!, c.get('locale'));
  return c.json({ data: result });
});

export { ssoRouter as ssoRoutes };
