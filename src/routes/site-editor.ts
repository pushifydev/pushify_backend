import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { siteEditorService } from '../services/site-editor.service';
import type { AppEnv } from '../types';
import type { SiteBlock, SiteSeo, CmsMode } from '../sites/block-types';
import type { SiteTheme } from '../sites/theme';
import { uploadSiteEditorImage } from '../lib/site-editor-assets';

const siteEditorRouter = new Hono<AppEnv>();

siteEditorRouter.use('*', authMiddleware);

siteEditorRouter.get('/:projectId/site-editor', async (c) => {
  const projectId = c.req.param('projectId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const data = await siteEditorService.getEditorState(
    projectId,
    organizationId,
    userId,
    locale,
  );

  return c.json({ data });
});

siteEditorRouter.get('/:projectId/site-editor/preview', async (c) => {
  const projectId = c.req.param('projectId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const published = c.req.query('published') === '1';

  const html = await siteEditorService.getPreviewHtml(
    projectId,
    organizationId,
    userId,
    locale,
    published,
  );

  return c.html(html);
});

siteEditorRouter.patch('/:projectId/site-editor/seo', async (c) => {
  const projectId = c.req.param('projectId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const body = await c.req.json<Partial<SiteSeo>>();

  const data = await siteEditorService.updateSeo(
    projectId,
    organizationId,
    userId,
    body,
    locale,
  );

  return c.json({ data });
});

siteEditorRouter.patch('/:projectId/site-editor/theme', async (c) => {
  const projectId = c.req.param('projectId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const body = await c.req.json<Partial<SiteTheme>>();

  const data = await siteEditorService.updateTheme(
    projectId,
    organizationId,
    userId,
    body,
    locale,
  );

  return c.json({ data });
});

siteEditorRouter.put('/:projectId/site-editor/blocks', async (c) => {
  const projectId = c.req.param('projectId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const body = await c.req.json<{ blocks: SiteBlock[] }>();

  if (!Array.isArray(body.blocks)) {
    return c.json({ error: { message: 'blocks array required' } }, 400);
  }

  const data = await siteEditorService.updateBlocks(
    projectId,
    organizationId,
    userId,
    body.blocks,
    locale,
  );

  return c.json({ data });
});

siteEditorRouter.put('/:projectId/site-editor/cms', async (c) => {
  const projectId = c.req.param('projectId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const body = await c.req.json<{
    mode: CmsMode;
    apiUrl?: string;
    apiToken?: string;
    collection?: string;
  }>();

  const data = await siteEditorService.updateCmsConfig(
    projectId,
    organizationId,
    userId,
    body,
    locale,
  );

  return c.json({ data });
});

siteEditorRouter.post('/:projectId/site-editor/upload', async (c) => {
  const projectId = c.req.param('projectId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  await siteEditorService.assertProjectAccess(projectId, organizationId, userId, locale);

  const body = await c.req.parseBody();
  const file = body.file;

  if (!(file instanceof File)) {
    return c.json({ error: { message: 'file is required' } }, 400);
  }

  try {
    const result = await uploadSiteEditorImage(projectId, file);
    const imageUrl = result.url ?? result.dataUrl ?? result.path;
    return c.json({ data: { ...result, imageUrl } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    return c.json({ error: { message } }, 400);
  }
});

siteEditorRouter.post('/:projectId/site-editor/publish', async (c) => {
  const projectId = c.req.param('projectId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const data = await siteEditorService.publish(
    projectId,
    organizationId,
    userId,
    locale,
  );

  return c.json({ data, message: 'Site published' });
});

export { siteEditorRouter as siteEditorRoutes };
