import path from 'node:path';
import { env } from '../../config/env';
import { logger } from '../logger';
import { loadAbuseRules } from './rules';
import { readRepositoryForScan, scanForAbuse, scoreReasons, type ScanResult } from './scan';

/**
 * The deploy worker's two touch points. Both are silent towards the customer (nothing goes into
 * the deploy log) and can never fail a deploy: any error is logged and swallowed.
 *
 *   afterClone  scans the checked-out source (or the image reference) and queues a finding
 *               right away, so a build that fails is still reviewed
 *   afterBuild  adds the build log, updates the finding and — only with ABUSE_AUTO_SUSPEND —
 *               suspends on a strong, high score
 */

interface Ctx {
  projectId: string;
  organizationId: string;
  deploymentId: string;
}

async function enabledAndCovered(projectId: string): Promise<boolean> {
  if (!env.ABUSE_DETECTION_ENABLED) return false;
  const { projectIsCovered } = await import('../../services/abuse.service');
  return projectIsCovered(projectId);
}

export async function abuseAfterClone(
  ctx: Ctx & { workDir?: string | null; rootDirectory?: string | null; image?: string | null },
): Promise<ScanResult | null> {
  try {
    if (!(await enabledAndCovered(ctx.projectId))) return null;
    const rules = loadAbuseRules();
    // The whole repository, not just the root directory: a monorepo can build from one folder
    // and still ship scripts from another.
    const source = ctx.workDir ? await readRepositoryForScan(path.resolve(ctx.workDir), rules) : {};
    const result = scanForAbuse({ ...source, image: ctx.image ?? null }, rules);
    if (result.flagged) {
      const { abuseService } = await import('../../services/abuse.service');
      await abuseService.recordFinding({ ...ctx, source: 'deploy_scan', result });
    }
    return result;
  } catch (err) {
    logger.warn({ err, projectId: ctx.projectId }, 'Abuse scan after clone failed');
    return null;
  }
}

export async function abuseAfterBuild(ctx: Ctx & { source: ScanResult | null; buildLog: string }): Promise<void> {
  try {
    if (!(await enabledAndCovered(ctx.projectId))) return;
    const rules = loadAbuseRules();
    const fromLog = scanForAbuse({ buildLog: ctx.buildLog }, rules);
    const combined = scoreReasons([...(ctx.source?.reasons ?? []), ...fromLog.reasons], rules);
    if (!combined.flagged) return;

    const { abuseService } = await import('../../services/abuse.service');
    await abuseService.recordFinding({ ...ctx, source: 'deploy_scan', result: combined });

    if (env.ABUSE_AUTO_SUSPEND && combined.autoSuspend) {
      const { adminNotify } = await import('../../services/admin-notify.service');
      await abuseService.suspendProject({
        projectId: ctx.projectId,
        adminUserId: null,
        reason: `Automatic review found ${combined.reasons
          .filter((r) => r.strength === 'strong')
          .map((r) => r.message.toLowerCase())
          .join('; ')}.`,
        clause: 'proxy-vpn',
        endsAt: null,
      });
      adminNotify('abuse.auto_suspended', { project: ctx.projectId, score: combined.score });
    }
  } catch (err) {
    logger.warn({ err, projectId: ctx.projectId }, 'Abuse scan after build failed');
  }
}
