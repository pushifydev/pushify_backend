import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { deployments } from '../db/schema/deployments';
import { containerMetrics } from '../db/schema/metrics';
import { servers } from '../db/schema/servers';
import { getSSHConnection, SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { runContainer } from '../workers/remote-docker';
import { pickFreePorts } from '../workers/port-manager';
import { syncProjectSites } from '../lib/project-sites';
import { isSharedRunnerServer, resolveProjectServerId } from '../lib/runner-routing';
import { decodeRunSpec, replicaIndex, replicaName, type ContainerRunSpec } from '../lib/run-spec';
import { decideScale, policyFor, MIN_SAMPLES } from '../lib/autoscale';
import { activityService } from './activity.service';
import { logger } from '../lib/logger';

/**
 * Adding and removing containers on load, between deploys.
 *
 * Two things decide whether this is safe rather than merely clever:
 *
 * 1. A new container is started from the spec the *deploy* recorded, not from project settings
 *    read now. Otherwise a variable added since the last deploy would land in the new replica
 *    and not in its siblings, and the app would behave differently depending on which container
 *    answered — the worst kind of bug to chase.
 *
 * 2. Order. Scaling up starts the container and only then tells nginx about it. Scaling down
 *    takes it out of nginx *first*, reloads, and stops the container after — a container removed
 *    while nginx still lists it drops the requests that were in flight.
 */

/** Readings from this far back form the average — long enough to be a trend, short enough to matter. */
const SAMPLE_WINDOW_MS = 5 * 60 * 1000;

interface Candidate {
  projectId: string;
  slug: string;
  name: string;
  organizationId: string;
  serverId: string | null;
  autoscaleMin: number;
  autoscaleMax: number;
  autoscaledAt: Date | null;
}

export const autoscaleService = {
  /** Projects that asked for this and have somewhere to scale. */
  async candidates(): Promise<Candidate[]> {
    const rows = await db
      .select({
        projectId: projects.id,
        slug: projects.slug,
        name: projects.name,
        organizationId: projects.organizationId,
        serverId: projects.serverId,
        autoscaleMin: projects.autoscaleMin,
        autoscaleMax: projects.autoscaleMax,
        autoscaledAt: projects.autoscaledAt,
      })
      .from(projects)
      .where(
        and(
          eq(projects.autoscaleEnabled, true),
          eq(projects.status, 'active'),
          eq(projects.sleepState, 'awake')
        )
      );
    return rows;
  },

  /** One pass over every project that autoscales. */
  async check(now: Date = new Date()): Promise<{ checked: number; scaled: number }> {
    const candidates = await this.candidates();
    let scaled = 0;

    for (const candidate of candidates) {
      try {
        if (await this.checkProject(candidate, now)) scaled++;
      } catch (err) {
        logger.error({ err, projectId: candidate.projectId }, 'Autoscale check failed');
      }
    }
    return { checked: candidates.length, scaled };
  },

  async checkProject(candidate: Candidate, now: Date): Promise<boolean> {
    // The live deployment holds the spec; without one there is nothing to copy
    const [live] = await db
      .select({ id: deployments.id, runSpecEncrypted: deployments.runSpecEncrypted })
      .from(deployments)
      .where(and(eq(deployments.projectId, candidate.projectId), eq(deployments.status, 'running')))
      .orderBy(desc(deployments.createdAt))
      .limit(1);

    const spec = decodeRunSpec(live?.runSpecEncrypted);
    if (!spec) return false; // deployed before this existed, or unreadable — leave it alone

    const serverId = resolveProjectServerId({ id: candidate.projectId, serverId: candidate.serverId });
    if (!serverId) return false;

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (!server?.ipv4 || !server.sshPrivateKey) return false;

    const ssh = await getSSHConnection({
      host: server.ipv4,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    const running = await this.runningReplicas(ssh, spec);
    if (running.length === 0) return false; // mid-deploy or stopped: not ours to touch

    const { averageCpu, sampleCount } = await this.recentCpu(candidate.projectId, now);

    const decision = decideScale({
      current: running.length,
      averageCpu,
      sampleCount,
      lastScaledAt: candidate.autoscaledAt,
      policy: policyFor(candidate.autoscaleMin, candidate.autoscaleMax),
      now,
    });
    if (!decision) return false;

    logger.info(
      { projectId: candidate.projectId, from: running.length, to: decision.desired, reason: decision.reason },
      'Autoscaling'
    );

    const ok =
      decision.direction === 'up'
        ? await this.scaleUp(ssh, candidate, spec, running, server.ipv4)
        : await this.scaleDown(ssh, candidate, spec, running, server.ipv4);
    if (!ok) return false;

    await db.update(projects).set({ autoscaledAt: now, replicas: decision.desired }).where(eq(projects.id, candidate.projectId));

    activityService
      .log({
        organizationId: candidate.organizationId,
        projectId: candidate.projectId,
        action: 'project.updated',
        description: `Autoscaled ${candidate.name} to ${decision.desired} container${decision.desired === 1 ? '' : 's'} — ${decision.reason}`,
        metadata: { from: running.length, to: decision.desired, reason: decision.reason },
      })
      .catch(() => {});

    return true;
  },

  /** The project's containers in the live slot, with their host ports, lowest index first. */
  async runningReplicas(
    ssh: SSHClient,
    spec: ContainerRunSpec
  ): Promise<{ name: string; index: number; port: number }[]> {
    const listed = await ssh.exec(
      `docker ps --format '{{.Names}}' --filter name=^${spec.containerName}- --filter name=^${spec.containerName}$ 2>/dev/null || true`
    );

    const replicas: { name: string; index: number; port: number }[] = [];
    for (const name of listed.stdout.split('\n').map((n) => n.trim()).filter(Boolean)) {
      const index = replicaIndex(name, spec.containerName, spec.slot);
      if (index === null) continue;
      const portOut = await ssh.exec(`docker port ${name} ${spec.containerPort}/tcp 2>/dev/null | head -1`);
      const port = parseInt(portOut.stdout.trim().split(':').pop() || '', 10);
      if (!Number.isFinite(port)) continue;
      replicas.push({ name, index, port });
    }
    return replicas.sort((a, b) => a.index - b.index);
  },

  /** Average CPU across the project's containers over the sampling window. */
  async recentCpu(projectId: string, now: Date): Promise<{ averageCpu: number; sampleCount: number }> {
    const rows = await db
      .select({ cpuPercent: containerMetrics.cpuPercent })
      .from(containerMetrics)
      .where(
        and(
          eq(containerMetrics.projectId, projectId),
          gte(containerMetrics.recordedAt, new Date(now.getTime() - SAMPLE_WINDOW_MS))
        )
      );

    if (rows.length < MIN_SAMPLES) return { averageCpu: NaN, sampleCount: rows.length };
    const total = rows.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0);
    return { averageCpu: total / rows.length, sampleCount: rows.length };
  },

  /** Start one more container, then let nginx know about it. */
  async scaleUp(
    ssh: SSHClient,
    candidate: Candidate,
    spec: ContainerRunSpec,
    running: { name: string; index: number; port: number }[],
    serverIp: string
  ): Promise<boolean> {
    const used = running.map((r) => r.port);
    const [port] = await pickFreePorts(ssh, 1, used);
    if (!port) return false;

    const index = Math.max(...running.map((r) => r.index)) + 1;
    const name = replicaName(spec.containerName, spec.slot, index);

    const started = await runContainer(ssh, {
      imageName: spec.imageName,
      containerName: name,
      hostPort: port,
      containerPort: spec.containerPort,
      bindAddress: spec.bindAddress,
      envVars: spec.envVars,
      volumes: spec.volumes,
      networkMode: spec.networkMode,
      restart: 'unless-stopped',
      framework: spec.framework,
      buildpackId: spec.buildpackId,
    });
    if (!started.success) {
      logger.error({ projectId: candidate.projectId, name }, 'Autoscale could not start a container');
      return false;
    }

    // …and only now does nginx start sending it traffic
    return this.syncNginx(ssh, candidate, [...used, port], spec, serverIp);
  },

  /**
   * Take the last container out of nginx, reload, and only then stop it — a container removed
   * while nginx still lists it drops whatever was in flight.
   */
  async scaleDown(
    ssh: SSHClient,
    candidate: Candidate,
    spec: ContainerRunSpec,
    running: { name: string; index: number; port: number }[],
    serverIp: string
  ): Promise<boolean> {
    // Never the primary: it owns the project's recorded port and the blue-green switch
    const victim = running[running.length - 1];
    if (!victim || victim.index <= 1) return false;

    const remaining = running.filter((r) => r.name !== victim.name).map((r) => r.port);
    if (!(await this.syncNginx(ssh, candidate, remaining, spec, serverIp))) return false;

    // Give anything already inside the container a moment to finish before it goes
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await ssh.exec(`docker rm -f ${victim.name} 2>/dev/null || true`);
    return true;
  },

  /** Rewrite the vhost with this set of ports. Certificates are a deploy's job, not a scale's. */
  async syncNginx(
    ssh: SSHClient,
    candidate: Candidate,
    ports: number[],
    spec: ContainerRunSpec,
    serverIp: string
  ): Promise<boolean> {
    const result = await syncProjectSites(ssh, {
      projectId: candidate.projectId,
      projectSlug: candidate.slug,
      containerPort: spec.containerPort,
      containerPorts: ports,
      serverIp,
      requestCertificates: false,
      sharedHost: isSharedRunnerServer(candidate.serverId),
    });
    if (!result.success) {
      logger.error({ projectId: candidate.projectId, message: result.message }, 'Autoscale nginx update failed');
    }
    return result.success;
  },
};
