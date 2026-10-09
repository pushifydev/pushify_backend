import { defineWorkspace } from 'vitest/config';

/**
 * Two groups. Unit tests run in parallel. Tests against a real Postgres (`*.db.test.ts`, skipped
 * unless ACCOUNT_DELETION_TEST_DATABASE_URL is set) share one database and some sweep it
 * globally — the deletion purge takes every organization that is due — so they run one file at a
 * time: in parallel, one file's rows showed up in another's sweep and tests failed at random.
 */
const shared = { environment: 'node' as const, setupFiles: ['./vitest.setup.ts'] };

export default defineWorkspace([
  {
    test: { ...shared, name: 'unit', include: ['src/**/*.test.ts'], exclude: ['src/**/*.db.test.ts', 'node_modules/**'] },
  },
  {
    test: { ...shared, name: 'db', include: ['src/**/*.db.test.ts'], fileParallelism: false, maxWorkers: 1, minWorkers: 1 },
  },
]);
