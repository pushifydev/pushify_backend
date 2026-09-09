/**
 * Export the public face of the marketplace templates for the website's /apps pages.
 *
 *   npm run marketplace:export            # writes ../pushify_frontend/content/apps/templates.json
 *   MARKETPLACE_EXPORT_PATH=… npm run marketplace:export
 *
 * The site is fully static, so it reads this snapshot at build instead of the API.
 * Re-run whenever a template is added or its copy changes. Secrets never leave:
 * hidden env vars are dropped and defaults of password-type vars are omitted.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import { templates } from '../src/marketplace/templates';

const out =
  process.env.MARKETPLACE_EXPORT_PATH ||
  path.resolve(here, '../../pushify_frontend/content/apps/templates.json');

const publicTemplates = templates.map((t) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  longDescription: t.longDescription,
  icon: t.icon,
  category: t.category,
  tags: t.tags,
  website: t.website,
  documentation: t.documentation,
  deploymentType: t.deploymentType ?? 'single-container',
  dockerImage: t.dockerImage ?? null,
  port: t.port,
  healthCheckPath: t.healthCheckPath,
  minMemoryMb: t.minMemoryMb,
  minDiskGb: t.minDiskGb,
  requiresDatabase: t.requiresDatabase ?? null,
  appVersion: t.appVersion,
  featured: t.featured,
  envVars: (t.envVars ?? [])
    .filter((v) => !v.hidden)
    .map((v) => ({
      key: v.key,
      label: v.label,
      description: v.description,
      required: v.required,
      type: v.type,
      default: v.type === 'password' || v.generate ? undefined : v.default,
      generated: !!v.generate,
    })),
}));

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), templates: publicTemplates }, null, 2));
console.log(`Exported ${publicTemplates.length} templates → ${out}`);
