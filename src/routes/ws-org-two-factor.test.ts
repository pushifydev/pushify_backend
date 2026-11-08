import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * Organization-wide 2FA on the WebSocket endpoints that verify the token themselves: `/ws` checks
 * the token's organization, the server terminal and the app shell check the organization that owns
 * the server or project. A member without 2FA gets an `error` frame with ORG_2FA_REQUIRED and the
 * connection is closed (4003) before anything is opened; the refusal goes to the audit log.
 */

const mocks = vi.hoisted(() => ({
  required: vi.fn(),
  hasTwoFactor: vi.fn(),
  denied: vi.fn(),
  addClient: vi.fn(),
  authorizeServer: vi.fn(),
  authorizeProject: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../lib/user-ban', () => ({ isUserBanned: async () => false }));
// Real error frame; only the two database reads and the audit write are replaced
vi.mock('../lib/org-two-factor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/org-two-factor')>()),
  isOrganizationTwoFactorRequired: mocks.required,
  userHasTwoFactorEnabled: mocks.hasTwoFactor,
  recordOrgTwoFactorDenial: mocks.denied,
}));
vi.mock('../lib/ws', () => ({
  wsManager: { addClient: mocks.addClient, removeClient: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), handlePong: vi.fn() },
}));
vi.mock('../lib/server-terminal-auth', () => ({
  authorizeServerTerminalAccess: mocks.authorizeServer,
  authorizeProjectShellAccess: mocks.authorizeProject,
  ServerTerminalAuthError: class ServerTerminalAuthError extends Error {},
}));
vi.mock('../lib/ssh-shell-session', () => ({
  SSHShellSession: class {
    connect = mocks.connect;
    disconnect = vi.fn();
    write = vi.fn();
    resize = vi.fn();
  },
}));

const { createWSRoute } = await import('./ws');
const { createServerTerminalWSRoute, closeAllTerminalSessions } = await import('./server-terminal-ws');
const { i18nMiddleware } = await import('../middleware/i18n');
const { generateAccessToken } = await import('../lib/jwt');

type FakeWs = { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
type Events = { onOpen?: (event: Event, ws: FakeWs) => unknown };

let lastWs: FakeWs;

/** Stands in for @hono/node-ws: runs the route's onOpen against a fake socket, with the real context. */
function fakeUpgrade(createEvents: (c: Context) => Events | Promise<Events>) {
  return async (c: Context) => {
    const events = await createEvents(c);
    lastWs = { send: vi.fn(), close: vi.fn() };
    await events.onOpen?.(new Event('open'), lastWs);
    return c.text('upgraded');
  };
}

function buildApp() {
  const upgrade = fakeUpgrade as unknown as Parameters<typeof createWSRoute>[0];
  const app = new Hono();
  app.use('*', i18nMiddleware);
  const wsApp = createWSRoute(upgrade);
  wsApp.route('/', createServerTerminalWSRoute(upgrade));
  app.route('/api/v1/ws', wsApp);
  return app;
}

async function open(path: string, opts: { org?: string | null; headers?: Record<string, string> } = {}) {
  const token = await generateAccessToken('user-1', opts.org === null ? undefined : (opts.org ?? 'org-1'));
  const sep = path.includes('?') ? '&' : '?';
  await buildApp().request(`${path}${sep}token=${encodeURIComponent(token)}`, { headers: opts.headers });
  return {
    frames: lastWs.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>),
    close: lastWs.close.mock.calls[0] as [number, string] | undefined,
  };
}

const access = (organizationId: string) => ({
  organizationId,
  serverId: 'srv-1',
  host: '192.0.2.10',
  username: 'root',
  privateKey: 'key',
  projectSlug: 'app',
});

beforeEach(() => {
  mocks.required.mockReset().mockResolvedValue(true);
  mocks.hasTwoFactor.mockReset().mockResolvedValue(false);
  mocks.denied.mockReset().mockResolvedValue(undefined);
  mocks.addClient.mockReset();
  mocks.authorizeServer.mockReset().mockResolvedValue(access('org-owner'));
  mocks.authorizeProject.mockReset().mockResolvedValue(access('org-owner'));
  mocks.connect.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  closeAllTerminalSessions();
});

describe('organization-wide 2FA on /ws', () => {
  it('refuses a member without 2FA with ORG_2FA_REQUIRED and closes 4003', async () => {
    const { frames, close } = await open('/api/v1/ws');

    expect(frames).toEqual([
      {
        type: 'error',
        code: 'ORG_2FA_REQUIRED',
        message: 'This organization requires two-factor authentication. Enable it under Settings → Security to continue.',
      },
    ]);
    expect(close).toEqual([4003, 'Forbidden']);
    expect(mocks.addClient).not.toHaveBeenCalled();
    expect(mocks.required).toHaveBeenCalledWith('org-1');
    expect(mocks.hasTwoFactor).toHaveBeenCalledWith('user-1');
  });

  it('writes the refusal to the audit log, without the token', async () => {
    await open('/api/v1/ws', { headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'browser' } });

    expect(mocks.denied).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      accessPath: 'websocket',
      path: '/api/v1/ws',
      ipAddress: '203.0.113.7',
      userAgent: 'browser',
    });
  });

  it('uses the localized message', async () => {
    const { frames } = await open('/api/v1/ws', { headers: { 'Accept-Language': 'tr' } });

    expect(frames[0]).toMatchObject({ code: 'ORG_2FA_REQUIRED', message: expect.stringMatching(/iki adımlı doğrulama/) });
  });

  it('connects a member with 2FA', async () => {
    mocks.hasTwoFactor.mockResolvedValue(true);

    const { frames, close } = await open('/api/v1/ws');

    expect(frames).toEqual([{ type: 'connected', clientId: expect.any(String) }]);
    expect(close).toBeUndefined();
    expect(mocks.addClient).toHaveBeenCalledTimes(1);
    expect(mocks.denied).not.toHaveBeenCalled();
  });

  it('connects anyone while the organization does not require it', async () => {
    mocks.required.mockResolvedValue(false);

    const { frames } = await open('/api/v1/ws');

    expect(frames[0]).toMatchObject({ type: 'connected' });
    expect(mocks.hasTwoFactor).not.toHaveBeenCalled();
  });

  it('does not check a token without an organization', async () => {
    const { frames } = await open('/api/v1/ws', { org: null });

    expect(frames[0]).toMatchObject({ type: 'connected' });
    expect(mocks.required).not.toHaveBeenCalled();
  });
});

describe('organization-wide 2FA on the server terminal', () => {
  it("refuses before SSH, by the server's organization, and audits it", async () => {
    const { frames, close } = await open('/api/v1/ws/servers/srv-1/terminal');

    expect(frames).toEqual([expect.objectContaining({ type: 'error', code: 'ORG_2FA_REQUIRED' })]);
    expect(close).toEqual([4003, 'Terminal unavailable']);
    expect(mocks.connect).not.toHaveBeenCalled();
    // The organization that owns the server, not the one the token was issued for
    expect(mocks.required).toHaveBeenCalledWith('org-owner');
    expect(mocks.denied).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-owner',
        userId: 'user-1',
        accessPath: 'server_terminal',
        serverId: 'srv-1',
        path: '/api/v1/ws/servers/srv-1/terminal',
      }),
    );
  });

  it('opens the terminal for a member with 2FA', async () => {
    mocks.hasTwoFactor.mockResolvedValue(true);

    const { frames, close } = await open('/api/v1/ws/servers/srv-1/terminal');

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([{ type: 'ready', cols: 120, rows: 32 }]);
    expect(close).toBeUndefined();
    expect(mocks.denied).not.toHaveBeenCalled();
  });

  it('opens the terminal while the organization does not require it', async () => {
    mocks.required.mockResolvedValue(false);

    await open('/api/v1/ws/servers/srv-1/terminal');

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.hasTwoFactor).not.toHaveBeenCalled();
  });
});

describe('organization-wide 2FA on the app shell', () => {
  it("refuses before SSH, by the project's organization, and audits it", async () => {
    const { frames, close } = await open('/api/v1/ws/projects/proj-1/shell');

    expect(frames).toEqual([expect.objectContaining({ type: 'error', code: 'ORG_2FA_REQUIRED' })]);
    expect(close).toEqual([4003, 'Shell unavailable']);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.required).toHaveBeenCalledWith('org-owner');
    expect(mocks.denied).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-owner',
        userId: 'user-1',
        accessPath: 'project_shell',
        projectId: 'proj-1',
      }),
    );
  });

  it('opens the shell for a member with 2FA', async () => {
    mocks.hasTwoFactor.mockResolvedValue(true);

    const { frames } = await open('/api/v1/ws/projects/proj-1/shell');

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([{ type: 'ready', cols: 120, rows: 32 }]);
  });

  it('opens the shell while the organization does not require it', async () => {
    mocks.required.mockResolvedValue(false);

    await open('/api/v1/ws/projects/proj-1/shell');

    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
});
