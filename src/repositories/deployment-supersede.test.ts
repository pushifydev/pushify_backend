import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/** deploymentRepository.cancelSuperseded: which rows the UPDATE may touch, read from its WHERE. */

const h = vi.hoisted(() => ({ set: null as Record<string, unknown> | null, where: null as unknown, updates: 0 }));

vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        h.set = values;
        return {
          where: (condition: unknown) => {
            h.where = condition;
            h.updates++;
            return { returning: async () => [{ id: 'dep-old', commitHash: 'aaa' }] };
          },
        };
      },
    }),
  },
}));

const { deploymentRepository } = await import('./deployment.repository');

const dialect = new PgDialect();
const whereClause = () => dialect.sqlToQuery(h.where as SQL);

const newer = {
  id: 'dep-new',
  projectId: 'proj-1',
  createdAt: new Date('2026-11-10T10:00:00Z'),
  environment: 'production',
  branch: 'main',
  isPreview: false,
  previewPrNumber: null,
};

beforeEach(() => {
  h.set = null;
  h.where = null;
  h.updates = 0;
});

describe('deploymentRepository.cancelSuperseded', () => {
  it('only older git_push deploys of the same project, branch and environment, in the given statuses', async () => {
    const rows = await deploymentRepository.cancelSuperseded(newer, ['pending'], '[Superseded] …');

    expect(rows).toEqual([{ id: 'dep-old', commitHash: 'aaa' }]);
    expect(h.set).toMatchObject({ status: 'cancelled', errorMessage: '[Superseded] …' });
    const { sql, params } = whereClause();
    expect(sql).toContain('"deployments"."trigger" = $');
    expect(sql).toContain('"deployments"."id" <> $');
    expect(sql).toContain('"deployments"."created_at" < $');
    expect(sql).toContain('"deployments"."status" in ($');
    expect(sql).toContain('"deployments"."branch" = $');
    expect(sql).toContain('"deployments"."environment" = $');
    expect(params).toEqual(expect.arrayContaining(['proj-1', 'git_push', 'dep-new', 'pending', false, 'production', 'main']));
    // manual, redeploy and rollback deploys, and a deploy already switching containers, are never matched
    for (const value of ['manual', 'redeploy', 'rollback', 'deploying', 'building']) {
      expect(params).not.toContain(value);
    }
  });

  it('building deploys only when asked for', async () => {
    await deploymentRepository.cancelSuperseded(newer, ['pending', 'building'], 'x');
    expect(whereClause().params).toEqual(expect.arrayContaining(['pending', 'building']));
    expect(whereClause().params).not.toContain('deploying');
  });

  it('a preview deploy matches the same PR only', async () => {
    await deploymentRepository.cancelSuperseded(
      { ...newer, branch: 'feature/x', isPreview: true, previewPrNumber: 7 },
      ['pending'],
      'x'
    );
    const { sql, params } = whereClause();
    expect(sql).toContain('"deployments"."preview_pr_number" = $');
    expect(sql).not.toContain('"deployments"."branch"');
    expect(params).toEqual(expect.arrayContaining([true, 7]));
  });

  it('touches nothing when the lane is unknown', async () => {
    expect(await deploymentRepository.cancelSuperseded({ ...newer, branch: null }, ['pending'], 'x')).toEqual([]);
    expect(
      await deploymentRepository.cancelSuperseded({ ...newer, isPreview: true, previewPrNumber: null }, ['pending'], 'x')
    ).toEqual([]);
    expect(await deploymentRepository.cancelSuperseded(newer, [], 'x')).toEqual([]);
    expect(h.updates).toBe(0);
  });
});
