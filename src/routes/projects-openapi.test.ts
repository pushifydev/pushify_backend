import { describe, it, expect, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';

/**
 * The project API documents the compose pull policy (`always` | `missing`) on the project and on
 * PATCH /projects/:projectId. Only the route table is read; nothing is called.
 */
vi.mock('../services/project.service', () => ({ projectService: {} }));
vi.mock('../services/project-transfer.service', () => ({ projectTransferService: {} }));
vi.mock('../services/activity.service', () => ({ activityService: {} }));

const { projectRoutes } = await import('./projects');

type SchemaObject = { properties?: Record<string, { enum?: string[]; description?: string }> };

describe('project routes: OpenAPI document', () => {
  it('has composePullPolicy on the project and the update body', () => {
    const docApp = new OpenAPIHono();
    docApp.route('/api/v1/projects', projectRoutes);
    const doc = docApp.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '0' } });
    const schemas = (doc.components?.schemas ?? {}) as Record<string, SchemaObject>;

    for (const name of ['Project', 'UpdateProject']) {
      const property = schemas[name]?.properties?.composePullPolicy;
      expect(property?.enum, name).toEqual(['always', 'missing']);
      expect(property?.description, name).toContain('missing');
    }
  });
});
