import { describe, it, expect } from 'vitest';
import { diffChanges, redactValue, auditSource, sanitizeChanges } from './audit';

describe('diffChanges', () => {
  it('records only fields that changed, as from -> to', () => {
    expect(diffChanges({ a: 1, b: 'x', c: true }, { a: 2, b: 'x', c: true })).toEqual({ a: { from: 1, to: 2 } });
  });

  it('limits the diff to the requested fields', () => {
    expect(diffChanges({ a: 1, b: 1 }, { a: 2, b: 2 }, { fields: ['b'] })).toEqual({ b: { from: 1, to: 2 } });
  });

  it('treats missing values as null and compares nested objects by value', () => {
    expect(diffChanges({}, { x: 'y' })).toEqual({ x: { from: null, to: 'y' } });
    expect(diffChanges({ o: { k: [1, 2] } }, { o: { k: [1, 2] } })).toEqual({});
  });

  it('never writes secret values: only { changed: true }', () => {
    const changes = diffChanges(
      { webhookSecret: 'old-s3cret', apiToken: 'tok-1', value: 'plain-old' },
      { webhookSecret: 'new-s3cret', apiToken: 'tok-2', value: 'plain-new' },
      { secretFields: ['value'] }
    );
    expect(changes).toEqual({
      webhookSecret: { changed: true },
      apiToken: { changed: true },
      value: { changed: true },
    });
    const text = JSON.stringify(changes);
    for (const s of ['old-s3cret', 'new-s3cret', 'tok-1', 'tok-2', 'plain-old', 'plain-new']) {
      expect(text).not.toContain(s);
    }
  });

  it('redacts nested secrets and URL credentials in ordinary fields', () => {
    const changes = diffChanges(
      { gitRepoUrl: 'https://github.com/acme/web.git', headers: {} },
      {
        gitRepoUrl: 'https://bot:hidden-pass-1@github.com/acme/web.git',
        headers: { Authorization: 'Bearer hidden-pass-2', Accept: 'json' },
      }
    );
    expect(changes.gitRepoUrl).toEqual({
      from: 'https://github.com/acme/web.git',
      to: 'https://[redacted]@github.com/acme/web.git',
    });
    expect(changes.headers).toEqual({ from: {}, to: { Authorization: '[redacted]', Accept: 'json' } });
    expect(JSON.stringify(changes)).not.toContain('hidden-pass');
  });
});

describe('sanitizeChanges', () => {
  it('collapses secret-named fields to { changed: true } but keeps boolean flags', () => {
    expect(
      sanitizeChanges({
        webhookSecret: { from: 'a-value', to: 'b-value' },
        isSecret: { from: false, to: true },
        port: { from: 80, to: 81 },
      })
    ).toEqual({
      webhookSecret: { changed: true },
      isSecret: { from: false, to: true },
      port: { from: 80, to: 81 },
    });
  });

  it('returns null for an empty or missing diff', () => {
    expect(sanitizeChanges({})).toBeNull();
    expect(sanitizeChanges(undefined)).toBeNull();
  });
});

describe('redactValue', () => {
  it('keeps non-sensitive data intact', () => {
    expect(redactValue({ port: 3000, branch: 'main', list: ['a'] })).toEqual({ port: 3000, branch: 'main', list: ['a'] });
  });
});

describe('auditSource', () => {
  const ctx = (vars: Record<string, unknown>) => ({ get: (k: string) => vars[k] }) as never;
  it('is api for API key callers and ui otherwise', () => {
    expect(auditSource(ctx({ isApiKeyAuth: true }))).toBe('api');
    expect(auditSource(ctx({}))).toBe('ui');
  });
});
