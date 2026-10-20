import { HTTPException } from 'hono/http-exception';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema/users';
import { bannedIdentifiers } from '../db/schema/abuse';

/**
 * Account bans. The checks live where every path has to pass: `createSession` (all sign-ins and
 * refreshes), the auth middleware (access tokens still in flight), API key validation, the web
 * shells — and, for sign-ups, `assertSignupAllowed` before any user row is created.
 */

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The form an email is banned and looked up in: lower case, `+tag` dropped, and for Gmail the dots
 * dropped too (Gmail ignores them) — so `a.b+x@gmail.com` and `ab@googlemail.com` are one account.
 */
export function normalizeEmailForBan(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  local = local.split('+')[0];
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

export interface SignupIdentity {
  email?: string | null;
  githubId?: string | null;
  googleId?: string | null;
}

export function identifiersFor(identity: SignupIdentity): { kind: 'email' | 'github_id' | 'google_id'; value: string }[] {
  const out: { kind: 'email' | 'github_id' | 'google_id'; value: string }[] = [];
  if (identity.email) out.push({ kind: 'email', value: normalizeEmailForBan(identity.email) });
  if (identity.githubId) out.push({ kind: 'github_id', value: String(identity.githubId) });
  if (identity.googleId) out.push({ kind: 'google_id', value: String(identity.googleId) });
  return out;
}

/** Refuse to create an account from an email or OAuth account that belonged to a banned user. */
export async function assertSignupAllowed(identity: SignupIdentity): Promise<void> {
  const ids = identifiersFor(identity);
  if (ids.length === 0) return;
  const [hit] = await db
    .select({ id: bannedIdentifiers.id })
    .from(bannedIdentifiers)
    .where(or(...ids.map((i) => and(eq(bannedIdentifiers.kind, i.kind), eq(bannedIdentifiers.value, i.value)))))
    .limit(1);
  if (hit) {
    throw new HTTPException(403, {
      message: 'This account cannot be created. If you think this is a mistake, contact support@pushify.dev.',
      cause: { code: 'SIGNUP_NOT_ALLOWED' },
    });
  }
}

// A short cache: the auth middleware runs on every request. A ban also deletes every session and
// API key at once, so the cache only bounds how long an already-issued access token keeps working.
const CACHE_MS = 30_000;
const cache = new Map<string, { banned: boolean; at: number }>();

export async function isUserBanned(userId: string): Promise<boolean> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.banned;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNotNull(users.bannedAt)))
    .limit(1);
  const banned = !!row;
  cache.set(userId, { banned, at: Date.now() });
  if (cache.size > 10_000) cache.clear();
  return banned;
}

export function forgetBanCache(userId: string): void {
  cache.delete(userId);
}

export function accountSuspendedError(): HTTPException {
  return new HTTPException(403, {
    message: 'This account is suspended under the Pushify Acceptable Use Policy.',
    cause: { code: 'ACCOUNT_SUSPENDED' },
  });
}

export async function assertUserNotBanned(userId: string): Promise<void> {
  if (await isUserBanned(userId)) throw accountSuspendedError();
}
