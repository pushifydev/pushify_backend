/**
 * One-shot migration runner: applies pending SQL migrations from src/db/migrations and exits.
 * Used by the self-host Docker stack as an init step (`node dist/migrate.js`) before the API
 * starts — deliberately reads only DATABASE_URL instead of the full env schema so it can run
 * without the API's other required secrets being meaningful yet.
 */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// Resolves to <root>/src/db/migrations both from src/ (tsx) and from dist/ (built image,
// where the migrations folder is copied alongside dist).
const migrationsFolder = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log('Migrations applied');
} finally {
  await pool.end();
}
