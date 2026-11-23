import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env';

/**
 * Winding the hosted service down. With SERVICE_CLOSING_DATE set (YYYY-MM-DD), nothing new can be
 * started that costs money or adds an account: sign-ups, subscriptions and upgrades, wallet
 * top-ups, domain purchases and new managed servers. Everything existing keeps working until
 * that date, and connecting your own server stays open — that is how people move out.
 * Unset (the default, and every self-hosted install), nothing here does anything.
 */
export function serviceClosingDate(): string | null {
  const raw = env.SERVICE_CLOSING_DATE?.trim();
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

export type ClosedAction = 'signup' | 'subscription' | 'topup' | 'domain-purchase' | 'managed-server';

export function assertServiceOpenFor(action: ClosedAction): void {
  const date = serviceClosingDate();
  if (!date) return;
  throw new HTTPException(403, {
    message:
      `Pushify's hosted service is closing on ${date}, so this is no longer available. ` +
      'Existing projects keep running until then. See https://pushify.dev/closing for how to move.',
    cause: { code: 'SERVICE_CLOSING', action },
  });
}
