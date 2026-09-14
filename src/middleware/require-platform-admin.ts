import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { userRepository } from '../repositories/user.repository';
import { isPlatformAdminEmail } from '../lib/platform-admin';
import { recordAdminAccess } from '../services/admin.service';
import { getClientIp } from './rate-limit';
import { t, type SupportedLocale } from '../i18n';

/**
 * Platform-operator gate for /api/v1/admin/*. Runs after authMiddleware.
 *
 * Who gets through: a person (never an API key) whose account email is in ADMIN_EMAILS and who
 * has two-factor enabled. Everyone else gets 404 — the same answer an unknown URL gives, so the
 * panel's existence is not confirmed to non-operators. The one exception is an operator without
 * 2FA, who gets a 403 that says what to fix.
 *
 * The check is repeated on every request from the database row, never cached in the token, so
 * removing an email from the list takes effect immediately. Every request that passes is
 * written to admin_audit_logs.
 */
export async function requirePlatformAdmin(c: Context, next: Next) {
  const locale: SupportedLocale = c.get('locale') || 'en';
  const userId = c.get('userId') as string | undefined;
  const notFound = () => new HTTPException(404, { message: t(locale, 'errors', 'notFound') });

  if (!userId || c.get('isApiKeyAuth')) {
    throw notFound();
  }

  const user = await userRepository.findById(userId);
  if (!user || !isPlatformAdminEmail(user.email)) {
    throw notFound();
  }

  if (!user.twoFactorEnabled) {
    throw new HTTPException(403, { message: t(locale, 'errors', 'adminTwoFactorRequired') });
  }

  c.set('platformAdmin', { id: user.id, email: user.email });
  recordAdminAccess({
    adminUserId: user.id,
    method: c.req.method,
    path: c.req.path,
    ipAddress: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  await next();
}
