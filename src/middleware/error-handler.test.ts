import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { errorHandler } from './error-handler';

function appThrowing(err: Error) {
  const app = new Hono();
  app.onError(errorHandler);
  app.get('/', () => {
    throw err;
  });
  return app;
}

describe('errorHandler', () => {
  it('uses the code and details a service puts in `cause`', async () => {
    const res = await appThrowing(
      new HTTPException(403, { message: 'pending', cause: { code: 'ACCOUNT_PENDING_DELETION', details: { restoreToken: 'x' } } }),
    ).request('/');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'ACCOUNT_PENDING_DELETION', message: 'pending', details: { restoreToken: 'x' } },
    });
  });

  it('keeps the status-derived code when `cause` is not an object with a code', async () => {
    const res = await appThrowing(new HTTPException(400, { message: 'bad zip', cause: 'BAD_ZIP' })).request('/');
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(res.status).toBe(400);
    expect(body.error.code).not.toBe('BAD_ZIP');
    expect(body.error.details).toBeUndefined();
  });
});
