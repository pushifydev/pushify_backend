import { HTTPException } from 'hono/http-exception';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { projects } from '../db/schema/projects';
import { deployments } from '../db/schema/deployments';
import { projectVolumes } from '../db/schema/project-volumes';
import { requireProjectMember } from '../lib/org-access';
import { evaluateTransferPreflight, type TransferPreflight } from '../lib/project-transfer';
import { decrypt } from '../lib/encryption';
import { logger } from '../lib/logger';
import { wsManager } from '../lib/ws';
import { getSSHConnection } from '../utils/ssh';
import type { AuditSource } from '../lib/audit';
import { t, type SupportedLocale } from '../i18n';
import { projectRepository } from '../repositories/project.repository';
import { deploymentRepository } from '../repositories/deployment.repository';
import { databaseRepository } from '../repositories/database.repository';
import { domainRepository } from '../repositories/domain.repository';
import { activityService } from './activity.service';
import { dnsProviderService } from './dns-provider.service';
import { planLimitsService } from './plan-limits.service';
import { assertOrganizationCanMutateResources } from './organization-billing.service';
import { isPublishedStaticSite } from './preview.service';
import type { ProjectTransferEvent } from '../types/ws';

/**
 * Moving a project to another server of its organization — see lib/project-transfer.ts for what
 * is checked and why. The deploy worker calls `complete` / `fail` when the move's deploy ends.
 */

type ProjectRow = typeof projects.$inferSelect;
type Transfer = { fromServerId: string; toServerId: string };

interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
  source?: AuditSource;
}

const IN_PROGRESS = ['pending', 'building', 'deploying'] as const;

/** The newest production deploy that succeeded and is serving now: the one the move builds again */
async function findLiveDeployment(projectId: string) {
  const [row] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.projectId, projectId),
        eq(deployments.environment, 'production'),
        eq(deployments.isPreview, false),
        eq(deployments.status, 'running')
      )
    )
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  return row ?? null;
}

/** The billing / plan assertion a deploy would trip over, as a message (null when none does) */
async function quotaProblem(organizationId: string, locale: SupportedLocale): Promise<string | null> {
  try {
    await assertOrganizationCanMutateResources(organizationId, locale);
    await planLimitsService.assertDeploymentsQuota(organizationId, locale);
    await planLimitsService.assertBuildMinutesQuota(organizationId, locale);
    await planLimitsService.assertStorageQuota(organizationId, locale);
    await planLimitsService.assertBandwidthQuota(organizationId, locale);
    return null;
  } catch (err) {
    if (err instanceof HTTPException) return err.message;
    throw err;
  }
}

function publish(event: ProjectTransferEvent): void {
  wsManager.publish(`project:${event.projectId}`, { type: 'project:transfer', data: event }).catch(() => {});
}

/**
 * Stop — not remove — the project's containers on the server it moved away from, so going back
 * is a `docker start` away. Only the given server is touched: the generic resolver falls back to
 * scanning the organization's servers and could find the new copy on the target instead.
 */
async function stopOnSourceServer(serverId: string, project: ProjectRow): Promise<boolean> {
  const server = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!server?.ipv4 || !server.sshPrivateKey) return false;
  const [{ pauseProjectContainersOnServer }, { projectContainerNames }] = await Promise.all([
    import('../lib/project-remote-cleanup'),
    import('../lib/project-containers'),
  ]);
  const { workers } = await projectContainerNames(project.id, project.slug);
  const ssh = await getSSHConnection({
    host: server.ipv4,
    port: 22,
    username: 'root',
    privateKey: decrypt(server.sshPrivateKey),
  });
  try {
    return await pauseProjectContainersOnServer(ssh, project.slug, workers);
  } finally {
    ssh.disconnect();
  }
}

export const projectTransferService = {
  /** Run every check against the project as it is now; nothing is changed. */
  async evaluate(project: ProjectRow, targetServerId: string, locale: SupportedLocale = 'en'): Promise<TransferPreflight> {
    const settings = (project.settings || {}) as Record<string, unknown>;
    const [target, live, running, volumes, connections, domains, cloudflareConnected, quota] = await Promise.all([
      db.query.servers.findFirst({ where: eq(servers.id, targetServerId) }),
      findLiveDeployment(project.id),
      db
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.projectId, project.id), inArray(deployments.status, [...IN_PROGRESS])))
        .limit(1),
      db.select({ name: projectVolumes.name }).from(projectVolumes).where(eq(projectVolumes.projectId, project.id)),
      databaseRepository.findConnectionsByProject(project.id),
      domainRepository.findByProject(project.id),
      dnsProviderService.isCloudflareConnected(project.organizationId),
      quotaProblem(project.organizationId, locale),
    ]);

    return evaluateTransferPreflight({
      project: {
        organizationId: project.organizationId,
        status: project.status,
        suspended: !!project.suspendedAt,
        serverId: project.serverId,
        staticSite: isPublishedStaticSite(settings),
        composeStack:
          !!project.composePath || settings.deploymentType === 'docker-compose' || !!settings.marketplaceTemplateId,
      },
      targetServerId,
      target: target
        ? {
            id: target.id,
            organizationId: target.organizationId,
            name: target.name,
            status: target.status,
            setupStatus: target.setupStatus,
            ipv4: target.ipv4,
            ipv6: target.ipv6,
            hasSshKey: !!target.sshPrivateKey,
          }
        : null,
      hasSuccessfulDeployment: !!live,
      deploymentInProgress: running.length > 0,
      volumes: volumes.map((v) => v.name),
      // Reached by container name over the server's `pushify` network (lib/managed-database.ts)
      sourceDatabases: connections
        .filter((c) => !!project.serverId && c.database.serverId === project.serverId && !!c.database.containerName)
        .map((c) => c.database.name),
      quotaProblem: quota,
      customDomains: domains.filter((d) => !d.isAutoGenerated).map((d) => d.domain),
      cloudflareConnected,
    });
  },

  /** dryRun: the checks for moving the project to `targetServerId` */
  async preflight(
    projectId: string,
    organizationId: string,
    userId: string,
    targetServerId: string,
    locale: SupportedLocale = 'en'
  ): Promise<TransferPreflight> {
    const { project } = await requireProjectMember(projectId, organizationId, userId, 'member', locale);
    if (project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }
    return this.evaluate(project, targetServerId, locale);
  },

  /**
   * Start the move: queue a deploy of the live commit on the target server. The project keeps its
   * current server until that deploy succeeds (see `complete`). Refused with 409 and the reasons
   * when a check blocks it.
   */
  async start(
    projectId: string,
    organizationId: string,
    userId: string,
    targetServerId: string,
    locale: SupportedLocale = 'en',
    context: RequestContext = {}
  ): Promise<{ deploymentId: string; preflight: TransferPreflight }> {
    const { project } = await requireProjectMember(projectId, organizationId, userId, 'member', locale);
    if (project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    const preflight = await this.evaluate(project, targetServerId, locale);
    if (!preflight.ok || !project.serverId) {
      throw new HTTPException(409, { message: `This project cannot be moved: ${preflight.blockers.join(' ')}` });
    }

    const live = await findLiveDeployment(projectId);
    const transfer: Transfer = { fromServerId: project.serverId, toServerId: targetServerId };
    const deployment = await deploymentRepository.create({
      projectId,
      trigger: 'redeploy',
      commitHash: live?.commitHash ?? undefined,
      commitMessage: live?.commitMessage ?? undefined,
      branch: live?.branch ?? project.gitBranch ?? undefined,
      triggeredById: userId,
      environment: 'production',
      buildMetadata: { transfer },
    });

    const { scheduleDeploymentProcessing } = await import('../lib/deployment-scheduler');
    await scheduleDeploymentProcessing(deployment.id, projectId);

    await activityService.log({
      organizationId,
      userId,
      projectId,
      action: 'project.transfer_started',
      description: `Started moving project "${project.name}" to another server`,
      metadata: { deploymentId: deployment.id, ...transfer },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      source: context.source,
    });
    publish({ projectId, deploymentId: deployment.id, ...transfer, status: 'started' });
    logger.info({ projectId, deploymentId: deployment.id, ...transfer }, 'Project transfer started');

    return { deploymentId: deployment.id, preflight };
  },

  /**
   * The move's deploy passed its health check on the target and nginx/SSL are set up there: point
   * the project at the target, stop (keep) the source's containers, re-point the Cloudflare
   * records Pushify created. Never throws — the app already runs on the target.
   */
  async complete(deploymentId: string, projectId: string, transfer: Transfer, onLog: (message: string) => void = () => {}): Promise<boolean> {
    try {
      const existing = await projectRepository.findById(projectId);
      if (!existing) return false;
      // Someone chose another server for the project while the move was running: theirs wins.
      if (existing.serverId !== transfer.fromServerId) {
        await this.fail(
          deploymentId,
          projectId,
          transfer,
          'The project was assigned to another server while it was being moved; it was left as it is.'
        );
        return false;
      }

      const project = await projectRepository.update(projectId, { serverId: transfer.toServerId });
      onLog('🚚 Project moved: it now runs on the new server');

      let sourceStopped = false;
      try {
        sourceStopped = await stopOnSourceServer(transfer.fromServerId, existing);
      } catch (err) {
        logger.warn({ projectId, serverId: transfer.fromServerId, err }, 'Stopping the project on its previous server failed');
      }
      onLog(
        sourceStopped
          ? '⏸️ Containers on the previous server stopped (kept, not removed)'
          : '⚠️ Containers on the previous server could not be stopped — stop them by hand'
      );

      const { domainService } = await import('./domain.service');
      const dns = await domainService.syncProjectDnsRecords(project);

      await activityService.log({
        organizationId: existing.organizationId,
        projectId,
        action: 'project.transferred',
        description: `Moved project "${existing.name}" to another server`,
        metadata: {
          deploymentId,
          ...transfer,
          sourceStopped,
          dns: dns.map((d) => ({ domain: d.domain, status: d.status })),
        },
        changes: { serverId: { from: transfer.fromServerId, to: transfer.toServerId } },
      });
      publish({ projectId, deploymentId, ...transfer, status: 'completed' });
      logger.info({ projectId, deploymentId, ...transfer, sourceStopped }, 'Project transfer completed');
      return true;
    } catch (err) {
      logger.error({ projectId, deploymentId, ...transfer, err }, 'Finishing the project transfer failed');
      return false;
    }
  },

  /** The move's deploy failed: nothing changes, the project keeps running on its server. */
  async fail(deploymentId: string, projectId: string, transfer: Transfer, error: string): Promise<void> {
    try {
      const project = await projectRepository.findById(projectId);
      if (project) {
        await activityService.log({
          organizationId: project.organizationId,
          projectId,
          action: 'project.transfer_failed',
          description: `Moving project "${project.name}" to another server failed; it keeps running on its current server`,
          metadata: { deploymentId, ...transfer, error: error.slice(0, 500) },
        });
      }
      publish({ projectId, deploymentId, ...transfer, status: 'failed', message: error.slice(0, 500) });
      logger.warn({ projectId, deploymentId, ...transfer }, 'Project transfer failed; project stays on its server');
    } catch (err) {
      logger.error({ projectId, deploymentId, err }, 'Recording the failed project transfer failed');
    }
  },
};
