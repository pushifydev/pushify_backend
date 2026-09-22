import { describe, it, expect } from 'vitest';
import { selectDeployEnvVars } from './deploy-env-vars';

const rows = [
  { key: 'DATABASE_URL', environment: 'production' as const, v: 'prod-db' },
  { key: 'DATABASE_URL', environment: 'preview' as const, v: 'preview-db' },
  { key: 'API_KEY', environment: 'production' as const, v: 'prod-key' },
  { key: 'DEBUG', environment: 'development' as const, v: '1' },
  { key: 'STAGING_ONLY', environment: 'staging' as const, v: 'x' },
  { key: 'PREVIEW_ONLY', environment: 'preview' as const, v: 'p' },
];

const pick = (list: typeof rows) => Object.fromEntries(list.map((r) => [r.key, r.v]));

describe('selectDeployEnvVars', () => {
  it('a production deploy gets production rows only', () => {
    expect(pick(selectDeployEnvVars(rows, { preview: false }))).toEqual({
      DATABASE_URL: 'prod-db',
      API_KEY: 'prod-key',
    });
  });

  it('a preview deploy gets production rows with preview rows layered on top', () => {
    expect(pick(selectDeployEnvVars(rows, { preview: true }))).toEqual({
      DATABASE_URL: 'preview-db',
      API_KEY: 'prod-key',
      PREVIEW_ONLY: 'p',
    });
  });

  it('never injects staging or development rows', () => {
    for (const preview of [false, true]) {
      const keys = selectDeployEnvVars(rows, { preview }).map((r) => r.key);
      expect(keys).not.toContain('DEBUG');
      expect(keys).not.toContain('STAGING_ONLY');
    }
  });

  it('is empty for a project with no variables', () => {
    expect(selectDeployEnvVars([], { preview: true })).toEqual([]);
  });
});

describe('staging deploys', () => {
  const rows = [
    { key: 'DATABASE_URL', environment: 'production' as const },
    { key: 'DATABASE_URL', environment: 'staging' as const },
    { key: 'API_KEY', environment: 'production' as const },
    { key: 'ONLY_DEV', environment: 'development' as const },
    { key: 'ONLY_PREVIEW', environment: 'preview' as const },
  ];

  it('takes production as the base and lets staging rows override it', () => {
    const selected = selectDeployEnvVars(rows, { target: 'staging' });
    expect(selected.find((r) => r.key === 'DATABASE_URL')?.environment).toBe('staging');
    expect(selected.map((r) => r.key).sort()).toEqual(['API_KEY', 'DATABASE_URL']);
  });

  it('keeps production deploys on production rows only', () => {
    const selected = selectDeployEnvVars(rows, { target: 'production' });
    expect(selected.find((r) => r.key === 'DATABASE_URL')?.environment).toBe('production');
    expect(selected.map((r) => r.key).sort()).toEqual(['API_KEY', 'DATABASE_URL']);
  });

  it('still understands the old { preview } form', () => {
    expect(selectDeployEnvVars(rows, { preview: true }).map((r) => r.key).sort()).toEqual([
      'API_KEY',
      'DATABASE_URL',
      'ONLY_PREVIEW',
    ]);
  });
});
