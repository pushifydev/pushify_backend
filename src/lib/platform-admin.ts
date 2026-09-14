import { env } from '../config/env';

/**
 * Platform-operator allowlist. Lives in the environment (ADMIN_EMAILS), not the database, so
 * nothing reachable through the app — a bug, an injection, a compromised owner account — can
 * promote anyone. Unset means there are no operators and the admin API answers 404 to all.
 */
export function parseAdminEmails(raw?: string): Set<string> {
  const source = raw ?? env.ADMIN_EMAILS ?? '';
  return new Set(
    source
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 3 && s.includes('@')),
  );
}

export function isPlatformAdminEmail(email: string | null | undefined, raw?: string): boolean {
  if (!email) return false;
  return parseAdminEmails(raw).has(email.trim().toLowerCase());
}
