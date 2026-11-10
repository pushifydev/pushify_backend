import { describe, it, expect, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';

/**
 * The compose pull policy is part of the project in the OpenAPI document: returned on the
 * project, settable with PATCH /projects/:projectId, and limited to `always` / `missing`.
 * Services and auth are mocked; only the route schemas are read.
 */
vi.mock('../services/project.service', () => ({ projectService: {} }));
vi.mock('../services/project-transfer.service', () => ({ projectTransferService: {} }));
vi.mock('../services/activity.service', () => ({ activityService: {} }));
vi.mock('../middleware/auth', () => ({
  combinedAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../middleware/apikey-auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { projectRoutes } = await import('./projects');

describe('projects OpenAPI: composePullPolicy', () => {
  const app = new OpenAPIHono();
  app.route('/api/v1/projects', projectRoutes);
  const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '0' } });
  const schemas = (doc.components?.schemas ?? {}) as Record<
    string,
    { properties?: Record<string, { enum?: string[] }>; required?: string[] }
  >;

  it('is returned on the project, always set', () => {
    expect(schemas.Project.properties?.composePullPolicy?.enum).toEqual(['always', 'missing']);
    expect(schemas.Project.required).toContain('composePullPolicy');
  });

  it('is optional on PATCH /projects/:projectId', () => {
    expect(schemas.UpdateProject.properties?.composePullPolicy?.enum).toEqual(['always', 'missing']);
    expect(schemas.UpdateProject.required ?? []).not.toContain('composePullPolicy');
  });
});
