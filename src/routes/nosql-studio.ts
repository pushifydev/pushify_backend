import { Hono } from 'hono';
import { nosqlStudioService } from '../services/nosql-studio.service';
import { requireScope } from '../middleware/apikey-auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

/**
 * Data browser for managed MongoDB and Redis databases. Mounted inside databasesRouter, so the
 * auth middleware there already applies; the service does the owner/admin check on top of that.
 */
const nosqlRouter = new Hono<AppEnv>();

// ============ MongoDB ============

nosqlRouter.get('/:id/studio/mongo/collections', requireScope('databases:read'), async (c) => {
  const locale = c.get('locale');
  const result = await nosqlStudioService.listCollections(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    locale
  );
  return c.json({ data: result });
});

nosqlRouter.post('/:id/studio/mongo/collections', requireScope('databases:write'), async (c) => {
  const locale = c.get('locale');
  const body = await c.req.json();
  const result = await nosqlStudioService.createCollection(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    body?.name,
    locale
  );
  return c.json({ data: result, message: t(locale, 'databases', 'studioCollectionCreated') }, 201);
});

nosqlRouter.delete('/:id/studio/mongo/collections', requireScope('databases:write'), async (c) => {
  const locale = c.get('locale');
  const name = c.req.query('name');

  if (!name) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'name is required' } }, 400);
  }

  const result = await nosqlStudioService.dropCollection(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    name,
    locale
  );
  return c.json({ data: result, message: t(locale, 'databases', 'studioCollectionDropped') });
});

nosqlRouter.get('/:id/studio/mongo/documents', requireScope('databases:read'), async (c) => {
  const locale = c.get('locale');
  const query = c.req.query();

  if (!query.collection) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'collection is required' } }, 400);
  }

  const result = await nosqlStudioService.getDocuments(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    {
      collection: query.collection,
      filter: query.filter,
      sort: query.sort,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    },
    locale
  );
  return c.json({ data: result });
});

nosqlRouter.post('/:id/studio/mongo/documents', requireScope('databases:write'), async (c) => {
  const locale = c.get('locale');
  const body = await c.req.json();
  const result = await nosqlStudioService.insertDocument(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    body,
    locale
  );
  return c.json({ data: result, message: t(locale, 'databases', 'studioDocumentInserted') }, 201);
});

nosqlRouter.patch('/:id/studio/mongo/documents', requireScope('databases:write'), async (c) => {
  const locale = c.get('locale');
  const body = await c.req.json();
  const result = await nosqlStudioService.replaceDocument(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    body,
    locale
  );
  return c.json({ data: result, message: t(locale, 'databases', 'studioDocumentUpdated') });
});

// POST because the payload carries the id list
nosqlRouter.post('/:id/studio/mongo/documents/delete', requireScope('databases:write'), async (c) => {
  const locale = c.get('locale');
  const body = await c.req.json();
  const result = await nosqlStudioService.deleteDocuments(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    body,
    locale
  );
  return c.json({ data: result, message: t(locale, 'databases', 'studioDocumentsDeleted') });
});

// ============ Redis ============

nosqlRouter.get('/:id/studio/redis/keys', requireScope('databases:read'), async (c) => {
  const locale = c.get('locale');
  const query = c.req.query();

  const result = await nosqlStudioService.scanKeys(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    {
      cursor: query.cursor,
      pattern: query.pattern,
      count: query.count ? Number(query.count) : undefined,
    },
    locale
  );
  return c.json({ data: result });
});

nosqlRouter.get('/:id/studio/redis/key', requireScope('databases:read'), async (c) => {
  const locale = c.get('locale');
  const key = c.req.query('key');

  if (!key) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'key is required' } }, 400);
  }

  const result = await nosqlStudioService.getKey(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    { key },
    locale
  );
  return c.json({ data: result });
});

nosqlRouter.post('/:id/studio/redis/keys/delete', requireScope('databases:write'), async (c) => {
  const locale = c.get('locale');
  const body = await c.req.json();
  const result = await nosqlStudioService.deleteKeys(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    body?.keys ?? [],
    locale
  );
  return c.json({ data: result, message: t(locale, 'databases', 'studioKeysDeleted') });
});

nosqlRouter.post('/:id/studio/redis/key/expire', requireScope('databases:write'), async (c) => {
  const locale = c.get('locale');
  const body = await c.req.json();
  const result = await nosqlStudioService.setExpiry(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    body,
    locale
  );
  return c.json({ data: result, message: t(locale, 'databases', 'studioTtlUpdated') });
});

nosqlRouter.post('/:id/studio/redis/key/value', requireScope('databases:write'), async (c) => {
  const locale = c.get('locale');
  const body = await c.req.json();
  const result = await nosqlStudioService.setStringValue(
    c.req.param('id'),
    c.get('organizationId')!,
    c.get('userId')!,
    body,
    locale
  );
  return c.json({ data: result, message: t(locale, 'databases', 'studioValueUpdated') });
});

export { nosqlRouter as nosqlStudioRoutes };
