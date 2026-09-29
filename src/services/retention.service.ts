import { lt, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  activityLogs,
  authEvents,
  emailVerificationTokens,
  passwordResetTokens,
  userSessions,
} from '../db/schema';
import { logger } from '../lib/logger';

/**
 * How long records are kept (Privacy Policy §4). Container logs have their own per-plan retention
 * in the log collector; these are the tables that had none.
 */
export const RETENTION = {
  activityLogDays: 365,
  authEventDays: 90,
  buildLogDays: 90,
  /** Each project keeps the full logs of its latest deployments, however old */
  keepLogsOfLatestDeployments: 10,
  expiredCredentialGraceDays: 1,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 1000;

const before = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

export interface RetentionStats {
  activityLogs: number;
  authEvents: number;
  deploymentLogsCleared: number;
  sessions: number;
  tokens: number;
}

export const retentionService = {
  async sweep(now: Date = new Date()): Promise<RetentionStats> {
    const activity = await db
      .delete(activityLogs)
      .where(lt(activityLogs.createdAt, before(now, RETENTION.activityLogDays)))
      .returning({ id: activityLogs.id });
    const auth = await db
      .delete(authEvents)
      .where(lt(authEvents.createdAt, before(now, RETENTION.authEventDays)))
      .returning({ id: authEvents.id });

    // Build/deploy output of old deployments is emptied (the deployment row — commit, status,
    // timing — stays), in batches, except the latest few of every project.
    const cutoff = before(now, RETENTION.buildLogDays);
    let cleared = 0;
    for (;;) {
      const res = await db.execute(sql`
        UPDATE deployments SET build_logs = NULL, deploy_logs = NULL
        WHERE id IN (
          SELECT d.id FROM deployments d
          WHERE d.created_at < ${cutoff}
            AND (d.build_logs IS NOT NULL OR d.deploy_logs IS NOT NULL)
            AND d.id NOT IN (
              SELECT r.id FROM (
                SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
                FROM deployments WHERE project_id = d.project_id
              ) r WHERE r.rn <= ${RETENTION.keepLogsOfLatestDeployments}
            )
          LIMIT ${BATCH}
        )`);
      const n = res.rowCount ?? 0;
      cleared += n;
      if (n < BATCH) break;
    }

    const credentialCutoff = before(now, RETENTION.expiredCredentialGraceDays);
    const sessions = await db
      .delete(userSessions)
      .where(lt(userSessions.expiresAt, credentialCutoff))
      .returning({ id: userSessions.id });
    const resets = await db
      .delete(passwordResetTokens)
      .where(lt(passwordResetTokens.expiresAt, credentialCutoff))
      .returning({ id: passwordResetTokens.id });
    const verifications = await db
      .delete(emailVerificationTokens)
      .where(lt(emailVerificationTokens.expiresAt, credentialCutoff))
      .returning({ id: emailVerificationTokens.id });

    const stats = {
      activityLogs: activity.length,
      authEvents: auth.length,
      deploymentLogsCleared: cleared,
      sessions: sessions.length,
      tokens: resets.length + verifications.length,
    };
    logger.info(stats, 'Retention sweep');
    return stats;
  },
};

