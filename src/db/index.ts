import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import * as schema from './schema';

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_POOL_CONNECTION_TIMEOUT_MS,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

logger.info(
  {
    max: env.PG_POOL_MAX,
    role: env.PROCESS_ROLE,
  },
  'PostgreSQL pool initialized',
);

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}
