import { describe, it, expect } from 'vitest';
import { DOCKER_CLEANUP_COMMANDS, runDockerCleanup } from './server-docker-cleanup';
import type { SSHClient } from '../utils/ssh';

function fakeSsh(dfOutputs: string[]) {
  const commands: string[] = [];
  const ssh = {
    exec: async (cmd: string) => {
      commands.push(cmd);
      if (cmd.startsWith('df ')) return { stdout: dfOutputs.shift() ?? '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
  } as unknown as SSHClient;
  return { ssh, commands };
}

describe('server docker cleanup', () => {
  it('never removes tagged images (rollback deploy-<id> tags, images of running apps)', () => {
    const script = DOCKER_CLEANUP_COMMANDS.join('\n');
    expect(script).toContain('docker image prune -f');
    // `-a` would remove every image not used by a container, including rollback tags
    expect(script).not.toMatch(/image prune[^\n]*(-a\b|-af|--all)/);
    expect(script).not.toMatch(/system prune/);
    expect(script).not.toMatch(/docker rmi/);
  });

  it('never removes stopped (sleeping/stopped database) containers or volumes', () => {
    const script = DOCKER_CLEANUP_COMMANDS.join('\n');
    expect(script).not.toMatch(/container prune/);
    expect(script).not.toMatch(/status=exited/);
    expect(script).not.toMatch(/volume/);
    expect(script).toContain('--filter status=dead');
  });

  it('only prunes build cache older than the keep window', () => {
    expect(DOCKER_CLEANUP_COMMANDS.some((c) => /builder prune -f --filter until=\d+h/.test(c))).toBe(true);
  });

  it('reports disk usage before and after', async () => {
    const { ssh, commands } = fakeSsh(['85 1000000 /', '62 9000000 /']);
    const result = await runDockerCleanup(ssh);
    expect(result.beforePercent).toBe(85);
    expect(result.afterPercent).toBe(62);
    expect(commands[0]).toMatch(/^df /);
    expect(commands.slice(1, -1)).toEqual([...DOCKER_CLEANUP_COMMANDS]);
    expect(commands[commands.length - 1]).toMatch(/^df /);
  });
});
