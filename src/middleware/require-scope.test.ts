import { describe, it, expect, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import type { Context, Next } from 'hono';

/**
 * The other half of the studio's gate: a request authenticated with an API key only gets through
 * if the key carries the scope the route asks for. The service-level role check (see
 * studio-access.test.ts) runs on top of this.
 *
 * apikey.service is mocked because importing it for real pulls in the database pool.
 */
vi.mock('../services/apikey.service', () => ({
  hasScope: (keyScopes: string, required: string) => {
    if (keyScopes === '*') return true;
    const scopes = keyScopes.split(',').map((scope) => scope.trim());
    return scopes.includes(required) || scopes.includes('*');
  },
}));

import { requireScope, requireScopeByMethod } from './apikey-auth';

type Vars = Record<string, unknown>;

const context = (vars: Vars) => ({ get: (key: string) => vars[key] }) as unknown as Context;

async function run(vars: Vars, scope: Parameters<typeof requireScope>[0]) {
  const next = vi.fn(async () => {}) as unknown as Next;
  try {
    await requireScope(scope)(context(vars), next);
    return { status: 'passed', nextCalled: (next as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0 };
  } catch (error) {
    return {
      status: error instanceof HTTPException ? error.status : 'threw',
      nextCalled: (next as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0,
    };
  }
}

describe('requireScope', () => {
  it('does not apply to a session (JWT) request', async () => {
    // Scopes belong to API keys; a dashboard session is gated by the role check instead.
    const result = await run({ locale: 'en', isApiKeyAuth: false }, 'databases:write');
    expect(result.status).toBe('passed');
    expect(result.nextCalled).toBe(true);
  });

  it('lets a key with the exact scope through', async () => {
    const result = await run(
      { locale: 'en', isApiKeyAuth: true, apiKey: { id: 'k', scopes: 'databases:read,databases:write' } },
      'databases:write'
    );
    expect(result.status).toBe('passed');
    expect(result.nextCalled).toBe(true);
  });

  it('lets a wildcard key through', async () => {
    const result = await run(
      { locale: 'en', isApiKeyAuth: true, apiKey: { id: 'k', scopes: '*' } },
      'databases:write'
    );
    expect(result.status).toBe('passed');
  });

  it('refuses a read-only key on a write route', async () => {
    const result = await run(
      { locale: 'en', isApiKeyAuth: true, apiKey: { id: 'k', scopes: 'databases:read' } },
      'databases:write'
    );
    expect(result.status).toBe(403);
    expect(result.nextCalled).toBe(false);
  });

  it('refuses a key scoped to a different resource', async () => {
    const result = await run(
      { locale: 'en', isApiKeyAuth: true, apiKey: { id: 'k', scopes: 'projects:read,projects:write' } },
      'databases:read'
    );
    expect(result.status).toBe(403);
  });

  it('refuses when the key is missing from the context', async () => {
    const result = await run({ locale: 'en', isApiKeyAuth: true }, 'databases:read');
    expect(result.status).toBe(401);
    expect(result.nextCalled).toBe(false);
  });

  it('refuses a key with write but not delete on a delete scope', async () => {
    const result = await run(
      { locale: 'en', isApiKeyAuth: true, apiKey: { id: 'k', scopes: 'projects:read,projects:write' } },
      'projects:delete'
    );
    expect(result.status).toBe(403);
    expect(result.nextCalled).toBe(false);
  });
});

/**
 * requireScopeByMethod: GET/HEAD need `read`, DELETE needs `del` when given (else `write`), any
 * other method `write`. `write` never stands in for `del`.
 */
describe('requireScopeByMethod', () => {
  async function runMethod(
    method: string,
    scopes: string,
    del?: Parameters<typeof requireScopeByMethod>[2]
  ) {
    const vars: Vars = { locale: 'en', isApiKeyAuth: true, apiKey: { id: 'k', scopes } };
    const c = { get: (key: string) => vars[key], req: { method } } as unknown as Context;
    const next = vi.fn(async () => {}) as unknown as Next;
    try {
      await requireScopeByMethod('projects:read', 'projects:write', del)(c, next);
      return 'passed';
    } catch (error) {
      return error instanceof HTTPException ? error.status : 'threw';
    }
  }

  it('asks DELETE for the delete scope, not write', async () => {
    expect(await runMethod('DELETE', 'projects:read,projects:write', 'projects:delete')).toBe(403);
    expect(await runMethod('DELETE', 'projects:delete', 'projects:delete')).toBe('passed');
    expect(await runMethod('DELETE', '*', 'projects:delete')).toBe('passed');
  });

  it('leaves reads and other writes as they were', async () => {
    expect(await runMethod('GET', 'projects:read', 'projects:delete')).toBe('passed');
    expect(await runMethod('POST', 'projects:write', 'projects:delete')).toBe('passed');
    expect(await runMethod('PATCH', 'projects:delete', 'projects:delete')).toBe(403);
  });

  it('keeps DELETE on write when no delete scope is given', async () => {
    expect(await runMethod('DELETE', 'projects:write')).toBe('passed');
    expect(await runMethod('DELETE', 'projects:read')).toBe(403);
  });

  it('does not apply to a session (JWT) request', async () => {
    const c = { get: (key: string) => ({ locale: 'en', isApiKeyAuth: false } as Vars)[key], req: { method: 'DELETE' } };
    const next = vi.fn(async () => {});
    await requireScopeByMethod('projects:read', 'projects:write', 'projects:delete')(
      c as unknown as Context,
      next as unknown as Next
    );
    expect(next).toHaveBeenCalled();
  });
});
