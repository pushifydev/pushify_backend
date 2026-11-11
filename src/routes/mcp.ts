import { Hono, type Context } from 'hono';
import { apiKeyAuthMiddleware } from '../middleware/apikey-auth';
import { mcpService, McpUnknownToolError } from '../services/mcp.service';
import { readRunningVersion } from '../lib/platform-version';
import { env } from '../config/env';
import type { AppEnv } from '../types';

/**
 * Read-only MCP server (Model Context Protocol), Streamable HTTP transport, stateless: every
 * JSON-RPC message is one POST answered with plain JSON. There is no server-initiated stream
 * (GET) and no session to end (DELETE), so both answer 405, as the transport allows.
 *
 * Authentication is an API key only (`Authorization: Bearer pk_live_…` or `X-API-Key`), through
 * apiKeyAuthMiddleware: organization 2FA policy, the key's project list and the plan rate limit
 * apply to every message. Each tool checks the key's scopes itself (services/mcp.service.ts).
 *
 * Setup and a Claude Code example: docs/MCP.md.
 */

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const LATEST_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];

// JSON-RPC 2.0 error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const mcpRouter = new Hono<AppEnv>();

const methodNotAllowed = (c: Context) => c.body(null, 405, { Allow: 'POST' });
mcpRouter.get('/', methodNotAllowed);
mcpRouter.delete('/', methodNotAllowed);

// The transport requires checking Origin (DNS rebinding). MCP clients send none; a browser page
// may only come from the dashboard's own origins, as for CORS.
mcpRouter.post('/', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin && ![env.CORS_ORIGIN, env.FRONTEND_URL].includes(origin)) {
    return c.json(rpcError(null, INVALID_REQUEST, 'Origin not allowed'), 403);
  }
  // Sent by clients after initialization (2025-06-18 and later); an unknown one is refused.
  const version = c.req.header('MCP-Protocol-Version');
  if (version && !(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return c.json(rpcError(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version}`), 400);
  }
  await next();
});

mcpRouter.post('/', apiKeyAuthMiddleware, async (c) => {
  let message: unknown;
  try {
    message = await c.req.json();
  } catch {
    return c.json(rpcError(null, PARSE_ERROR, 'Parse error'), 400);
  }

  if (Array.isArray(message)) {
    return c.json(rpcError(null, INVALID_REQUEST, 'Batch requests are not supported'), 400);
  }
  if (!isRecord(message) || message.jsonrpc !== '2.0') {
    return c.json(rpcError(null, INVALID_REQUEST, 'Invalid JSON-RPC message'), 400);
  }

  // Notifications (no id) and responses to us need no answer
  const hasId = 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number');
  if (!hasId || typeof message.method !== 'string') {
    return c.body(null, 202);
  }

  const id = message.id as string | number;
  const params = isRecord(message.params) ? message.params : {};

  switch (message.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return c.json(
        rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pushify', title: 'Pushify', version: readRunningVersion() ?? '0.0.0' },
          instructions:
            'Read-only access to the Pushify projects, deployments, deployment logs and servers this API key can see. Environment variable values are never returned; logs are masked.',
        })
      );
    }

    case 'ping':
      return c.json(rpcResult(id, {}));

    case 'tools/list':
      return c.json(rpcResult(id, { tools: mcpService.listTools() }));

    case 'tools/call': {
      if (typeof params.name !== 'string') {
        return c.json(rpcError(id, INVALID_PARAMS, 'Missing tool name'));
      }
      try {
        const result = await mcpService.callTool(params.name, params.arguments, {
          userId: c.get('userId')!,
          organizationId: c.get('organizationId')!,
          scopes: c.get('apiKey')?.scopes ?? '',
          locale: c.get('locale') || 'en',
        });
        return c.json(rpcResult(id, result));
      } catch (error) {
        if (error instanceof McpUnknownToolError) {
          return c.json(rpcError(id, INVALID_PARAMS, error.message));
        }
        throw error;
      }
    }

    default:
      return c.json(rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`));
  }
});

export { mcpRouter as mcpRoutes };
