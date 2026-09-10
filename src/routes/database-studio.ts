import { safeAttachmentName } from '../lib/utils';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { databaseStudioService, type StudioFilter } from '../services/database-studio.service';
import { requireScope } from '../middleware/apikey-auth';
import { hasScope } from '../services/apikey.service';
import { t } from '../i18n';
import type { AppEnv } from '../types';

/**
 * Data browser for managed PostgreSQL / MySQL databases. Mounted inside databasesRouter, so the
 * auth middleware there already applies; the service does the owner/admin check on top of that.
 */
const studioRouter = new Hono<AppEnv>();

function parseFilters(raw: string | undefined): StudioFilter[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StudioFilter[]) : undefined;
  } catch {
    return undefined;
  }
}

// List tables/views with their row estimates
studioRouter.get('/:id/studio/tables', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const result = await databaseStudioService.listTables(
    c.req.param('id'),
    organizationId,
    userId,
    locale
  );

  return c.json({ data: result });
});

// Read a page of rows from one table
studioRouter.get('/:id/studio/rows', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const query = c.req.query();

  const table = query.table;
  if (!table) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'table is required' } }, 400);
  }

  const result = await databaseStudioService.getRows(
    c.req.param('id'),
    organizationId,
    userId,
    {
      schema: query.schema,
      table,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
      orderBy: query.orderBy,
      orderDir: query.orderDir === 'desc' ? 'desc' : 'asc',
      filters: parseFilters(query.filters),
    },
    locale
  );

  return c.json({ data: result });
});

// Insert a row
studioRouter.post('/:id/studio/rows', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.insertRow(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioRowInserted') }, 201);
});

// Update a single row, addressed by its primary key
studioRouter.patch('/:id/studio/rows', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.updateRow(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioRowUpdated') });
});

// Delete rows by primary key (POST because the payload carries the key list)
studioRouter.post('/:id/studio/rows/delete', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.deleteRows(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioRowsDeleted') });
});

// SQL console. Read-only by default; writes need an explicit allowWrite from the client.
studioRouter.post('/:id/studio/query', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  // The read scope is enough to browse; running a write query needs the write scope too.
  if (body?.allowWrite === true && c.get('isApiKeyAuth')) {
    const apiKey = c.get('apiKey');
    if (!apiKey || !hasScope(apiKey.scopes, 'databases:write')) {
      throw new HTTPException(403, { message: t(locale, 'apiKeys', 'insufficientScope') });
    }
  }

  const result = await databaseStudioService.runQuery(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result });
});


// Full schema map (tables + columns) — powers the console's autocomplete
studioRouter.get('/:id/studio/schema', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const result = await databaseStudioService.getSchemaMap(
    c.req.param('id'),
    organizationId,
    userId,
    locale
  );

  return c.json({ data: result });
});

// Export a query result as CSV or JSON (always read-only)
studioRouter.post('/:id/studio/query/export', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.exportQuery(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return new Response(result.body, {
    headers: {
      'Content-Type': result.contentType,
      'Content-Disposition': `attachment; filename="${safeAttachmentName(result.fileName, 'query')}"`,
      'X-Row-Count': String(result.rowCount),
      'X-Truncated': String(result.truncated),
    },
  });
});

// Append a batch of rows (CSV import)
studioRouter.post('/:id/studio/import', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.importRows(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioRowsImported') });
});

// ============ Indexes & performance ============

studioRouter.get('/:id/studio/indexes', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const query = c.req.query();

  if (!query.table) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'table is required' } }, 400);
  }

  const result = await databaseStudioService.listIndexes(
    c.req.param('id'),
    organizationId,
    userId,
    { schema: query.schema, table: query.table },
    locale
  );

  return c.json({ data: result });
});

studioRouter.post('/:id/studio/indexes', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.createIndex(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioIndexCreated') }, 201);
});

studioRouter.delete('/:id/studio/indexes', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const query = c.req.query();

  if (!query.table || !query.name) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'table and name are required' } }, 400);
  }

  const result = await databaseStudioService.dropIndex(
    c.req.param('id'),
    organizationId,
    userId,
    { schema: query.schema, table: query.table, name: query.name },
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioIndexDropped') });
});

// Cancel a running statement
studioRouter.post('/:id/studio/cancel', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.cancelQuery(
    c.req.param('id'),
    organizationId,
    userId,
    Number(body?.id),
    locale
  );

  return c.json({
    data: result,
    message: t(locale, 'databases', result.cancelled ? 'studioQueryCancelled' : 'studioQueryGone'),
  });
});

// Slow-query statistics and what is running right now
studioRouter.get('/:id/studio/performance', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const result = await databaseStudioService.getPerformance(
    c.req.param('id'),
    organizationId,
    userId,
    locale
  );

  return c.json({ data: result });
});

// ============ Schema (DDL) ============

// Create a table
studioRouter.post('/:id/studio/tables', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.createTable(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioTableCreated') }, 201);
});

// Drop a table or view
studioRouter.delete('/:id/studio/tables', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const query = c.req.query();

  if (!query.table) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'table is required' } }, 400);
  }

  const result = await databaseStudioService.dropTable(
    c.req.param('id'),
    organizationId,
    userId,
    { schema: query.schema, table: query.table },
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioTableDropped') });
});

// Empty a table
studioRouter.post('/:id/studio/tables/truncate', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.truncateTable(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioTableTruncated') });
});

// Rename a table
studioRouter.post('/:id/studio/tables/rename', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.renameTable(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioTableRenamed') });
});

// Add a column
studioRouter.post('/:id/studio/columns', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const result = await databaseStudioService.addColumn(
    c.req.param('id'),
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioColumnAdded') }, 201);
});

// Drop a column
studioRouter.delete('/:id/studio/columns', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const query = c.req.query();

  if (!query.table || !query.column) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'table and column are required' } }, 400);
  }

  const result = await databaseStudioService.dropColumn(
    c.req.param('id'),
    organizationId,
    userId,
    { schema: query.schema, table: query.table, column: query.column },
    locale
  );

  return c.json({ data: result, message: t(locale, 'databases', 'studioColumnDropped') });
});

export { studioRouter as databaseStudioRoutes };
