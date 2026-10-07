import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Zero-downtime guarantee at the pipeline level (deployToRemoteServer, not just blueGreenDeploy):
 * when a deploy fails — the image does not build, or it builds but the container dies at start —
 * the live container must not be stopped, removed or renamed, and nginx must not be re-pointed.
 * Covers the generated-Dockerfile (buildpack) path and the repository's own Dockerfile path.
 */

type Scenario = {
  /** Slots that already have a container on the host (empty = first deploy) */
  existing: Array<'blue' | 'green'>;
  /** Does the repository ship its own Dockerfile? (false = buildpack generates one) */
  hasDockerfile: boolean;
  /** Exit code of the streamed `docker build` */
  buildExit: number;
  /** What `docker inspect -f '{{.State.Running}}'` says for the new container */
  newRunning: boolean;
};

const state: { scenario: Scenario; commands: string[]; uploads: string[] } = {
  scenario: { existing: [], hasDockerfile: true, buildExit: 0, newRunning: true },
  commands: [],
  uploads: [],
};

vi.mock('../utils/ssh', () => {
  class FakeSSHClient {
    async connect() {}
    disconnect() {}
    async exec(command: string) {
      state.commands.push(command);
      const s = state.scenario;
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (command === 'docker --version') return ok('Docker version 24.0.5, build ced0996');
      const inspectExists = command.match(/docker inspect --type container (\S+)/);
      if (inspectExists) {
        const exists = s.existing.some((slot) => inspectExists[1].endsWith(`-${slot}`));
        return { code: exists ? 0 : 1, stdout: '', stderr: '' };
      }
      if (command.startsWith('docker run ')) return ok('abcdef1234567890');
      if (command.includes('{{.State.Running}}')) return ok(s.newRunning ? 'true' : 'false');
      if (command.includes('nc -z 127.0.0.1')) return ok(s.newRunning ? 'OK' : 'FAIL');
      if (command.startsWith('docker logs')) return ok('Error: Cannot find module /app/server.js');
      return ok();
    }
    async execStream(command: string, onStdout: (s: string) => void, onStderr: (s: string) => void) {
      state.commands.push(command);
      if (state.scenario.buildExit !== 0) {
        onStderr('ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully\n');
      } else {
        onStdout('Successfully built\n');
      }
      return state.scenario.buildExit;
    }
    async uploadFile(_content: string | Buffer, remotePath: string) {
      state.uploads.push(remotePath);
    }
    async uploadFiles(files: { remotePath: string }[]) {
      for (const f of files) state.uploads.push(f.remotePath);
    }
    async fileExists(remotePath: string) {
      if (remotePath.endsWith('/Dockerfile')) return state.scenario.hasDockerfile;
      return false;
    }
    async mkdir() {}
    isConnected() {
      return true;
    }
  }
  return { SSHClient: FakeSSHClient };
});

vi.mock('../db', () => ({
  db: {
    query: {
      servers: {
        findFirst: vi.fn(async () => ({
          id: 'srv-1',
          status: 'running',
          setupStatus: 'completed',
          ipv4: '203.0.113.10',
          sshPrivateKey: 'encrypted-key',
        })),
      },
      domains: {
        findFirst: vi.fn(async () => ({ domain: 'shop.example.com', isPrimary: true })),
      },
    },
  },
}));

vi.mock('../lib/encryption', () => ({ decrypt: () => 'private-key' }));

vi.mock('../lib/project-sites', () => ({
  syncProjectSites: vi.fn(async () => ({ success: true })),
  describeSyncedDomains: vi.fn(() => ''),
}));

vi.mock('./nginx-manager', () => ({
  addAutoSubdomainSite: vi.fn(async () => ({ success: true, message: '' })),
  reloadNginx: vi.fn(async () => ({ success: true, message: '' })),
  CATCH_ALL_TLS_SCRIPT: 'true',
}));

vi.mock('./worker-process-sync', () => ({ syncWorkerContainersOnDeploy: vi.fn(async () => undefined) }));

const { deployToRemoteServer } = await import('./remote-deployment');
const { syncProjectSites } = await import('../lib/project-sites');
const { addAutoSubdomainSite, reloadNginx } = await import('./nginx-manager');

function deploy() {
  return deployToRemoteServer({
    serverId: 'srv-1',
    projectId: 'proj-1',
    projectSlug: 'shop',
    deploymentId: 'dep-12345678',
    repoUrl: 'https://github.com/acme/shop.git',
    branch: 'main',
    commitHash: 'abc1234def',
    envVars: {},
    framework: 'nodejs',
    onProgress: () => {},
  } as unknown as Parameters<typeof deployToRemoteServer>[0]);
}

/** Any command that would stop, remove, kill or rename the live container */
function touchesLive(oldName: string): string[] {
  const re = new RegExp(`docker (stop|rm|kill|rename)\\b[^\\n]*\\b${oldName}\\b`);
  return state.commands.filter((c) => re.test(c));
}

/** Anything that would change what nginx routes to */
function routeChanges(): string[] {
  const viaCommands = state.commands.filter((c) => /nginx -s reload|systemctl (reload|restart) nginx|sites-enabled/.test(c));
  const viaUploads = state.uploads.filter((p) => p.startsWith('/etc/nginx'));
  return [...viaCommands, ...viaUploads];
}

function expectLiveUntouched(liveName: string) {
  expect(touchesLive(liveName)).toEqual([]);
  expect(routeChanges()).toEqual([]);
  expect(syncProjectSites).not.toHaveBeenCalled();
  expect(reloadNginx).not.toHaveBeenCalled();
  expect(addAutoSubdomainSite).not.toHaveBeenCalled();
}

beforeEach(() => {
  state.commands = [];
  state.uploads = [];
  vi.clearAllMocks();
});

describe('deployToRemoteServer: a failed deploy leaves the live container serving', () => {
  it.each([
    ['own Dockerfile', true],
    ['buildpack-generated Dockerfile', false],
  ])('build fails (%s): no container started, live one and nginx untouched', async (_label, hasDockerfile) => {
    state.scenario = { existing: ['blue'], hasDockerfile, buildExit: 1, newRunning: true };

    const result = await deploy();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Docker build failed');
    expect(state.commands.some((c) => c.startsWith('docker run '))).toBe(false);
    expectLiveUntouched('pushify-shop-blue');
  });

  it('build succeeds but the container crashes at start: new one removed, live one and nginx untouched', async () => {
    state.scenario = { existing: ['blue'], hasDockerfile: true, buildExit: 0, newRunning: false };

    const result = await deploy();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blue-green deployment failed');
    expect(state.commands).toContain('docker rm -f pushify-shop-green 2>/dev/null || true');
    expectLiveUntouched('pushify-shop-blue');
  });

  it('first deploy whose container crashes: reported as failed, never routed', async () => {
    state.scenario = { existing: [], hasDockerfile: false, buildExit: 0, newRunning: false };

    const result = await deploy();

    expect(result.success).toBe(false);
    expect(result.deploymentUrl).toBeUndefined();
    expect(routeChanges()).toEqual([]);
    expect(syncProjectSites).not.toHaveBeenCalled();
  });
});
