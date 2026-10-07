import { describe, it, expect } from 'vitest';
import type { SSHClient } from '../utils/ssh';
import { blueGreenDeploy } from './remote-docker';

/**
 * Zero-downtime guarantee: a deploy whose new container does not come up healthy must leave
 * the live (old) container alone. Retiring the old container and re-pointing nginx happen in
 * remote-deployment.ts only after blueGreenDeploy reports success; a failed Docker build throws
 * before blueGreenDeploy is called at all.
 */

type Scenario = {
  /** Which slots already have a container on the host */
  existing: Array<'blue' | 'green'>;
  /** What `docker inspect -f '{{.State.Running}}'` says for the new container */
  newRunning: boolean;
  /** What the TCP probe says for the new container */
  probe: 'OK' | 'FAIL';
  /** Exit code of `docker run` */
  runCode?: number;
};

function fakeSsh(s: Scenario) {
  const commands: string[] = [];
  const ssh = {
    async exec(command: string) {
      commands.push(command);
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      const inspectExists = command.match(/docker inspect --type container (\S+)/);
      if (inspectExists) {
        const name = inspectExists[1];
        const exists = s.existing.some((slot) => name.endsWith(`-${slot}`));
        return { code: exists ? 0 : 1, stdout: '', stderr: '' };
      }
      if (command.startsWith('docker run ')) {
        return s.runCode ? { code: s.runCode, stdout: '', stderr: 'run failed' } : ok('abcdef1234567890');
      }
      if (command.includes('{{.State.ExitCode}}')) return ok(s.newRunning ? 'true 0' : 'false 1');
      if (command.includes("{{.State.Running}}")) return ok(s.newRunning ? 'true' : 'false');
      if (command.includes('nc -z 127.0.0.1')) return ok(s.probe);
      if (command.startsWith('docker logs')) return ok('Listening...\nError: Cannot find module /app/server.js');
      return ok();
    },
  };
  return { ssh: ssh as unknown as SSHClient, commands };
}

const base = {
  imageName: 'pushify/shop:abc1234',
  containerName: 'pushify-shop',
  hostPort: 3000,
  tempPort: 3001,
  containerPort: 3000,
};

/** Any command that would stop, remove or rename the live container */
function touchesOld(commands: string[], oldName: string): string[] {
  const re = new RegExp(`docker (stop|rm|kill|rename)\\b[^\\n]*\\b${oldName}\\b`);
  return commands.filter((c) => re.test(c));
}

describe('blueGreenDeploy keeps the live container when the new one fails', () => {
  it('container exits right away: fails, removes only the new container', async () => {
    const { ssh, commands } = fakeSsh({ existing: ['blue'], newRunning: false, probe: 'FAIL' });
    const result = await blueGreenDeploy(ssh, base);

    expect(result.success).toBe(false);
    expect(result.logs).toContain('Container exited unexpectedly (exit code 1)');
    expect(result.logs).toContain('Error: Cannot find module /app/server.js');
    expect(commands).toContain('docker logs --tail 50 pushify-shop-green 2>&1');
    // Exit code and logs are read before the failed container is removed
    const inspectAt = commands.findIndex((c) => c.includes('{{.State.ExitCode}}'));
    expect(inspectAt).toBeGreaterThanOrEqual(0);
    expect(inspectAt).toBeLessThan(commands.indexOf('docker rm -f pushify-shop-green 2>/dev/null || true'));
    expect(touchesOld(commands, 'pushify-shop-blue')).toEqual([]);
    expect(commands).toContain('docker rm -f pushify-shop-green 2>/dev/null || true');
  });

  it('health check times out: fails, live container untouched', async () => {
    const { ssh, commands } = fakeSsh({ existing: ['green'], newRunning: true, probe: 'FAIL' });
    const result = await blueGreenDeploy(ssh, { ...base, healthCheckTimeout: 0 });

    expect(result.success).toBe(false);
    expect(result.logs).toContain('health check timeout');
    expect(result.logs).not.toContain('exit code');
    expect(result.logs).toContain('Runtime log (last 50 lines):');
    expect(touchesOld(commands, 'pushify-shop-green')).toEqual([]);
    expect(commands).toContain('docker rm -f pushify-shop-blue 2>/dev/null || true');
  });

  it('docker run fails: fails, live container untouched', async () => {
    const { ssh, commands } = fakeSsh({ existing: ['blue'], newRunning: false, probe: 'FAIL', runCode: 125 });
    const result = await blueGreenDeploy(ssh, base);

    expect(result.success).toBe(false);
    expect(touchesOld(commands, 'pushify-shop-blue')).toEqual([]);
  });

  it('healthy: reports the old container but leaves retiring it to the caller (after the proxy switch)', async () => {
    const { ssh, commands } = fakeSsh({ existing: ['blue'], newRunning: true, probe: 'OK' });
    const result = await blueGreenDeploy(ssh, base);

    expect(result.success).toBe(true);
    expect(result.newContainerName).toBe('pushify-shop-green');
    expect(result.oldContainerName).toBe('pushify-shop-blue');
    expect(result.tempPort).toBe(3001);
    expect(touchesOld(commands, 'pushify-shop-blue')).toEqual([]);
  });
});
