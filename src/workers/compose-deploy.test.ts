import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression: a compose-stack redeploy used to run `docker compose down` before building, so a
 * broken `build:` step left the project with no container at all and nginx answered 502 until
 * the next good deploy. The build now runs while the previous stack is still serving.
 */

const state: { buildExit: number; commands: string[] } = { buildExit: 0, commands: [] };

vi.mock('./port-manager', () => ({
  getOrAssignPort: vi.fn(async () => ({ port: 5123, isNew: false })),
}));

const setupNginxAndDomain = vi.fn(async () => 'https://shop.example.com');
const openFirewallPort = vi.fn(async () => undefined);
vi.mock('./remote-deployment', () => ({ setupNginxAndDomain, openFirewallPort }));

vi.mock('../db', () => ({ db: { select: () => { throw new Error('no db in this test'); } } }));

const { deployComposeFromRepo } = await import('./compose-deploy');

const COMPOSE_YAML = `services:
  web:
    build: .
    ports:
      - "3000:3000"
`;

function fakeSsh() {
  return {
    async exec(command: string) {
      state.commands.push(command);
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (command.startsWith('docker compose version')) return ok('Docker Compose version v2.27.0');
      if (command.startsWith('cat ')) return ok(COMPOSE_YAML);
      if (/ build 2>&1$/.test(command)) {
        return state.buildExit === 0
          ? ok('built')
          : { code: state.buildExit, stdout: '', stderr: 'failed to solve: npm run build exited 1' };
      }
      if (/ ps -q 2>&1$/.test(command)) return ok('abc123\n');
      return ok();
    },
    async uploadFile() {},
    async fileExists() {
      return false;
    },
  };
}

function deploy() {
  return deployComposeFromRepo(fakeSsh() as never, {
    server: { id: 'srv-1' } as never,
    projectId: 'proj-1',
    projectSlug: 'shop',
    deploySlug: 'shop',
    projectDir: '/opt/pushify/apps/shop',
    workDir: '/opt/pushify/apps/shop/repo',
    composeFile: '/opt/pushify/apps/shop/repo/docker-compose.yml',
    service: null,
    port: null,
    envVars: {},
    sharedHost: false,
    dockerConfig: null,
    onProgress: () => {},
  });
}

const indexOf = (re: RegExp) => state.commands.findIndex((c) => re.test(c));

beforeEach(() => {
  state.commands = [];
  vi.clearAllMocks();
});

describe('deployComposeFromRepo: a failed build leaves the previous stack serving', () => {
  it('build fails: the previous stack is never taken down and nginx is not touched', async () => {
    state.buildExit = 1;

    await expect(deploy()).rejects.toThrow(/Docker build failed/);

    expect(indexOf(/ build 2>&1$/)).toBeGreaterThan(-1);
    expect(indexOf(/ down /)).toBe(-1);
    expect(indexOf(/ up /)).toBe(-1);
    expect(setupNginxAndDomain).not.toHaveBeenCalled();
  });

  it('build succeeds: builds before stopping the previous stack, then starts without rebuilding', async () => {
    state.buildExit = 0;

    const result = await deploy();

    expect(result.success).toBe(true);
    const build = indexOf(/ build 2>&1$/);
    const down = indexOf(/ down /);
    const up = indexOf(/ up -d /);
    expect(build).toBeGreaterThan(-1);
    expect(down).toBeGreaterThan(build);
    expect(up).toBeGreaterThan(down);
    expect(state.commands[up]).not.toContain('--build');
    expect(setupNginxAndDomain).toHaveBeenCalledOnce();
  });
});
