import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A project without a server runs on a Pushify shared runner. The runner is Pushify's, not the
 * customer's organization's, so it has to be found by the runner choice — otherwise a pause,
 * suspension or delete of such a project silently leaves its containers running.
 */
const RUNNER = { id: 'runner-1', ipv4: '10.0.0.9', sshPrivateKey: 'enc-key', organizationId: 'pushify-org' };

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(async () => []),
  pickRunner: vi.fn(() => 'runner-1' as string | null),
  exec: vi.fn(async (_cmd: string) => ({ code: 0, stdout: '', stderr: '' })),
  env: { NODE_ENV: 'production', PUSHIFY_ALLOW_LOCAL_DEPLOYS: undefined as boolean | undefined },
}));

vi.mock('../db', () => ({ db: { query: { servers: { findFirst: mocks.findFirst, findMany: mocks.findMany } } } }));
vi.mock('./runner-routing', () => ({ pickRunnerServerId: mocks.pickRunner }));
vi.mock('../config/env', () => ({ env: mocks.env }));
vi.mock('./encryption', () => ({ decrypt: () => 'key' }));
vi.mock('../utils/ssh', () => ({
  getSSHConnection: vi.fn(async () => ({ exec: mocks.exec, disconnect: vi.fn() })),
}));
vi.mock('../workers/port-manager', () => ({ releasePort: vi.fn() }));

import { pauseProjectContainers, resolveDeployServerForCleanup } from './project-remote-cleanup';

const runnerProject = { id: 'p1', slug: 'spiderpanel', serverId: null, organizationId: 'customer-org', settings: {} } as never;

beforeEach(() => {
  mocks.findFirst.mockReset().mockResolvedValue(RUNNER);
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.pickRunner.mockReset().mockReturnValue('runner-1');
  mocks.exec.mockReset().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
});

describe('projects on a shared runner', () => {
  it('resolve to the runner the deploy picked, not to the customer organization', async () => {
    expect(await resolveDeployServerForCleanup(runnerProject)).toBe(RUNNER);
    expect(mocks.pickRunner).toHaveBeenCalledWith('p1');
  });

  it('pause stops the containers on the runner and reports success only when none is left', async () => {
    expect(await pauseProjectContainers(runnerProject)).toBe(true);
    const commands = mocks.exec.mock.calls.map((c) => c[0]).join('\n');
    expect(commands).toContain('docker stop');
    expect(commands).toContain('pushify-spiderpanel');

    // A container that is still up after the stop is reported, not hidden
    mocks.exec.mockImplementation(async (cmd: string) =>
      cmd.startsWith('docker ps') ? { code: 0, stdout: 'pushify-spiderpanel-blue\n', stderr: '' } : { code: 0, stdout: '', stderr: '' },
    );
    expect(await pauseProjectContainers(runnerProject)).toBe(false);
  });

  it('with no server and no runner, production reports that nothing was stopped', async () => {
    mocks.pickRunner.mockReturnValue(null);
    mocks.findFirst.mockResolvedValue(undefined);
    expect(await resolveDeployServerForCleanup(runnerProject)).toBeNull();
    expect(await pauseProjectContainers(runnerProject)).toBe(false);
  });
});
