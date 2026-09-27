import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { combinedAuthMiddleware } from '../middleware/auth';
import { requireScope } from '../middleware/apikey-auth';
import { staticUploadService } from '../services/static-upload.service';
import {
  collectSiteFiles,
  entriesFromZip,
  StaticUploadError,
  STATIC_UPLOAD_LIMITS,
  type SiteFile,
} from '../lib/static-upload';
import type { AppEnv } from '../types';

/**
 * Uploaded static sites: `POST /static-sites` creates a project from files, and
 * `POST /static-sites/:projectId/versions` publishes new files to it.
 *
 * Multipart body: either one `.zip` in `file`, or many `files` whose filename is the path inside
 * the site (`css/site.css`) — what a browser sends for a dropped folder, and what the CLI sends.
 */
const staticSitesRouter = new Hono<AppEnv>();

staticSitesRouter.use('*', combinedAuthMiddleware);
staticSitesRouter.use('*', requireScope('projects:write'));

async function readSiteFiles(body: Record<string, unknown>): Promise<SiteFile[]> {
  const asList = (v: unknown): File[] => (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is File => x instanceof File);
  const zip = asList(body.file)[0];
  const files = asList(body.files ?? body['files[]']);

  // Checked before reading anything into memory.
  const declared = [zip, ...files].reduce((sum, f) => sum + (f?.size ?? 0), 0);
  if (declared > STATIC_UPLOAD_LIMITS.maxTotalBytes) {
    throw new StaticUploadError('TOO_LARGE', 'A site can be at most 50 MB');
  }

  if (zip) {
    if (!/\.zip$/i.test(zip.name)) throw new StaticUploadError('BAD_ZIP', 'Upload a .zip file, or the files of a folder');
    return collectSiteFiles(entriesFromZip(new Uint8Array(await zip.arrayBuffer())));
  }
  const entries = [];
  for (const f of files) entries.push({ path: f.name, content: new Uint8Array(await f.arrayBuffer()) });
  return collectSiteFiles(entries);
}

async function parseUpload(c: Context<AppEnv>) {
  const body = await c.req.parseBody({ all: true });
  try {
    return { body, files: await readSiteFiles(body) };
  } catch (err) {
    if (err instanceof StaticUploadError) {
      throw new HTTPException(400, { message: err.message, cause: err.code });
    }
    throw err;
  }
}

staticSitesRouter.post('/', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const { body, files } = await parseUpload(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) throw new HTTPException(400, { message: 'A site name (up to 100 characters) is required' });
  const serverId = typeof body.serverId === 'string' && body.serverId ? body.serverId : undefined;

  const result = await staticUploadService.createProject(organizationId, userId, { name, serverId }, files, locale);
  return c.json(
    {
      data: {
        project: { id: result.project.id, name: result.project.name, slug: result.project.slug },
        deployment: { id: result.deployment.id, status: result.deployment.status },
        fileCount: result.fileCount,
        sizeBytes: result.sizeBytes,
      },
    },
    201,
  );
});

staticSitesRouter.post('/:projectId/versions', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const { files } = await parseUpload(c);
  const result = await staticUploadService.uploadVersion(projectId, organizationId, userId, files, locale);
  return c.json(
    {
      data: {
        deployment: { id: result.deployment.id, status: result.deployment.status },
        fileCount: result.fileCount,
        sizeBytes: result.sizeBytes,
      },
    },
    201,
  );
});

export { staticSitesRouter as staticSiteRoutes };
