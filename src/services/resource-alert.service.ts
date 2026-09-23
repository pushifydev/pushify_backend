import { desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db';
import { containerMetrics, projectResourceState } from '../db/schema/metrics';
import { projects } from '../db/schema/projects';
import { organizationRepository } from '../repositories/organization.repository';
import { deploymentAlertRepository } from '../repositories/deployment-alert.repository';
import { sendResourcePressureEmail, sendResourceRecoveredEmail } from '../lib/email';
import { adminNotify } from './admin-notify.service';
import {
  DEFAULT_THRESHOLDS,
  formatDurationShort,
  nextResourceState,
  worstSample,
  type ResourceKind,
  type ResourceState,
} from '../lib/resource-alerts';
import { logger } from '../lib/logger';

/**
 * Reading the metrics we were already collecting.
 *
 * `container_metrics` has had CPU and memory for every container every fifteen seconds all
 * along, and nothing looked at it. An app sitting at its memory limit is minutes from being
 * OOM-killed into a restart loop; the first anyone heard was the health check reporting it had
 * stopped answering, which is after the outage rather than before it.
 *
 * The judgement about what counts as a problem lives in `lib/resource-alerts.ts` — this is the
 * part that reads the samples, keeps the state and sends the mail.
 */

const RESOURCES: ResourceKind[] = ['memory', 'cpu'];

/** Only readings this recent are considered — an old row is a container that has since stopped. */
const SAMPLE_WINDOW_MS = 90 * 1000;

function toState(row: typeof projectResourceState.$inferSelect | undefined): ResourceState {
  return { since: row?.since ?? null, notifiedAt: row?.notifiedAt ?? null };
}

export const resourceAlertService = {
  /**
   * One pass over the latest readings. Called from the metrics worker each poll, so it has to be
   * cheap: one query for the recent samples, one state row per project that has any.
   */
  async check(now: Date = new Date()): Promise<{ checked: number; alerted: number }> {
    const since = new Date(now.getTime() - SAMPLE_WINDOW_MS);

    const recent = await db
      .select({
        projectId: containerMetrics.projectId,
        containerName: containerMetrics.containerName,
        cpuPercent: containerMetrics.cpuPercent,
        memoryPercent: containerMetrics.memoryPercent,
        memoryLimitBytes: containerMetrics.memoryLimitBytes,
        recordedAt: containerMetrics.recordedAt,
      })
      .from(containerMetrics)
      .where(gte(containerMetrics.recordedAt, since))
      .orderBy(desc(containerMetrics.recordedAt));

    if (recent.length === 0) return { checked: 0, alerted: 0 };

    // The newest reading per container; the query above can hold several polls' worth
    const latest = new Map<string, (typeof recent)[number]>();
    for (const row of recent) {
      const key = `${row.projectId}:${row.containerName}`;
      if (!latest.has(key)) latest.set(key, row);
    }

    const byProject = new Map<string, (typeof recent)[number][]>();
    for (const row of latest.values()) {
      const list = byProject.get(row.projectId) ?? [];
      list.push(row);
      byProject.set(row.projectId, list);
    }

    const projectIds = [...byProject.keys()];
    const states = await db
      .select()
      .from(projectResourceState)
      .where(inArray(projectResourceState.projectId, projectIds));
    const stateOf = new Map(states.map((row) => [`${row.projectId}:${row.resource}`, row]));

    let alerted = 0;
    for (const [projectId, rows] of byProject) {
      for (const resource of RESOURCES) {
        const samples = rows
          .map((row) => ({
            percent: resource === 'memory' ? row.memoryPercent : row.cpuPercent,
            containerName: row.containerName,
            memoryLimitBytes: row.memoryLimitBytes,
          }))
          // Without a memory limit the percentage is of the whole host, which says nothing about
          // this container being in trouble
          .filter((sample) => resource !== 'memory' || sample.memoryLimitBytes > 0);

        const worst = worstSample(samples);
        if (!worst) continue;

        const previous = toState(stateOf.get(`${projectId}:${resource}`));
        const transition = nextResourceState(previous, worst, DEFAULT_THRESHOLDS[resource], now);

        const values = {
          projectId,
          resource,
          since: transition.state.since,
          notifiedAt: transition.state.notifiedAt,
          lastPercent: worst.percent,
          lastContainer: worst.containerName,
          updatedAt: now,
        };
        await db
          .insert(projectResourceState)
          .values(values)
          .onConflictDoUpdate({
            target: [projectResourceState.projectId, projectResourceState.resource],
            set: values,
          })
          .catch((err) => logger.error({ err, projectId, resource }, 'Could not store resource state'));

        if (transition.notify) {
          alerted++;
          await this.announce(projectId, resource, transition.notify, {
            percent: worst.percent,
            containerName: worst.containerName,
            forMs: transition.underPressureForMs ?? 0,
          }).catch((err) => logger.error({ err, projectId, resource }, 'Resource alert failed to send'));
        }
      }
    }

    return { checked: byProject.size, alerted };
  },

  /** Mail whoever keeps deployment alerts on, the same people the down-alerts go to. */
  async announce(
    projectId: string,
    resource: ResourceKind,
    kind: 'pressure' | 'recovered',
    details: { percent: number; containerName: string; forMs: number }
  ): Promise<void> {
    const [project] = await db
      .select({ id: projects.id, name: projects.name, organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) return;

    const [recipients, org] = await Promise.all([
      deploymentAlertRepository.findAlertRecipients(project.organizationId),
      organizationRepository.findById(project.organizationId),
    ]);

    for (const recipient of recipients) {
      if (kind === 'pressure') {
        await sendResourcePressureEmail(recipient.email, {
          orgName: org?.name ?? '',
          projectName: project.name,
          projectId: project.id,
          resource,
          percent: details.percent,
          containerName: details.containerName,
        }).catch(() => {});
      } else {
        await sendResourceRecoveredEmail(recipient.email, {
          orgName: org?.name ?? '',
          projectName: project.name,
          projectId: project.id,
          resource,
          lastedFor: formatDurationShort(details.forMs),
        }).catch(() => {});
      }
    }

    if (kind === 'pressure') {
      adminNotify('resource.pressure', {
        project: project.name,
        projectId: project.id,
        resource,
        percent: Math.round(details.percent),
        container: details.containerName,
      });
    }

    logger.info({ projectId, resource, kind, percent: details.percent }, 'Resource alert sent');
  },

  /** Forget a project's state — used when it is paused or deleted, so it does not "recover" later. */
  async reset(projectId: string): Promise<void> {
    await db.delete(projectResourceState).where(eq(projectResourceState.projectId, projectId)).catch(() => {});
  },
};
