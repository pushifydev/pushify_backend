import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Runner routing decides which server a free/unassigned project deploys to — and which server
 * post-deploy ops (log streaming, etc.) must talk to. Regression context: an unassigned project
 * deployed to a runner but the log endpoint treated it as local ("Container is not running").
 *
 * config/env is mocked so these tests are independent of the local .env (dotenv would
 * otherwise inject a real runner pool).
 */
const mockEnv = vi.hoisted(() => ({
  env: {} as { PUSHIFY_RUNNER_SERVER_IDS?: string; PUSHIFY_RUNNER_SERVER_ID?: string },
}));
vi.mock('../config/env', () => mockEnv);

import { pickRunnerServerId, resolveProjectServerId } from './runner-routing';

beforeEach(() => {
  mockEnv.env.PUSHIFY_RUNNER_SERVER_IDS = undefined;
  mockEnv.env.PUSHIFY_RUNNER_SERVER_ID = undefined;
});

describe('pickRunnerServerId', () => {
  it('returns null when no runner pool is configured', () => {
    expect(pickRunnerServerId('project-a')).toBeNull();
  });

  it('returns the single runner for a one-id pool', () => {
    mockEnv.env.PUSHIFY_RUNNER_SERVER_IDS = 'runner-1';
    expect(pickRunnerServerId('project-a')).toBe('runner-1');
    expect(pickRunnerServerId('project-b')).toBe('runner-1');
  });

  it('honors the legacy single PUSHIFY_RUNNER_SERVER_ID', () => {
    mockEnv.env.PUSHIFY_RUNNER_SERVER_ID = 'legacy-runner';
    expect(pickRunnerServerId('project-a')).toBe('legacy-runner');
  });

  it('prefers the pool over the legacy single id when both are set', () => {
    mockEnv.env.PUSHIFY_RUNNER_SERVER_IDS = 'pool-1';
    mockEnv.env.PUSHIFY_RUNNER_SERVER_ID = 'legacy-runner';
    expect(pickRunnerServerId('project-a')).toBe('pool-1');
  });

  it('tolerates whitespace and trailing commas in the pool list', () => {
    mockEnv.env.PUSHIFY_RUNNER_SERVER_IDS = ' runner-1 , runner-2 ,';
    expect(['runner-1', 'runner-2']).toContain(pickRunnerServerId('project-a'));
  });

  it('maps a project stickily and spreads projects across a multi-runner pool', () => {
    const pool = ['runner-1', 'runner-2', 'runner-3'];
    mockEnv.env.PUSHIFY_RUNNER_SERVER_IDS = pool.join(',');

    const assignments = new Map<string, string>();
    for (let i = 0; i < 50; i++) {
      const projectId = `9b2f1c${i}-aaaa-bbbb-cccc-ddddeeee${i}`;
      const first = pickRunnerServerId(projectId)!;
      expect(pool).toContain(first);
      // Sticky: repeated calls for the same project always land on the same runner.
      expect(pickRunnerServerId(projectId)).toBe(first);
      assignments.set(projectId, first);
    }
    // Spread: with 50 projects on 3 runners, more than one runner must be in use.
    expect(new Set(assignments.values()).size).toBeGreaterThan(1);
  });
});

describe('resolveProjectServerId', () => {
  it("prefers the project's explicitly assigned server over the runner pool", () => {
    mockEnv.env.PUSHIFY_RUNNER_SERVER_IDS = 'runner-1';
    expect(resolveProjectServerId({ id: 'p1', serverId: 'user-server' })).toBe('user-server');
  });

  it('falls back to the sticky runner for unassigned projects', () => {
    mockEnv.env.PUSHIFY_RUNNER_SERVER_IDS = 'runner-1';
    expect(resolveProjectServerId({ id: 'p1', serverId: null })).toBe('runner-1');
  });

  it('returns null (local deploy) when unassigned and no runner is configured', () => {
    expect(resolveProjectServerId({ id: 'p1', serverId: null })).toBeNull();
  });
});
