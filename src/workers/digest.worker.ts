import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  deployments,
  onboardingEmails,
  organizationMembers,
  organizations,
  projects,
  servers,
  users,
} from '../db/schema';
import { sendWeeklyDigestEmail } from '../lib/email';
import { logger } from '../lib/logger';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly tick; sends only on Mondays (UTC)
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let isRunning = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

/** ISO week key like `digest-2026-W29` — reuses onboarding_emails' unique(org,key) for dedupe. */
export function digestKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `digest-${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function sweepWeeklyDigest(now: Date = new Date()): Promise<{ sent: number }> {
  const stats = { sent: 0 };
  if (now.getUTCDay() !== 1) return stats; // Mondays only

  const key = digestKey(now);
  const weekAgo = new Date(now.getTime() - WEEK_MS);

  // Owners who opted in to the weekly digest
  const owners = await db
    .select({
      orgId: organizationMembers.organizationId,
      orgName: organizations.name,
      email: users.email,
      prefs: users.notificationPrefs,
      walletBalanceCents: organizations.infraWalletBalanceCents,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.role, 'owner'));

  const optedIn = owners.filter((o) => o.prefs?.weeklyDigest === true);
  if (optedIn.length === 0) return stats;
  const orgIds = optedIn.map((o) => o.orgId);

  const [deployCounts, failedCounts, projectCounts, serverCounts, sentRows] = await Promise.all([
    db
      .select({ orgId: projects.organizationId, count: sql<number>`count(*)::int` })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .where(and(inArray(projects.organizationId, orgIds), gte(deployments.createdAt, weekAgo)))
      .groupBy(projects.organizationId),
    db
      .select({ orgId: projects.organizationId, count: sql<number>`count(*)::int` })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .where(
        and(
          inArray(projects.organizationId, orgIds),
          gte(deployments.createdAt, weekAgo),
          eq(deployments.status, 'failed')
        )
      )
      .groupBy(projects.organizationId),
    db
      .select({ orgId: projects.organizationId, count: sql<number>`count(*)::int` })
      .from(projects)
      .where(inArray(projects.organizationId, orgIds))
      .groupBy(projects.organizationId),
    db
      .select({ orgId: servers.organizationId, count: sql<number>`count(*)::int` })
      .from(servers)
      .where(and(inArray(servers.organizationId, orgIds), eq(servers.status, 'running')))
      .groupBy(servers.organizationId),
    db
      .select({ orgId: onboardingEmails.organizationId })
      .from(onboardingEmails)
      .where(and(inArray(onboardingEmails.organizationId, orgIds), eq(onboardingEmails.emailKey, key))),
  ]);

  const toMap = (rows: { orgId: string; count: number }[]) =>
    new Map(rows.map((r) => [r.orgId, r.count]));
  const deploysByOrg = toMap(deployCounts);
  const failedByOrg = toMap(failedCounts);
  const projectsByOrg = toMap(projectCounts);
  const serversByOrg = toMap(serverCounts);
  const alreadySent = new Set(sentRows.map((r) => r.orgId));

  for (const owner of optedIn) {
    try {
      if (alreadySent.has(owner.orgId)) continue;
      // Nothing to report → skip quietly (no empty digests)
      const activeProjects = projectsByOrg.get(owner.orgId) ?? 0;
      if (activeProjects === 0) continue;

      const [claimed] = await db
        .insert(onboardingEmails)
        .values({ organizationId: owner.orgId, emailKey: key })
        .onConflictDoNothing()
        .returning({ id: onboardingEmails.id });
      if (!claimed) continue;

      const ok = await sendWeeklyDigestEmail(owner.email, owner.orgName, {
        deployments: deploysByOrg.get(owner.orgId) ?? 0,
        failedDeployments: failedByOrg.get(owner.orgId) ?? 0,
        activeProjects,
        runningServers: serversByOrg.get(owner.orgId) ?? 0,
        walletBalanceCents: owner.walletBalanceCents ?? 0,
      });
      if (!ok) {
        await db.delete(onboardingEmails).where(eq(onboardingEmails.id, claimed.id));
        continue;
      }
      stats.sent++;
    } catch (error) {
      logger.error({ err: error, orgId: owner.orgId }, 'Digest sweep item failed');
    }
  }

  return stats;
}

export function startDigestWorker(): void {
  if (isRunning) return;
  isRunning = true;
  logger.info('Weekly digest worker started (Mondays UTC, opt-in)');

  const tick = () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    sweepWeeklyDigest()
      .then((stats) => {
        if (stats.sent > 0) logger.info(stats, 'Weekly digest sweep sent emails');
      })
      .catch((err) => logger.error({ err }, 'Weekly digest sweep failed'))
      .finally(() => {
        sweepInProgress = false;
      });
  };

  tick();
  intervalHandle = setInterval(tick, SWEEP_INTERVAL_MS);
}

export function stopDigestWorker(): void {
  isRunning = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  logger.info('Weekly digest worker stopped');
}
