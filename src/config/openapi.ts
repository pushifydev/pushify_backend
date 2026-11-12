import type { OpenAPIHono } from '@hono/zod-openapi';
import { API_KEY_SCOPES } from '../db/schema/apikeys';

/** Scope list for the security scheme description, generated so it never drifts from the code */
export function apiKeyScopesDescription(): string {
  const lines = Object.entries(API_KEY_SCOPES).map(([scope, label]) => `- \`${scope}\`: ${label}`);
  return [
    'A dashboard JWT access token, or an API key (`pk_live_…`, also accepted as `X-API-Key`).',
    'API keys only reach routes their scopes allow (`*` = every scope); otherwise `403`.',
    'Deleting a resource (DELETE routes) needs its `:delete` scope, not `:write`; data edits in the database studios stay `databases:write`.',
    '',
    'API key scopes:',
    ...lines,
  ].join('\n');
}

export const openApiConfig = {
  openapi: '3.1.0' as const,
  info: {
    title: 'Pushify API',
    version: '0.1.0',
    description: 'Open-source cloud platform API for deploying and managing applications',
    contact: {
      name: 'Pushify Team',
      url: 'https://github.com/pushify',
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT',
    },
  },
  servers: [
    {
      url: 'http://localhost:4000',
      description: 'Development server',
    },
  ],
  tags: [
    {
      name: 'Authentication',
      description: 'User authentication and session management',
    },
    {
      name: 'Projects',
      description: 'Project management endpoints',
    },
    {
      name: 'Deployments',
      description: 'Deployment management endpoints',
    },
    {
      name: 'Domains',
      description: 'Domain management endpoints',
    },
  ],
};

export function registerSecuritySchemes(app: OpenAPIHono<any>) {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: apiKeyScopesDescription(),
  });
}
