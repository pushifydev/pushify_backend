/**
 * Write the OpenAPI document served at /api/v1/doc to openapi.json at the repository root, so the
 * dashboard can read the backend's endpoint names and schemas without a running API.
 *
 *   npm run openapi:export              # writes ./openapi.json
 *   OPENAPI_EXPORT_PATH=… npm run openapi:export
 *
 * No server is started and nothing connects to Postgres or Redis: the app is only imported and its
 * route table read. src/config/env.ts validates the environment on import, so the required values
 * are fixed fake test values (the ones in vitest.setup.ts) — never real secrets — and .env is not
 * read. The document does not depend on them.
 *
 * Only routes declared with createRoute are in the document; most routes are plain Hono routes
 * and are not (docs/api-contracts.md). Re-run after changing a documented route.
 *
 * Run through `node --import tsx`, not the tsx CLI: the CLI opens a local IPC socket that
 * sandboxed runners refuse (listen EPERM); the loader alone needs none.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.OPENAPI_EXPORT_PATH || path.resolve(here, '../openapi.json');

Object.assign(process.env, {
  // A missing file: env.ts imports dotenv/config, which would otherwise load the local .env.
  DOTENV_CONFIG_PATH: path.resolve(here, '.env.openapi-export-none'),
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/pushify_test',
  JWT_SECRET: 'test-jwt-secret-minimum-32-characters!',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
});
delete process.env.REDIS_URL;

// Dynamic imports: they must run after the environment above is set.
const { app } = await import('../src/app');
const { openApiConfig } = await import('../src/config/openapi');

// The same call app.doc('/api/v1/doc', openApiConfig) makes per request (src/app.ts).
const doc = app.getOpenAPIDocument(openApiConfig);

writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(
  `Exported ${Object.keys(doc.paths ?? {}).length} paths, ${Object.keys(doc.components?.schemas ?? {}).length} schemas → ${out}`
);
// Module-level timers (rate limiter, SSH pool cleanup) would keep the process alive.
process.exit(0);
