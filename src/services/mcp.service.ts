import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import type { ApiKeyScope } from '../db/schema';
import { hasScope } from './apikey.service';
import { projectService } from './project.service';
import { deploymentService } from './deployment.service';
import { serverService } from './server.service';
import { getProjectLogMasker } from '../workers/log-collector';
import type { LogMasker } from '../lib/log-masking';
import { currentApiKeyProjectIds } from '../lib/api-key-project-scope';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

/**
 * Read-only MCP tools (routes/mcp.ts). Each tool calls the same service the REST API uses, so the
 * creator's membership, role and restricted-member project list apply unchanged. On top of that:
 * - the key needs the scope the matching REST route asks for (`scopes`, any one of them);
 * - a key limited to projects (lib/api-key-project-scope) only sees its projects, and cannot use
 *   organization-wide tools (servers), as on the REST API;
 * - output is a fixed list of fields per tool (never env vars, webhook secrets or run specs), and
 *   every log or free-text deployment field goes through the project's secret masker again.
 *
 * Nothing here writes: deploy, cancel, rollback and delete tools are deliberately absent.
 */

export interface McpToolContext {
  userId: string;
  organizationId: string;
  /** Comma-separated scopes of the API key making the call (`*` = all) */
  scopes: string;
  locale: SupportedLocale;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface McpTool<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  /** The key needs at least one of these (same as the REST route behind the tool) */
  scopes: ApiKeyScope[];
  /** Organization-wide data: a key limited to projects may not use the tool */
  organizationWide?: boolean;
  input: S;
  run(args: z.output<S>, ctx: McpToolContext): Promise<unknown>;
}

const MAX_LOG_LINES = 1000;
const DEFAULT_LOG_LINES = 200;
/** A few very long lines must not turn one call into megabytes of context */
const MAX_LOG_CHARS = 100_000;

const projectIdField = z.string().uuid().describe('Project id (from list_projects)');

// ============ Output shaping ============

type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  gitBranch: string | null;
  serverId: string | null;
  settings?: unknown;
  updatedAt: Date;
  domains?: Array<{ domain: string; isPrimary: boolean; sslStatus?: string | null }>;
};

type DeploymentRow = {
  id: string;
  status: string;
  trigger: string;
  environment?: string | null;
  branch: string | null;
  commitHash: string | null;
  commitMessage: string | null;
  errorMessage: string | null;
  failureCategory: string | null;
  failureSummary: string | null;
  createdAt: Date;
  buildStartedAt: Date | null;
  buildFinishedAt: Date | null;
  deployFinishedAt: Date | null;
};

function projectSummary(p: ProjectRow) {
  const settings = (p.settings || {}) as Record<string, unknown>;
  const domains = p.domains ?? [];
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
    gitBranch: p.gitBranch,
    serverId: p.serverId,
    primaryDomain: (domains.find((d) => d.isPrimary) ?? domains[0])?.domain ?? null,
    productionUrl: typeof settings.productionUrl === 'string' ? settings.productionUrl : null,
    updatedAt: p.updatedAt,
  };
}

function maskText(masker: LogMasker, value: string | null): string | null {
  return value ? masker.mask(value) : value;
}

function deploymentSummary(d: DeploymentRow, masker: LogMasker) {
  return {
    id: d.id,
    status: d.status,
    environment: d.environment ?? 'production',
    trigger: d.trigger,
    branch: d.branch,
    commitHash: d.commitHash,
    commitMessage: maskText(masker, d.commitMessage),
    errorMessage: maskText(masker, d.errorMessage),
    failureCategory: d.failureCategory,
    failureSummary: maskText(masker, d.failureSummary),
    createdAt: d.createdAt,
    buildStartedAt: d.buildStartedAt,
    buildFinishedAt: d.buildFinishedAt,
    deployFinishedAt: d.deployFinishedAt,
  };
}

/** The last `maxLines` lines of a log, capped at MAX_LOG_CHARS from the end. */
export function tailLogLines(logs: string | null | undefined, maxLines: number) {
  const all = (logs ?? '').replace(/\n+$/, '');
  const lines = all ? all.split('\n') : [];
  let text = lines.slice(-maxLines).join('\n');
  if (text.length > MAX_LOG_CHARS) {
    // Cut at a line start, so a masked value is never split in the middle
    const cut = text.slice(-MAX_LOG_CHARS);
    const firstBreak = cut.indexOf('\n');
    text = firstBreak === -1 ? cut : cut.slice(firstBreak + 1);
  }
  const returned = text ? text.split('\n').length : 0;
  return { text, totalLines: lines.length, returnedLines: returned };
}

// ============ Access helpers ============

/** A key limited to projects sees only those; others are not found, as on the REST API. */
function assertProjectInKeyScope(projectId: string, locale: SupportedLocale) {
  const keyIds = currentApiKeyProjectIds();
  if (keyIds && !keyIds.includes(projectId.toLowerCase())) {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }
}

function inKeyScope(projectId: string): boolean {
  const keyIds = currentApiKeyProjectIds();
  return !keyIds || keyIds.includes(projectId.toLowerCase());
}

// ============ Tools ============

function defineTool<S extends z.ZodType>(tool: McpTool<S>): McpTool {
  return tool as unknown as McpTool;
}

const tools: McpTool[] = [
  defineTool({
    name: 'list_projects',
    title: 'List projects',
    description:
      'Projects of the organization this API key belongs to (only the key\'s own projects for a key limited to projects): id, name, status, branch, primary domain. Requires the projects:read scope.',
    scopes: ['projects:read'],
    input: z.object({}),
    async run(_args, ctx) {
      const rows = await projectService.getByOrganization(ctx.organizationId, ctx.userId, ctx.locale);
      return { projects: rows.filter((p) => inKeyScope(p.id)).map((p) => projectSummary(p)) };
    },
  }),
  defineTool({
    name: 'get_project',
    title: 'Get project',
    description:
      'One project: status, server, domains with SSL status, and its latest deployment when the key also has deployments:read. Never returns environment variables. Requires the projects:read scope.',
    scopes: ['projects:read'],
    input: z.object({ projectId: projectIdField }),
    async run({ projectId }, ctx) {
      assertProjectInKeyScope(projectId, ctx.locale);
      const project = await projectService.getById(projectId, ctx.organizationId, ctx.userId, ctx.locale);

      const result: Record<string, unknown> = {
        ...projectSummary(project),
        autoDeploy: project.autoDeploy,
        server: project.server
          ? {
              id: project.server.id,
              name: project.server.name,
              status: project.server.status,
              setupStatus: project.server.setupStatus,
            }
          : null,
        domains: (project.domains ?? []).map((d) => ({
          domain: d.domain,
          isPrimary: d.isPrimary,
          sslStatus: d.sslStatus ?? null,
        })),
      };

      if (hasScope(ctx.scopes, 'deployments:read')) {
        const [latest] = await deploymentService.getByProject(
          projectId,
          ctx.organizationId,
          ctx.userId,
          ctx.locale,
          1,
          0
        );
        result.latestDeployment = latest ? deploymentSummary(latest, await getProjectLogMasker(projectId)) : null;
      }
      return result;
    },
  }),
  defineTool({
    name: 'list_deployments',
    title: 'List deployments',
    description:
      'Recent deployments of a project, newest first: status, trigger, branch, commit, failure reason (secrets masked). Requires the deployments:read scope.',
    scopes: ['deployments:read'],
    input: z.object({
      projectId: projectIdField,
      limit: z.number().int().min(1).max(50).default(10).describe('How many deployments (1-50, default 10)'),
    }),
    async run({ projectId, limit }, ctx) {
      assertProjectInKeyScope(projectId, ctx.locale);
      const rows = await deploymentService.getByProject(
        projectId,
        ctx.organizationId,
        ctx.userId,
        ctx.locale,
        limit,
        0
      );
      if (rows.length === 0) return { deployments: [] };
      const masker = await getProjectLogMasker(projectId);
      return { deployments: rows.map((d) => deploymentSummary(d, masker)) };
    },
  }),
  defineTool({
    name: 'get_deployment_logs',
    title: 'Get deployment logs',
    description: `The last lines of a deployment's build or deploy log, with secrets and environment values masked. Requires the deployments:read or logs:read scope.`,
    scopes: ['deployments:read', 'logs:read'],
    input: z.object({
      projectId: projectIdField,
      deploymentId: z.string().uuid().describe('Deployment id (from list_deployments)'),
      type: z.enum(['build', 'deploy']).default('build').describe('build (default) or deploy log'),
      lines: z
        .number()
        .int()
        .min(1)
        .max(MAX_LOG_LINES)
        .default(DEFAULT_LOG_LINES)
        .describe(`How many lines from the end (1-${MAX_LOG_LINES}, default ${DEFAULT_LOG_LINES})`),
    }),
    async run({ projectId, deploymentId, type, lines }, ctx) {
      assertProjectInKeyScope(projectId, ctx.locale);
      const { logs, status } = await deploymentService.getLogs(
        deploymentId,
        projectId,
        ctx.organizationId,
        ctx.userId,
        ctx.locale,
        type
      );
      // Built before anything is returned: if it cannot be built, the call fails without logs.
      const masker = await getProjectLogMasker(projectId);
      const tail = tailLogLines(logs, lines);
      return {
        deploymentId,
        type,
        status,
        totalLines: tail.totalLines,
        returnedLines: tail.returnedLines,
        truncated: tail.returnedLines < tail.totalLines,
        logs: masker.mask(tail.text),
      };
    },
  }),
  defineTool({
    name: 'list_servers',
    title: 'List servers',
    description:
      'Servers of the organization: status, setup status, size, disk size and how full the disk is (from the hourly check). Requires the servers:read scope; not available to keys limited to projects.',
    scopes: ['servers:read'],
    organizationWide: true,
    input: z.object({}),
    async run(_args, ctx) {
      const rows = await serverService.listServers(ctx.organizationId, ctx.userId, ctx.locale);
      return {
        servers: rows.map((s) => ({
          id: s.id,
          name: s.name,
          provider: s.provider,
          region: s.region,
          size: s.size,
          status: s.status,
          setupStatus: s.setupStatus,
          statusMessage: s.statusMessage,
          ipv4: s.ipv4,
          vcpus: s.vcpus,
          memoryMb: s.memoryMb,
          diskGb: s.diskGb,
          diskUsedPercent: s.diskUsedPercent,
          diskCheckedAt: s.diskCheckedAt,
          projectCount: s.projectCount,
          databaseCount: s.databaseCount,
          lastSeenAt: s.lastSeenAt,
        })),
      };
    },
  }),
];

const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return json;
}

function textResult(value: unknown, isError = false): McpToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

export class McpUnknownToolError extends Error {}

export const mcpService = {
  /** Tool list for `tools/list` (every tool; a call without the scope gets an error result) */
  listTools() {
    return tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: inputJsonSchema(tool.input),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }));
  },

  /**
   * Run a tool for `tools/call`. Refusals and service errors come back as an error result (the
   * model reads them); an unknown tool name throws McpUnknownToolError (a protocol error).
   */
  async callTool(name: string, rawArgs: unknown, ctx: McpToolContext): Promise<McpToolResult> {
    const tool = toolsByName.get(name);
    if (!tool) throw new McpUnknownToolError(`Unknown tool: ${name}`);

    if (!tool.scopes.some((scope) => hasScope(ctx.scopes, scope))) {
      return textResult(`${t(ctx.locale, 'apiKeys', 'insufficientScope')} (${tool.scopes.join(' or ')})`, true);
    }
    if (tool.organizationWide && currentApiKeyProjectIds()) {
      return textResult(t(ctx.locale, 'apiKeys', 'projectScoped'), true);
    }

    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
      return textResult(`Invalid arguments: ${details}`, true);
    }

    try {
      return textResult(await tool.run(parsed.data, ctx));
    } catch (error) {
      if (error instanceof HTTPException) return textResult(error.message, true);
      logger.error({ err: error, tool: name }, 'MCP tool failed');
      return textResult(t(ctx.locale, 'errors', 'internalError'), true);
    }
  },
};
