import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { projectTrafficHourly } from '../db/schema/traffic';
import { getSSHConnection, type SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import {
  TRAFFIC_RANGES,
  TRAFFIC_RETENTION_DAYS,
  buildTrafficAnalytics,
  buildTrafficCleanupCommand,
  buildTrafficCollectCommand,
  isTrafficAnalyticsEnabledFor,
  parseTrafficCollectOutput,
  type TrafficAnalytics,
  type TrafficHourRow,
  type TrafficRange,
} from '../lib/traffic-analytics';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const trafficAnalyticsService = {
  /** Add hourly totals; a second batch for the same hour adds to the first. Unknown projects are skipped. */
  async storeRows(rows: TrafficHourRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const ids = [...new Set(rows.map((r) => r.projectId))];
    const existing = await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, ids));
    const known = new Set(existing.map((p) => p.id));
    const values = rows.filter((r) => known.has(r.projectId));
    if (values.length === 0) return 0;
    await db
      .insert(projectTrafficHourly)
      .values(values)
      .onConflictDoUpdate({
        target: [projectTrafficHourly.projectId, projectTrafficHourly.hour],
        set: {
          requests: sql`${projectTrafficHourly.requests} + excluded.requests`,
          status4xx: sql`${projectTrafficHourly.status4xx} + excluded.status_4xx`,
          status5xx: sql`${projectTrafficHourly.status5xx} + excluded.status_5xx`,
          bytesSent: sql`${projectTrafficHourly.bytesSent} + excluded.bytes_sent`,
        },
      });
    return values.length;
  },

  /** Collect one server's app logs: aggregate there, store here, then delete the raw files. */
  async collectFromServer(ssh: SSHClient): Promise<number> {
    const result = await ssh.exec(buildTrafficCollectCommand());
    if (result.code !== 0) {
      throw new Error(`traffic collect failed: ${(result.stderr || result.stdout).slice(0, 500)}`);
    }
    const { rows, files } = parseTrafficCollectOutput(result.stdout);
    const stored = await this.storeRows(rows);
    const cleanup = buildTrafficCleanupCommand(files);
    if (cleanup) await ssh.exec(cleanup);
    return stored;
  },

  /** Every running server with SSH access, one at a time. */
  async collectAll(): Promise<{ servers: number; rows: number }> {
    if (!env.TRAFFIC_ANALYTICS_ENABLED) return { servers: 0, rows: 0 };
    const list = await db.query.servers.findMany({ where: eq(servers.status, 'running') });
    let done = 0;
    let rows = 0;
    for (const server of list) {
      if (!server.ipv4 || !server.sshPrivateKey) continue;
      let ssh: SSHClient | null = null;
      try {
        ssh = await getSSHConnection({
          host: server.ipv4,
          port: 22,
          username: 'root',
          privateKey: decrypt(server.sshPrivateKey),
        });
        rows += await this.collectFromServer(ssh);
        done++;
      } catch (err) {
        logger.warn({ err, serverId: server.id }, 'Traffic analytics collection failed for server');
      } finally {
        ssh?.disconnect();
      }
    }
    return { servers: done, rows };
  },

  async getProjectAnalytics(
    projectId: string,
    range: TrafficRange,
    now: Date = new Date()
  ): Promise<TrafficAnalytics> {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      columns: { settings: true },
    });
    const enabled = isTrafficAnalyticsEnabledFor(project?.settings as Record<string, unknown> | null);
    const since = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS - (TRAFFIC_RANGES[range] - 1) * HOUR_MS);
    const rows = await db
      .select({
        hour: projectTrafficHourly.hour,
        requests: projectTrafficHourly.requests,
        status4xx: projectTrafficHourly.status4xx,
        status5xx: projectTrafficHourly.status5xx,
        bytesSent: projectTrafficHourly.bytesSent,
      })
      .from(projectTrafficHourly)
      .where(and(eq(projectTrafficHourly.projectId, projectId), gte(projectTrafficHourly.hour, since)));
    return buildTrafficAnalytics(rows, range, enabled, now);
  },

  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - TRAFFIC_RETENTION_DAYS * DAY_MS);
    const deleted = await db
      .delete(projectTrafficHourly)
      .where(lt(projectTrafficHourly.hour, cutoff))
      .returning({ projectId: projectTrafficHourly.projectId });
    return deleted.length;
  },
};
