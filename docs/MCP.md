# MCP server (read-only)

Pushify exposes a read-only [Model Context Protocol](https://modelcontextprotocol.io) server so an
AI agent (Claude Code, Claude Desktop, Cursor, …) can look at your projects, deployments, deploy
logs and servers. It cannot deploy, cancel, roll back, change or delete anything.

- **Endpoint:** `POST https://api.pushify.dev/api/v1/mcp` (self-hosted: `<API_BASE_URL>/api/v1/mcp`)
- **Transport:** Streamable HTTP, stateless; every message is one `POST` answered with JSON
  (`GET` and `DELETE` answer `405`). Source: `src/routes/mcp.ts`, tools in `src/services/mcp.service.ts`.
- **Auth:** an API key only (`Authorization: Bearer pk_live_…` or `X-API-Key: pk_live_…`); a
  dashboard session token is refused with `401`.

## Tools

| Tool | Returns | Scope (any one) |
|------|---------|-----------------|
| `list_projects` | id, name, status, branch, primary domain, production URL | `projects:read` |
| `get_project` | the above plus server, domains with SSL status, latest deployment (only if the key also has `deployments:read`) | `projects:read` |
| `list_deployments` | recent deployments (`limit` 1–50, default 10): status, trigger, branch, commit, failure reason | `deployments:read` |
| `get_deployment_logs` | last `lines` (1–1000, default 200) of the `build` or `deploy` log | `deployments:read`, `logs:read` |
| `list_servers` | status, setup status, size, disk size and disk usage % | `servers:read` |

## What the key is still limited by

The MCP server uses the same checks as the REST API:

- **Scopes:** a tool the key has no scope for returns an error result and reads nothing.
- **Project-limited keys:** only their own projects are listed; any other project is "not found".
  `list_servers` is refused (organization-wide data, as `GET /api/v1/servers` is).
- **The key's creator:** their role and, for a restricted member, their project list apply.
- **Organization 2FA:** while the organization requires 2FA and the key's creator has none, every
  request gets `403 ORG_2FA_REQUIRED`.
- **Rate limit:** every MCP message counts against the plan's API rate limit (`429` when exceeded;
  applies when `RATE_LIMIT_ENABLED` is on, as for the REST API).
- **Secrets:** no tool returns environment variables, webhook secrets or run specs. Logs and
  deployment error texts are masked again with the project's current secrets when read; if the
  masker cannot be built (e.g. the secret provider is down) the call fails instead of returning logs.

## Setup

1. Create an API key (dashboard, or `POST /api/v1/api-keys`) with only the read scopes you need,
   e.g. `projects:read,deployments:read,logs:read,servers:read`, and limit it to projects if the
   agent should only see some of them.
2. Add the server to your MCP client.

### Claude Code

```bash
export PUSHIFY_API_KEY=pk_live_...
claude mcp add --transport http pushify https://api.pushify.dev/api/v1/mcp \
  --header "Authorization: Bearer $PUSHIFY_API_KEY"
```

Or commit a project-level `.mcp.json` that reads the key from the environment (no secret in git):

```json
{
  "mcpServers": {
    "pushify": {
      "type": "http",
      "url": "https://api.pushify.dev/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${PUSHIFY_API_KEY}" }
    }
  }
}
```

Then ask, for example: "Why did the last deployment of my api project fail?" (uses
`list_projects` → `list_deployments` → `get_deployment_logs`).

### Check it with curl

```bash
curl -sS https://api.pushify.dev/api/v1/mcp \
  -H "Authorization: Bearer $PUSHIFY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
