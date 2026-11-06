import { HTTPException } from 'hono/http-exception';
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db } from '../db';
import { logDrains, type LogDrain } from '../db/schema/log-drains';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { activityService } from './activity.service';
import { encrypt, decrypt } from '../lib/encryption';
import { assertPublicUrl } from '../lib/ssrf-guard';
import { isSharedRunnerServer } from '../lib/runner-routing';
import { projectContainerNames } from '../lib/project-containers';
import {
  agentNeedsContainerStats,
  buildDrainTestRequest,
  buildVectorConfig,
  installLogAgentCommand,
  isLogDrainType,
  LOG_DRAIN_TYPES,
  normalizeLogDrainSettings,
  parseLogAgentOutput,
  removeLogAgentCommand,
  scrubSecrets,
  secretRequired,
  validateLogDrainSecret,
  type AgentDrain,
  type LogAgentSyncStatus,
  type LogDrainOptions,
  type LogDrainType,
} from '../lib/log-drains';
import { SSHClient } from '../utils/ssh';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

/**
 * Log and metric drains (lib/log-drains.ts). Any member sees them; owners and admins manage them,
 * like secret manager connections. The secret is write-only. Every change re-syncs the agent on
 * the organization's servers in the background; POST /log-drains/sync does it and waits.
 */

const TEST_TIMEOUT_MS = 10_000;
const SYNC_TIMEOUT_MS = 5 * 60_000;

export interface PublicLogDrain {
  id: string;
  projectId: string | null;
  name: string;
  type: string;
  endpoint: string | null;
  options: LogDrainOptions;
  hasSecret: boolean;
  sendLogs: boolean;
  sendMetrics: boolean;
  enabled: boolean;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LogDrainInput {
  name?: unknown;
  type?: unknown;
  projectId?: unknown;
  endpoint?: unknown;
  /** Write-only. On update: omitted keeps the stored one, `null` or `""` removes it. */
  secret?: unknown;
  options?: unknown;
  sendLogs?: unknown;
  sendMetrics?: unknown;
  enabled?: unknown;
}

export interface LogDrainTestResult {
  ok: boolean;
  status: number | null;
  message: string;
  testedAt: Date;
}

export interface LogAgentSyncResult {
  serverId: string;
  serverName: string;
  status: LogAgentSyncStatus | 'skipped';
  drains: number;
  message: string | null;
}

function toPublic(row: LogDrain): PublicLogDrain {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    type: row.type,
    endpoint: row.endpoint,
    options: row.options as LogDrainOptions,
    hasSecret: !!row.secretEncrypted,
    sendLogs: row.sendLogs,
    sendMetrics: row.sendMetrics,
    enabled: row.enabled,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const badRequest = (message: string) => new HTTPException(400, { message });

async function assertMember(organizationId: string, userId: string, locale: SupportedLocale) {
  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  return membership;
}

async function assertCanManage(organizationId: string, userId: string, locale: SupportedLocale) {
  const membership = await assertMember(organizationId, userId, locale);
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
  }
}

async function findDrain(organizationId: string, id: string): Promise<LogDrain> {
  const [row] = await db
    .select()
    .from(logDrains)
    .where(and(eq(logDrains.id, id), eq(logDrains.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new HTTPException(404, { message: 'Log drain not found' });
  return row;
}

function decryptSecret(row: Pick<LogDrain, 'secretEncrypted'>): string | null {
  if (!row.secretEncrypted) return null;
  try {
    return decrypt(row.secretEncrypted);
  } catch {
    throw new Error('the stored drain secret could not be decrypted — set the secret again');
  }
}

/** Validates a create (no `existing`) or an update and returns the columns to write. */
async function storedValues(
  organizationId: string,
  input: LogDrainInput,
  locale: SupportedLocale,
  existing?: LogDrain
): Promise<Omit<typeof logDrains.$inferInsert, 'organizationId'>> {
  if (!input || typeof input !== 'object') throw badRequest('Invalid request data');

  const type = input.type ?? existing?.type;
  if (!isLogDrainType(type)) throw badRequest(`type must be one of: ${LOG_DRAIN_TYPES.join(', ')}`);

  const rawName = input.name ?? existing?.name;
  if (typeof rawName !== 'string' || !rawName.trim() || rawName.trim().length > 100) {
    throw badRequest('name is required (at most 100 characters)');
  }

  let projectId: string | null = existing?.projectId ?? null;
  if (input.projectId !== undefined) {
    if (input.projectId !== null && typeof input.projectId !== 'string') throw badRequest('projectId must be a string or null');
    projectId = input.projectId || null;
  }
  if (projectId && projectId !== existing?.projectId) {
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId || project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }
  }

  for (const key of ['sendLogs', 'sendMetrics', 'enabled'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw badRequest(`${key} must be a boolean`);
  }
  if (input.endpoint !== undefined && input.endpoint !== null && typeof input.endpoint !== 'string') {
    throw badRequest('endpoint must be a string');
  }
  if (input.options !== undefined && (input.options === null || typeof input.options !== 'object' || Array.isArray(input.options))) {
    throw badRequest('options must be an object');
  }

  const typeChanged = !!existing && existing.type !== type;
  const normalized = normalizeLogDrainSettings({
    type,
    endpoint: input.endpoint !== undefined ? (input.endpoint as string | null) : typeChanged ? null : existing?.endpoint,
    options: (input.options as Record<string, unknown> | undefined) ?? (typeChanged ? {} : existing?.options) ?? {},
    sendLogs: (input.sendLogs as boolean | undefined) ?? existing?.sendLogs,
    sendMetrics: (input.sendMetrics as boolean | undefined) ?? existing?.sendMetrics,
  });
  if ('problem' in normalized) throw badRequest(normalized.problem);

  let secretEncrypted = existing?.secretEncrypted ?? null;
  if (input.secret !== undefined) {
    if (input.secret === null || input.secret === '') {
      secretEncrypted = null;
    } else if (typeof input.secret !== 'string') {
      throw badRequest('secret must be a string');
    } else {
      const problem = validateLogDrainSecret(input.secret);
      if (problem) throw badRequest(problem);
      secretEncrypted = encrypt(input.secret);
    }
  }
  if (!secretEncrypted && secretRequired(type)) throw badRequest(`secret is required for ${type} drains`);

  return {
    projectId,
    name: rawName.trim(),
    type,
    endpoint: normalized.settings.endpoint,
    options: normalized.settings.options as Record<string, string>,
    secretEncrypted,
    sendLogs: normalized.settings.sendLogs,
    sendMetrics: normalized.settings.sendMetrics,
    enabled: (input.enabled as boolean | undefined) ?? existing?.enabled ?? true,
  };
}

/** One sync per server at a time in this process; the remote side also takes a lock. */
const serverSyncs = new Map<string, Promise<unknown>>();

function serialize<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const previous = serverSyncs.get(serverId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  serverSyncs.set(serverId, next);
  void next.finally(() => {
    if (serverSyncs.get(serverId) === next) serverSyncs.delete(serverId);
  }).catch(() => undefined);
  return next;
}

async function execWithTimeout(ssh: SSHClient, command: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      ssh.exec(command),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('log agent sync timed out')), SYNC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The enabled drains that apply to a server, decrypted, plus the projects running there. */
async function agentPlan(server: { id: string; organizationId: string }) {
  const serverProjects = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.serverId, server.id), ne(projects.status, 'deleted')));
  const projectIds = serverProjects.map((p) => p.id);
  const rows = await db
    .select()
    .from(logDrains)
    .where(
      and(
        eq(logDrains.organizationId, server.organizationId),
        eq(logDrains.enabled, true),
        projectIds.length ? or(isNull(logDrains.projectId), inArray(logDrains.projectId, projectIds)) : isNull(logDrains.projectId)
      )
    )
    .orderBy(logDrains.createdAt);
  const slugById = new Map(serverProjects.map((p) => [p.id, p.slug]));
  const drains: AgentDrain[] = rows.map((row) => ({
    id: row.id,
    type: row.type as LogDrainType,
    endpoint: row.endpoint,
    options: row.options as LogDrainOptions,
    sendLogs: row.sendLogs,
    sendMetrics: row.sendMetrics,
    projectSlug: row.projectId ? slugById.get(row.projectId) ?? null : null,
    secret: decryptSecret(row),
  }));
  const agentProjects = await Promise.all(
    serverProjects.map(async (p) => ({ ...p, workerNames: (await projectContainerNames(p.id, p.slug)).workers }))
  );
  return { drains, projects: agentProjects };
}

export const logDrainService = {
  async list(organizationId: string, userId: string, locale: SupportedLocale = 'en'): Promise<PublicLogDrain[]> {
    await assertMember(organizationId, userId, locale);
    const rows = await db
      .select()
      .from(logDrains)
      .where(eq(logDrains.organizationId, organizationId))
      .orderBy(desc(logDrains.createdAt));
    return rows.map(toPublic);
  },

  async create(organizationId: string, userId: string, input: LogDrainInput, locale: SupportedLocale = 'en') {
    await assertCanManage(organizationId, userId, locale);
    const values = await storedValues(organizationId, input, locale);
    const [row] = await db.insert(logDrains).values({ organizationId, ...values }).returning();
    await activityService.log({
      organizationId,
      userId,
      projectId: row.projectId ?? undefined,
      action: 'log_drain.created',
      description: `Log drain "${row.name}" (${row.type}) added`,
      metadata: { drainId: row.id, type: row.type, endpoint: row.endpoint, sendLogs: row.sendLogs, sendMetrics: row.sendMetrics },
    });
    logDrainService.syncInBackground(organizationId);
    return toPublic(row);
  },

  async update(organizationId: string, userId: string, id: string, input: LogDrainInput, locale: SupportedLocale = 'en') {
    await assertCanManage(organizationId, userId, locale);
    const existing = await findDrain(organizationId, id);
    const values = await storedValues(organizationId, input, locale, existing);
    const [row] = await db
      .update(logDrains)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(logDrains.id, existing.id))
      .returning();
    await activityService.log({
      organizationId,
      userId,
      projectId: row.projectId ?? undefined,
      action: 'log_drain.updated',
      description: `Log drain "${row.name}" (${row.type}) updated`,
      metadata: {
        drainId: row.id,
        type: row.type,
        endpoint: row.endpoint,
        enabled: row.enabled,
        secretChanged: values.secretEncrypted !== existing.secretEncrypted,
      },
    });
    logDrainService.syncInBackground(organizationId);
    return toPublic(row);
  },

  async remove(organizationId: string, userId: string, id: string, locale: SupportedLocale = 'en') {
    await assertCanManage(organizationId, userId, locale);
    const existing = await findDrain(organizationId, id);
    await db.delete(logDrains).where(eq(logDrains.id, existing.id));
    await activityService.log({
      organizationId,
      userId,
      projectId: existing.projectId ?? undefined,
      action: 'log_drain.deleted',
      description: `Log drain "${existing.name}" (${existing.type}) removed`,
      metadata: { drainId: existing.id, type: existing.type },
    });
    logDrainService.syncInBackground(organizationId);
    return { success: true };
  },

  /**
   * Sends one test event from the API to the drain and records the outcome. Endpoints on private
   * addresses can only be reached from the organization's own servers, so they are not tested.
   */
  async test(organizationId: string, userId: string, id: string, locale: SupportedLocale = 'en'): Promise<LogDrainTestResult> {
    await assertCanManage(organizationId, userId, locale);
    const row = await findDrain(organizationId, id);
    const secret = decryptSecret(row);
    const normalized = normalizeLogDrainSettings({
      type: row.type as LogDrainType,
      endpoint: row.endpoint,
      options: row.options,
      sendLogs: row.sendLogs,
      sendMetrics: row.sendMetrics,
    });
    if ('problem' in normalized) throw badRequest(normalized.problem);

    const request = buildDrainTestRequest(normalized.settings, secret);
    const testedAt = new Date();
    let result: LogDrainTestResult;
    try {
      await assertPublicUrl(request.url);
    } catch (err) {
      result = {
        ok: false,
        status: null,
        message: `Not tested: ${err instanceof Error ? err.message : 'blocked URL'}. A private endpoint is only reachable from your servers.`,
        testedAt,
      };
      return logDrainService.recordTest(row.id, result);
    }
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      const text = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 300);
      result = response.ok
        ? { ok: true, status: response.status, message: `Accepted (HTTP ${response.status})`, testedAt }
        : { ok: false, status: response.status, message: `HTTP ${response.status}${text ? `: ${text}` : ''}`, testedAt };
    } catch (err) {
      const reason = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : 'request failed';
      result = { ok: false, status: null, message: `Request failed: ${reason}`, testedAt };
    }
    result.message = scrubSecrets(result.message, [secret]).replace(/\s+/g, ' ').trim().slice(0, 500);
    return logDrainService.recordTest(row.id, result);
  },

  async recordTest(id: string, result: LogDrainTestResult): Promise<LogDrainTestResult> {
    await db
      .update(logDrains)
      .set({ lastTestedAt: result.testedAt, lastTestOk: result.ok, lastTestError: result.ok ? null : result.message })
      .where(eq(logDrains.id, id));
    return result;
  },

  /** POST /log-drains/sync: owners and admins re-apply the agent on every server and wait. */
  async syncForUser(organizationId: string, userId: string, locale: SupportedLocale = 'en') {
    await assertCanManage(organizationId, userId, locale);
    return logDrainService.syncOrganization(organizationId);
  },

  syncInBackground(organizationId: string): void {
    void logDrainService.syncOrganization(organizationId).catch((err) => {
      logger.warn({ err, organizationId }, 'Log agent sync failed');
    });
  },

  /** Installs, updates or removes the agent on each of the organization's own servers. */
  async syncOrganization(organizationId: string): Promise<LogAgentSyncResult[]> {
    const rows = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.organizationId, organizationId));
    const results: LogAgentSyncResult[] = [];
    for (const { id } of rows) {
      if (isSharedRunnerServer(id)) continue;
      results.push(await logDrainService.syncServer(id));
    }
    return results;
  },

  /**
   * Brings one server's agent in line with its drains: installed / updated when there are any,
   * removed when there are none. Shared runners are never touched. Never throws.
   */
  syncServer(serverId: string): Promise<LogAgentSyncResult> {
    return serialize(serverId, async () => {
      const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
      const base = { serverId, serverName: server?.name ?? '', drains: 0 };
      if (!server || isSharedRunnerServer(serverId)) return { ...base, status: 'skipped', message: 'not an organization server' };
      if (server.status !== 'running' || server.setupStatus !== 'completed' || !server.ipv4 || !server.sshPrivateKey) {
        return { ...base, status: 'skipped', message: 'server is not running or not reachable over SSH' };
      }

      let secrets: Array<string | null> = [];
      let ssh: SSHClient | null = null;
      try {
        const plan = await agentPlan(server);
        secrets = plan.drains.map((d) => d.secret);
        const command = plan.drains.length
          ? installLogAgentCommand(
              buildVectorConfig({ serverId, serverName: server.name, projects: plan.projects, drains: plan.drains }),
              agentNeedsContainerStats(plan.drains)
            )
          : removeLogAgentCommand();

        ssh = new SSHClient();
        await ssh.connect({ host: server.ipv4, port: 22, username: 'root', privateKey: decrypt(server.sshPrivateKey) });
        const out = await execWithTimeout(ssh, command);
        const parsed = parseLogAgentOutput(out.stdout);
        const status: LogAgentSyncStatus = parsed.status ?? 'failed';
        const detail = out.stdout
          .split('\n')
          .filter((line) => line.trim() && !line.startsWith('PUSHIFY_LOG_AGENT status='))
          .slice(-20)
          .join('\n');
        const message =
          status === 'failed'
            ? scrubSecrets(`${parsed.error ?? `exit code ${out.code}`}${detail ? `\n${detail}` : ''}\n${out.stderr.slice(-500)}`.trim(), secrets)
            : parsed.notes.join(', ') || null;
        if (status === 'failed') logger.warn({ serverId, message }, 'Log agent sync failed on server');
        else logger.info({ serverId, status, drains: plan.drains.length }, 'Log agent synced');
        return { ...base, status, drains: plan.drains.length, message };
      } catch (err) {
        const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
        logger.warn({ serverId, message }, 'Log agent sync failed on server');
        return { ...base, status: 'failed', message };
      } finally {
        ssh?.disconnect();
      }
    });
  },
};
