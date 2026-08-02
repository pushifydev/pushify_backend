import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { projectSiteEditor } from '../db/schema/site-editor';
import { organizationRepository } from '../repositories/organization.repository';
import { encrypt } from '../lib/encryption';
import { getCmsBridgeUrls } from '../lib/cms-bridge-urls';
import { renderSiteHtml, renderSiteFiles } from '../lib/site-html-renderer';
import { publishSiteFilesToServer, getProjectProductionUrl } from '../lib/site-editor-publish';
import { syncToHeadlessCms } from '../lib/cms-sync';
import { defaultBlocksForTemplate, defaultThemeForTemplate } from '../sites/default-blocks';
import { getDesignByKey, listDesigns } from '../sites/site-templates';
import type { SiteBlock, SiteSeo, CmsConfig, CmsMode, SitePage } from '../sites/block-types';
import { normalizeSiteTheme, type SiteTheme } from '../sites/theme';
import type { SiteStudioStack } from '../sites/types';
import { t, type SupportedLocale } from '../i18n';
import { assertMemberProjectScope } from '../lib/member-project-scope';

function isSiteStudioProject(settings: Record<string, unknown>): boolean {
  return typeof settings.siteStudioTemplateId === 'string';
}

function redactCmsConfig(cms: CmsConfig): CmsConfig {
  return {
    ...cms,
    apiToken: undefined,
    hasApiToken: Boolean(cms.apiToken),
  };
}

/** Pages for a row, falling back to a single home page built from the legacy blocks/seo. */
function ensurePages(row: { pages: SitePage[]; blocks: SiteBlock[]; seo: SiteSeo }): SitePage[] {
  if (Array.isArray(row.pages) && row.pages.length > 0) return row.pages;
  return [{ id: randomUUID(), title: 'Home', slug: '', blocks: row.blocks, seo: row.seo }];
}

export const siteEditorService = {
  async assertProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
  ) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project || project.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    await assertMemberProjectScope(membership, organizationId, userId, projectId, locale);

    const settings = (project.settings || {}) as Record<string, unknown>;
    if (!isSiteStudioProject(settings)) {
      throw new HTTPException(400, {
        message: 'Site Editor is only available for Site Studio projects',
      });
    }

    return { project, settings };
  },

  async initializeForProject(
    projectId: string,
    siteTemplateId: string,
    siteName: string,
    seo?: Partial<SiteSeo>,
  ): Promise<void> {
    const existing = await db.query.projectSiteEditor.findFirst({
      where: eq(projectSiteEditor.projectId, projectId),
    });
    if (existing) return;

    const blocks = defaultBlocksForTemplate(siteTemplateId, siteName);
    const theme = normalizeSiteTheme(defaultThemeForTemplate(siteTemplateId));
    const seoValue: SiteSeo = {
      title: seo?.title ?? siteName,
      description: seo?.description ?? '',
      ogImage: seo?.ogImage ?? '',
      keywords: seo?.keywords ?? '',
    };
    await db.insert(projectSiteEditor).values({
      projectId,
      seo: seoValue,
      blocks,
      theme,
      pages: [{ id: randomUUID(), title: 'Home', slug: '', blocks, seo: seoValue }],
      cmsConfig: { mode: 'builtin' },
    });
  },

  async getEditorState(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
  ) {
    const { project, settings } = await this.assertProjectAccess(
      projectId,
      organizationId,
      userId,
      locale,
    );

    let row = await db.query.projectSiteEditor.findFirst({
      where: eq(projectSiteEditor.projectId, projectId),
    });

    if (!row) {
      await this.initializeForProject(
        projectId,
        String(settings.siteStudioTemplateId),
        project.name,
      );
      row = await db.query.projectSiteEditor.findFirst({
        where: eq(projectSiteEditor.projectId, projectId),
      });
    }

    const baseUrl = await getProjectProductionUrl(projectId);
    const stack = settings.siteStudioStack as SiteStudioStack | undefined;
    const cmsBridge = getCmsBridgeUrls(stack, baseUrl);

    return {
      projectId,
      siteName: project.name,
      siteTemplateId: settings.siteStudioTemplateId as string,
      stack: stack ?? null,
      seo: row!.seo,
      blocks: row!.blocks,
      pages: ensurePages(row!),
      theme: normalizeSiteTheme(row!.theme),
      cmsConfig: redactCmsConfig(row!.cmsConfig),
      publishedAt: row!.publishedAt,
      hasPublishedHtml: Boolean(row!.publishedHtml),
      cmsBridge,
      previewUrl: baseUrl ? `${baseUrl.replace(/\/$/, '')}/pushify-site/` : null,
      pushifyPreviewPath: `/api/v1/projects/${projectId}/site-editor/preview`,
    };
  },

  async updateSeo(
    projectId: string,
    organizationId: string,
    userId: string,
    seo: Partial<SiteSeo>,
    locale: SupportedLocale,
  ) {
    await this.assertProjectAccess(projectId, organizationId, userId, locale);

    const [row] = await db
      .select()
      .from(projectSiteEditor)
      .where(eq(projectSiteEditor.projectId, projectId))
      .limit(1);

    if (!row) {
      throw new HTTPException(404, { message: 'Site editor not initialized' });
    }

    const next: SiteSeo = { ...row.seo, ...seo };
    await db
      .update(projectSiteEditor)
      .set({ seo: next, updatedAt: new Date() })
      .where(eq(projectSiteEditor.projectId, projectId));

    return { seo: next };
  },

  async updateBlocks(
    projectId: string,
    organizationId: string,
    userId: string,
    blocks: SiteBlock[],
    locale: SupportedLocale,
  ) {
    await this.assertProjectAccess(projectId, organizationId, userId, locale);

    await db
      .update(projectSiteEditor)
      .set({ blocks, updatedAt: new Date() })
      .where(eq(projectSiteEditor.projectId, projectId));

    return { blocks };
  },

  /** Replace the full page list. pages[0] is the home page (mirrored to blocks/seo). */
  async updatePages(
    projectId: string,
    organizationId: string,
    userId: string,
    pages: SitePage[],
    locale: SupportedLocale,
  ) {
    await this.assertProjectAccess(projectId, organizationId, userId, locale);

    if (!Array.isArray(pages) || pages.length === 0) {
      throw new HTTPException(400, { message: 'At least one page is required' });
    }

    const home = pages[0];
    await db
      .update(projectSiteEditor)
      .set({ pages, blocks: home.blocks, seo: home.seo, updatedAt: new Date() })
      .where(eq(projectSiteEditor.projectId, projectId));

    return { pages };
  },

  async updateTheme(
    projectId: string,
    organizationId: string,
    userId: string,
    theme: Partial<SiteTheme>,
    locale: SupportedLocale,
  ) {
    await this.assertProjectAccess(projectId, organizationId, userId, locale);

    const [row] = await db
      .select()
      .from(projectSiteEditor)
      .where(eq(projectSiteEditor.projectId, projectId))
      .limit(1);

    if (!row) {
      throw new HTTPException(404, { message: 'Site editor not initialized' });
    }

    const next = normalizeSiteTheme({ ...row.theme, ...theme });
    await db
      .update(projectSiteEditor)
      .set({ theme: next, updatedAt: new Date() })
      .where(eq(projectSiteEditor.projectId, projectId));

    return { theme: next };
  },

  /** List the design templates available to apply in the editor. */
  async getDesigns(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
  ) {
    await this.assertProjectAccess(projectId, organizationId, userId, locale);
    return listDesigns();
  },

  /**
   * Replace the project's blocks + theme with a chosen design template (start fresh from a
   * design). Returns the new blocks and theme.
   */
  async applyTemplate(
    projectId: string,
    organizationId: string,
    userId: string,
    designKey: string,
    locale: SupportedLocale,
  ) {
    const { project } = await this.assertProjectAccess(projectId, organizationId, userId, locale);

    const design = getDesignByKey(designKey);
    if (!design) {
      throw new HTTPException(400, { message: `Unknown design: ${designKey}` });
    }

    const [row] = await db
      .select()
      .from(projectSiteEditor)
      .where(eq(projectSiteEditor.projectId, projectId))
      .limit(1);
    if (!row) {
      throw new HTTPException(404, { message: 'Site editor not initialized' });
    }

    const blocks = design.blocks(project.name);
    const theme = normalizeSiteTheme(design.theme);

    await db
      .update(projectSiteEditor)
      .set({ blocks, theme, updatedAt: new Date() })
      .where(eq(projectSiteEditor.projectId, projectId));

    return { blocks, theme };
  },

  async updateCmsConfig(
    projectId: string,
    organizationId: string,
    userId: string,
    input: { mode: CmsMode; apiUrl?: string; apiToken?: string; collection?: string },
    locale: SupportedLocale,
  ) {
    await this.assertProjectAccess(projectId, organizationId, userId, locale);

    const [row] = await db
      .select()
      .from(projectSiteEditor)
      .where(eq(projectSiteEditor.projectId, projectId))
      .limit(1);

    if (!row) {
      throw new HTTPException(404, { message: 'Site editor not initialized' });
    }

    const next: CmsConfig = {
      mode: input.mode,
      apiUrl: input.apiUrl?.trim() || undefined,
      collection: input.collection?.trim() || undefined,
      apiToken: input.apiToken?.trim()
        ? encrypt(input.apiToken.trim())
        : row.cmsConfig.apiToken,
    };

    await db
      .update(projectSiteEditor)
      .set({ cmsConfig: next, updatedAt: new Date() })
      .where(eq(projectSiteEditor.projectId, projectId));

    return { cmsConfig: redactCmsConfig(next) };
  },

  async publish(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
  ) {
    const { project, settings } = await this.assertProjectAccess(
      projectId,
      organizationId,
      userId,
      locale,
    );

    const isStatic = settings.siteStudioStack === 'static' || settings.static === true;

    const [row] = await db
      .select()
      .from(projectSiteEditor)
      .where(eq(projectSiteEditor.projectId, projectId))
      .limit(1);

    if (!row) {
      throw new HTTPException(404, { message: 'Site editor not initialized' });
    }

    const pages = ensurePages(row);
    const home = pages[0];

    // Static sites are served at the domain root and support multiple pages with a nav.
    // CMS-attached block sites live under /pushify-site/ and publish the home page only.
    const files = isStatic
      ? renderSiteFiles(pages, project.name, row.theme)
      : [{ path: 'index.html', html: renderSiteHtml(home.seo, home.blocks, project.name, row.theme) }];

    const cmsSync = await syncToHeadlessCms(row.cmsConfig, home.seo, home.blocks);
    const sshResult = await publishSiteFilesToServer(
      projectId,
      project.slug,
      project.serverId,
      files,
    );

    await db
      .update(projectSiteEditor)
      .set({
        publishedHtml: files[0]?.html ?? '',
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectSiteEditor.projectId, projectId));

    const baseUrl = await getProjectProductionUrl(projectId);

    return {
      publishedAt: new Date(),
      cmsSync,
      sshPublish: sshResult,
      // Static sites are served at the domain root; CMS-attached sites live under /pushify-site/.
      liveUrl: isStatic
        ? (baseUrl ? baseUrl.replace(/\/$/, '') : null)
        : sshResult && baseUrl
          ? `${baseUrl.replace(/\/$/, '')}${sshResult.publicPath}`
          : null,
    };
  },

  async getPreviewHtml(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
    usePublished = false,
  ): Promise<string> {
    const { project } = await this.assertProjectAccess(
      projectId,
      organizationId,
      userId,
      locale,
    );

    const [row] = await db
      .select()
      .from(projectSiteEditor)
      .where(eq(projectSiteEditor.projectId, projectId))
      .limit(1);

    if (!row) {
      return renderSiteHtml(
        { title: project.name, description: '', ogImage: '', keywords: '' },
        defaultBlocksForTemplate(),
        project.name,
      );
    }

    if (usePublished && row.publishedHtml) {
      return row.publishedHtml;
    }

    return renderSiteHtml(row.seo, row.blocks, project.name, row.theme);
  },
};
