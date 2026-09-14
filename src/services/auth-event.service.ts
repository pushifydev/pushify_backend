import { db } from '../db';
import { authEvents, type AuthEventType, type AuthMethod } from '../db/schema/auth-events';
import { logger } from '../lib/logger';
import { normalizeClientIp } from '../lib/utils';

export interface AuthEventInput {
  userId: string;
  event: AuthEventType;
  method: AuthMethod;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Append one row to the sign-in history. Fire-and-forget by design: callers do not await it,
 * and a failed write is logged rather than thrown so it can never block or fail a login.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  try {
    await db.insert(authEvents).values({
      userId: input.userId,
      event: input.event,
      method: input.method,
      ipAddress: normalizeClientIp(input.ipAddress),
      userAgent: input.userAgent?.slice(0, 500),
    });
  } catch (error) {
    logger.error({ error, event: input.event, userId: input.userId }, 'Failed to record auth event');
  }
}
