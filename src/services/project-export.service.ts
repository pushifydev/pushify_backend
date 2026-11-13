import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { scheduledTasks } from '../db/schema/scheduled-tasks';
import { projectWorkers } from '../db/schema/project-workers';
import { projectVolumes } from '../db/schema/project-volumes';
import { envVarRepository } from '../repositories/envvar.repository';
import { domainRepository } from '../repositories/domain.repository';
import { databaseRepository } from '../repositories/database.repository';
import { decrypt } from '../lib/encryption';
import { requireProjectMember } from '../lib/org-access';
import { getApiBaseUrl } from '../lib/api-base-url';
import { logger } from '../lib/logger';
import {
  buildProjectExport,
  resolveImportedEnvVars,
  PROJECT_EXPORT_MIN_PASSPHRASE,
  type ProjectExportBundle,
} from '../lib/project-export';
import { t, type SupportedLocale } from '../i18n';
import { projectService } from './project.service';
import { envVarService } from './envvar.service';
import { domainService } from './domain.service';
import { projectVolumeService } from './project-volume.service';
import { projectWorkerService } from './project-worker.service';
import { scheduledTaskService } from './scheduled-task.service';

export interface ImportSkipped {
  kind: 'envVar' | 'domain' | 'scheduledTask' | 'worker' | 'volume' | 'settings';
  name: string;
  reason: string;
}

function reasonOf(err: unknown): string {
  if (err instanceof HTTPException) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function assertPassphrase(passphrase: string | undefined): void {
  if (passphrase !== undefined && passphrase.length < PROJECT_EXPORT_MIN_PASSPHRASE) {
    throw new HTTPException(400, {
      message: `The passphrase must be at least ${PROJECT_EXPORT_MIN_PASSPHRASE} characters`,
    });
  }
}

export const projectExportService = {
  /**
   * The project's settings as a portable bundle. Members export; a value they may not read
   * (a locked variable) is left out. Encrypting secrets into the bundle is owner/admin only.
   */
  async export(
    projectId: string,
    organizationId: string,
    userId: string,
    options: { passphrase?: string },
    locale: SupportedLocale = 'en'
  ): Promise<ProjectExportBundle> {
    const { membership, project } = await requireProjectMember(projectId, organizationId, userId, 'member', locale);
    if (project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }
    const canManageLocked = membership.role === 'owner' || membership.role === 'admin';
    if (options.passphrase !== undefined && !canManageLocked) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }
    assertPassphrase(options.passphrase);

    const [envVars, domains, tasks, workers, volumes, connections] = await Promise.all([
      envVarRepository.findByProject(projectId),
      domainRepository.findByProject(projectId),
      db.select().from(scheduledTasks).where(eq(scheduledTasks.projectId, projectId)).orderBy(scheduledTasks.createdAt),
      db.select().from(projectWorkers).where(eq(projectWorkers.projectId, projectId)).orderBy(projectWorkers.createdAt),
      db.select().from(projectVolumes).where(eq(projectVolumes.projectId, projectId)).orderBy(projectVolumes.createdAt),
      databaseRepository.findConnectionsByProject(projectId),
    ]);

    return buildProjectExport({
      project: {
        name: project.name,
        description: project.description,
        gitRepoUrl: project.gitRepoUrl,
        gitBranch: project.gitBranch,
        stagingBranch: project.stagingBranch,
        gitProvider: project.gitProvider,
        installCommand: project.installCommand,
        buildCommand: project.buildCommand,
        startCommand: project.startCommand,
        outputDirectory: project.outputDirectory,
        rootDirectory: project.rootDirectory,
        dockerfilePath: project.dockerfilePath,
        dockerImage: project.dockerImage,
        composePath: project.composePath,
        composeService: project.composeService,
        composePort: project.composePort,
        composePullPolicy: project.composePullPolicy,
        port: project.port,
        autoDeploy: project.autoDeploy,
        replicas: project.replicas,
        autoscaleEnabled: project.autoscaleEnabled,
        autoscaleMin: project.autoscaleMin,
        autoscaleMax: project.autoscaleMax,
        autoscaleObserveOnly: project.autoscaleObserveOnly,
        sleepEnabled: project.sleepEnabled,
        sleepAfterMinutes: project.sleepAfterMinutes,
      },
      envVars: envVars.map((v) => ({
        key: v.key,
        environment: v.environment,
        isSecret: v.isSecret,
        locked: v.locked,
        // A secret is only decrypted when it is going to be sealed with the passphrase.
        value:
          (v.locked && !canManageLocked) || (v.isSecret && options.passphrase === undefined)
            ? null
            : decrypt(v.valueEncrypted),
      })),
      domains: domains.map((d) => ({
        domain: d.domain,
        isPrimary: d.isPrimary,
        isAutoGenerated: d.isAutoGenerated,
        environment: d.environment,
        nginxSettings: (d.nginxSettings ?? null) as unknown as Record<string, unknown> | null,
      })),
      scheduledTasks: tasks.map((task) => ({
        name: task.name,
        type: task.type as 'command' | 'http',
        schedule: task.schedule,
        timezone: task.timezone,
        command: task.command,
        httpUrl: task.httpUrl,
        timeoutSeconds: task.timeoutSeconds,
        enabled: task.enabled,
      })),
      workers: workers.map((w) => ({ name: w.name, command: w.command, enabled: w.enabled })),
      volumes: volumes.map((v) => ({ name: v.name, containerPath: v.containerPath })),
      databases: connections.map((c) => ({
        id: c.database.id,
        name: c.database.name,
        type: c.database.type,
        envVarName: c.envVarName,
      })),
      apiUrl: getApiBaseUrl() || null,
      passphrase: options.passphrase,
    });
  },

  /**
   * Create a new project in this organization from a bundle. The project itself is created
   * through the usual checks (role, plan quota, repository settings); everything after that is
   * added one by one and whatever this instance refuses (a domain taken here, a plan limit) is
   * listed in `skipped` instead of failing the whole import. A wrong passphrase stops the import
   * before anything is created.
   */
  async import(
    organizationId: string,
    userId: string,
    bundle: ProjectExportBundle,
    options: { passphrase?: string; name?: string; serverId?: string },
    locale: SupportedLocale = 'en'
  ) {
    let resolved: ReturnType<typeof resolveImportedEnvVars>;
    try {
      resolved = resolveImportedEnvVars(bundle, options.passphrase);
    } catch (err) {
      throw new HTTPException(400, { message: reasonOf(err) });
    }

    const source = bundle.project;
    const project = await projectService.create(
      organizationId,
      userId,
      {
        name: options.name?.trim() || source.name,
        description: source.description ?? undefined,
        gitRepoUrl: source.gitRepoUrl ?? undefined,
        gitBranch: source.gitBranch ?? undefined,
        gitProvider: source.gitProvider ?? undefined,
        buildCommand: source.buildCommand ?? undefined,
        startCommand: source.startCommand ?? undefined,
        rootDirectory: source.rootDirectory ?? undefined,
        dockerfilePath: source.dockerfilePath ?? undefined,
        dockerImage: source.dockerImage ?? undefined,
        port: source.port ?? undefined,
        autoDeploy: source.autoDeploy,
        serverId: options.serverId,
      },
      locale
    );

    const skipped: ImportSkipped[] = resolved.skipped.map((v) => ({
      kind: 'envVar',
      name: `${v.key} (${v.environment})`,
      reason: v.reason,
    }));
    const attempt = async (kind: ImportSkipped['kind'], name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        return true;
      } catch (err) {
        skipped.push({ kind, name, reason: reasonOf(err) });
        return false;
      }
    };

    // Settings create() does not take; autoscaling separately, it depends on this instance's plan.
    await attempt('settings', 'build and compose settings', () =>
      projectService.update(
        project.id,
        organizationId,
        userId,
        {
          stagingBranch: source.stagingBranch,
          installCommand: source.installCommand ?? undefined,
          outputDirectory: source.outputDirectory ?? undefined,
          composePath: source.composePath,
          composeService: source.composeService,
          composePort: source.composePort,
          composePullPolicy: source.composePullPolicy,
          replicas: source.replicas,
          sleepEnabled: source.sleepEnabled,
          sleepAfterMinutes: source.sleepAfterMinutes,
        } as Parameters<typeof projectService.update>[3],
        locale
      )
    );
    if (source.autoscaleEnabled) {
      await attempt('settings', 'autoscaling', () =>
        projectService.update(
          project.id,
          organizationId,
          userId,
          {
            autoscaleEnabled: true,
            autoscaleMin: source.autoscaleMin,
            autoscaleMax: source.autoscaleMax,
            autoscaleObserveOnly: source.autoscaleObserveOnly,
          },
          locale
        )
      );
    }

    const counts = { envVars: 0, domains: 0, scheduledTasks: 0, workers: 0, volumes: 0 };

    for (const v of resolved.variables) {
      const ok = await attempt('envVar', `${v.key} (${v.environment})`, () =>
        envVarService.create(
          project.id,
          organizationId,
          userId,
          { key: v.key, value: v.value, environment: v.environment, isSecret: v.isSecret, locked: v.locked },
          locale
        )
      );
      if (ok) counts.envVars++;
    }

    for (const volume of bundle.volumes) {
      if (await attempt('volume', volume.name, () => projectVolumeService.createVolume(project.id, organizationId, userId, volume, locale))) {
        counts.volumes++;
      }
    }

    for (const worker of bundle.workers) {
      if (await attempt('worker', worker.name, () => projectWorkerService.createWorker(project.id, organizationId, userId, worker, locale))) {
        counts.workers++;
      }
    }

    for (const task of bundle.scheduledTasks) {
      if (await attempt('scheduledTask', task.name, () => scheduledTaskService.createTask(project.id, organizationId, userId, task, locale))) {
        counts.scheduledTasks++;
      }
    }

    for (const domain of bundle.domains) {
      if (domain.environment !== 'production') {
        skipped.push({ kind: 'domain', name: domain.domain, reason: 'Only production domains are imported; add staging domains by hand' });
        continue;
      }
      const ok = await attempt('domain', domain.domain, async () => {
        const created = await domainService.create(
          project.id,
          organizationId,
          userId,
          { domain: domain.domain, isPrimary: domain.isPrimary },
          locale
        );
        if (domain.nginxSettings && Object.keys(domain.nginxSettings).length > 0) {
          await domainService.updateNginxSettings(created.id, project.id, organizationId, userId, domain.nginxSettings, locale);
        }
      });
      if (ok) counts.domains++;
    }

    logger.info({ projectId: project.id, organizationId, userId, counts, skipped: skipped.length }, 'Project imported');

    return {
      project,
      imported: counts,
      skipped,
      databases: bundle.databases,
    };
  },
};
