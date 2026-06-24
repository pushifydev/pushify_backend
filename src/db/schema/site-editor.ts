import { pgTable, uuid, timestamp, text, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';
import type { SiteBlock, SiteSeo, CmsConfig, SitePage } from '../../sites/block-types';
import type { SiteTheme } from '../../sites/theme';
import { DEFAULT_SITE_THEME } from '../../sites/theme';

export const projectSiteEditor = pgTable('project_site_editor', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  seo: jsonb('seo').$type<SiteSeo>().default({ title: '', description: '', ogImage: '', keywords: '' }).notNull(),
  blocks: jsonb('blocks').$type<SiteBlock[]>().default([]).notNull(),
  // Multi-page sites: the full list of pages. blocks/seo above mirror the home page (pages[0])
  // for backward compatibility with single-page render paths.
  pages: jsonb('pages').$type<SitePage[]>().default([]).notNull(),
  cmsConfig: jsonb('cms_config').$type<CmsConfig>().default({ mode: 'builtin' }).notNull(),
  theme: jsonb('theme').$type<SiteTheme>().default(DEFAULT_SITE_THEME).notNull(),
  publishedHtml: text('published_html'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const projectSiteEditorRelations = relations(projectSiteEditor, ({ one }) => ({
  project: one(projects, {
    fields: [projectSiteEditor.projectId],
    references: [projects.id],
  }),
}));
