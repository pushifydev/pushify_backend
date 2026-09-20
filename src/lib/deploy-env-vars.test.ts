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
