import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';

/**
 * An organization waiting to be deleted is read-only: every signed-in request that changes
 * something is refused, except the few that let people restore it, leave it, or take their
 * things with them. Checked on each mutating request, so the answer is cached briefly per process.
 */

const TTL_MS = 30_000;
const cache = new Map<string, { pending: boolean; at: number }>();

export async function isOrganizationPendingDeletion(organizationId: string): Promise<boolean> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pending;
  const [row] = await db
    .select({ scheduledFor: organizations.deletionScheduledFor })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const pending = !!row?.scheduledFor;
  cache.set(organizationId, { pending, at: Date.now() });
  return pending;
}

/** Call after scheduling or restoring; other processes catch up within the TTL. */
export function invalidateDeletionLock(organizationId: string): void {
  cache.delete(organizationId);
}

const ALLOWED_WHILE_PENDING: RegExp[] = [
  /^\/api\/v1\/organizations\/deletion$/, // restore
  /^\/api\/v1\/organizations\/switch$/, // members move to another organization
  /^\/api\/v1\/auth\/logout$/,
  /^\/api\/v1\/auth\/me\/deletion$/, // a member deleting their own account
  /^\/api\/v1\/domains\/[^/]+\/auth-code$/, // transfer a domain out before the purge
];

export function isAllowedWhilePendingDeletion(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  return ALLOWED_WHILE_PENDING.some((re) => re.test(path));
}
