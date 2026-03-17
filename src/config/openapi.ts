import type { OpenAPIHono } from '@hono/zod-openapi';

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
    description: 'Enter your JWT access token',
  });
}
