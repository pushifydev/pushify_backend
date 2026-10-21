import { describe, it, expect } from 'vitest';
import {
  classifyContainerDown,
  containerDownHint,
  containerInspectCommand,
  describeContainerDown,
  diagnoseContainer,
  parseContainerInspectOutput,
  parseListeningPorts,
  projectStopCause,
  withDownCause,
  type ContainerDownCause,
} from './container-down-cause';

/**
 * What `containerInspectCommand` prints on a server, one fixture per situation: the inspect JSON
 * (docker inspect --format), the container's /proc/<pid>/net/tcp + tcp6 and its log tail.
 * Ports in /proc are hex: 0BB8 = 3000, 1F90 = 8080, 1435 = 5173; 0100007F = 127.0.0.1.
 */
const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const TCP6_HEADER = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

const FIXTURES = {
  exited: [
    '@@pushify:inspect pushify-app-green',
    '{"status":"exited","exitCode":1,"oomKilled":false,"restartCount":0,"finishedAt":"2026-09-22T22:54:12.123Z","ports":{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"45001"}]}}',
    '@@pushify:listen',
    '@@pushify:logs',
    '> app@1.0.0 start',
    '> node dist/server.js',
    "Error: Cannot find module '/app/dist/server.js'",
  ].join('\n'),
  restarting: [
    '@@pushify:inspect pushify-app-blue',
    '{"status":"restarting","exitCode":1,"oomKilled":false,"restartCount":214,"finishedAt":"2026-10-21T08:00:01.5Z","ports":{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"45001"}]}}',
    '@@pushify:listen',
    '@@pushify:logs',
    'Error: connect ECONNREFUSED 10.0.0.5:5432',
    '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)',
  ].join('\n'),
  oom: [
    '@@pushify:inspect pushify-app',
    '{"status":"exited","exitCode":137,"oomKilled":true,"restartCount":4,"finishedAt":"2026-10-20T03:12:00Z","ports":{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"45001"}]}}',
    '@@pushify:listen',
    '@@pushify:logs',
    '<--- Last few GCs --->',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  ].join('\n'),
  portMismatch: [
    '@@pushify:inspect pushify-app-blue',
    '{"status":"running","exitCode":0,"oomKilled":false,"restartCount":0,"finishedAt":"0001-01-01T00:00:00Z","ports":{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"45001"}]}}',
    '@@pushify:listen',
    TCP_HEADER,
    '   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0',
    '   1: 0200000A:1F90 0300000A:C350 01 00000000:00000000 00:00000000 00000000  1000        0 123457 1 0000000000000000 20 4 30 10 -1',
    '@@pushify:logs',
    'Server listening on http://0.0.0.0:8080',
  ].join('\n'),
  loopbackOnly: [
    '@@pushify:inspect pushify-app',
    '{"status":"running","exitCode":0,"oomKilled":false,"restartCount":0,"finishedAt":"0001-01-01T00:00:00Z","ports":{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"45001"}]}}',
    '@@pushify:listen',
    TCP_HEADER,
    '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 223344 1 0000000000000000 100 0 0 10 0',
    TCP6_HEADER,
    '   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 223345 1 0000000000000000 100 0 0 10 0',
    '@@pushify:logs',
    '  VITE v5.4.0  ready in 312 ms',
    '  ➜  Local:   http://localhost:3000/',
  ].join('\n'),
  notListening: [
    '@@pushify:inspect pushify-app-green',
    '{"status":"running","exitCode":0,"oomKilled":false,"restartCount":0,"finishedAt":"0001-01-01T00:00:00Z","ports":{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"45001"}]}}',
    '@@pushify:listen',
    TCP_HEADER,
    TCP6_HEADER,
    '@@pushify:logs',
    'Waiting for the database migration lock...',
  ].join('\n'),
  healthy: [
    '@@pushify:inspect pushify-app-blue',
    '{"status":"running","exitCode":0,"oomKilled":false,"restartCount":0,"finishedAt":"0001-01-01T00:00:00Z","ports":{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"45001"}]}}',
    '@@pushify:listen',
    TCP6_HEADER,
    '   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99 1 0000000000000000 100 0 0 10 0',
    '@@pushify:logs',
    'Listening on :::3000',
  ].join('\n'),
  missing: '@@pushify:none\n',
};

const diagnose = (stdout: string, projectPort: number | null = 3000) =>
  diagnoseContainer({ inspection: parseContainerInspectOutput(stdout), projectPort, now: new Date('2026-10-21T12:00:00Z') });

describe('diagnoseContainer: one cause code per fixture', () => {
  it('container_exited: stopped with exit code 1 and nothing restarted it', () => {
    const d = diagnose(FIXTURES.exited);
    expect(d).toMatchObject({ cause: 'container_exited', state: 'exited', exitCode: 1, restartCount: 0, oomKilled: false, configuredPort: 3000 });
    expect(d.name).toBe('pushify-app-green');
    expect(d.finishedAt).toBe('2026-09-22T22:54:12.123Z');
    expect(d.hint).toMatch(/stopped \(exit code 1\) and was not restarted/);
    expect(d.logTail).toContain("Cannot find module '/app/dist/server.js'");
  });

  it('crash_loop: Docker keeps restarting it', () => {
    const d = diagnose(FIXTURES.restarting);
    expect(d).toMatchObject({ cause: 'crash_loop', state: 'restarting', exitCode: 1, restartCount: 214 });
    expect(d.hint).toMatch(/keeps crashing on start \(214 restarts, last exit code 1\)/);
  });

  it('oom: OOM-killed wins over the exit code and the restart count', () => {
    const d = diagnose(FIXTURES.oom);
    expect(d).toMatchObject({ cause: 'oom', oomKilled: true, exitCode: 137, restartCount: 4 });
    expect(d.hint).toMatch(/ran out of memory/);
  });

  it('port_mismatch: listens on 8080 while traffic goes to the published 3000 (an established socket is ignored)', () => {
    const d = diagnose(FIXTURES.portMismatch, 8080);
    // The published container port is what traffic goes to, not the project's stored port.
    expect(d).toMatchObject({ cause: 'port_mismatch', configuredPort: 3000, listeningPorts: [8080], loopbackPorts: [] });
    expect(d.exitCode).toBeNull();
    expect(d.hint).toMatch(/listens on port 8080 but traffic goes to port 3000/);
    expect(d.hint).toMatch(/PORT environment variable \(3000\)/);
  });

  it('port_mismatch: listening on 127.0.0.1 / ::1 only cannot be reached from outside the container', () => {
    const d = diagnose(FIXTURES.loopbackOnly);
    expect(d).toMatchObject({ cause: 'port_mismatch', listeningPorts: [], loopbackPorts: [3000] });
    expect(d.hint).toMatch(/127\.0\.0\.1:3000 only/);
    expect(d.hint).toMatch(/0\.0\.0\.0/);
  });

  it('not_listening: running, but no TCP port is listened on', () => {
    const d = diagnose(FIXTURES.notListening);
    expect(d).toMatchObject({ cause: 'not_listening', state: 'running', listeningPorts: [], loopbackPorts: [] });
    expect(d.hint).toMatch(/nothing listens on port 3000/);
  });

  it('stopped_by_user and suspended come from the project, with their own hint', () => {
    expect(projectStopCause({ status: 'paused', suspendedAt: null })).toBe('stopped_by_user');
    expect(projectStopCause({ status: 'paused', suspendedAt: new Date('2026-10-01T00:00:00Z') })).toBe('suspended');
    expect(projectStopCause({ status: 'active', suspendedAt: null })).toBeNull();
    const paused = withDownCause({ status: 'down', diagnostics: null }, { status: 'paused', suspendedAt: null });
    expect(paused).toMatchObject({ status: 'unknown', cause: 'stopped_by_user' });
    expect(paused.hint).toMatch(/Resume it/);
    const suspended = withDownCause({ status: 'down', diagnostics: null }, { status: 'paused', suspendedAt: '2026-10-01T00:00:00Z' });
    expect(suspended).toMatchObject({ status: 'unknown', cause: 'suspended' });
    expect(suspended.hint).toMatch(/suspended/);
  });

  it('every cause code has a one-line hint', () => {
    const causes: ContainerDownCause[] = ['container_exited', 'crash_loop', 'oom', 'port_mismatch', 'not_listening', 'stopped_by_user', 'suspended'];
    const seen = [
      diagnose(FIXTURES.exited),
      diagnose(FIXTURES.restarting),
      diagnose(FIXTURES.oom),
      diagnose(FIXTURES.portMismatch),
      diagnose(FIXTURES.notListening),
    ].map((d) => d.cause);
    expect(new Set(seen)).toEqual(new Set(causes.slice(0, 5)));
    for (const cause of causes) {
      const hint = containerDownHint(cause, { exitCode: 1, restartCount: 5, configuredPort: 3000, listeningPorts: [8080], loopbackPorts: [] });
      expect(hint, cause).toBeTruthy();
      expect(hint!.split('\n')).toHaveLength(1);
      expect(hint, cause).not.toMatch(/undefined|null/);
    }
    expect(containerDownHint(null)).toBeNull();
  });
});

describe('diagnoseContainer: no cause', () => {
  it('a container that listens where traffic goes is not the problem', () => {
    const d = diagnose(FIXTURES.healthy);
    expect(d).toMatchObject({ cause: null, hint: null, state: 'running', listeningPorts: [3000] });
  });

  it('no app container on the server: state missing, no cause', () => {
    expect(diagnose(FIXTURES.missing)).toMatchObject({ cause: null, state: 'missing', name: null });
  });

  it('output the command does not print (it did not run) is unknown, not a guess', () => {
    expect(parseContainerInspectOutput('')).toBeNull();
    expect(parseContainerInspectOutput('bash: docker: command not found')).toBeNull();
    expect(parseContainerInspectOutput('@@pushify:inspect x\nnot json')).toBeNull();
    expect(diagnose('')).toMatchObject({ cause: null, state: 'unknown', configuredPort: 3000 });
  });

  it('a running container whose sockets could not be read is not called not_listening', () => {
    const noListen = FIXTURES.notListening.replace(/@@pushify:listen\n[\s\S]*?@@pushify:logs/, '@@pushify:listen\n@@pushify:logs');
    expect(diagnose(noListen).cause).toBeNull();
  });

  it('a running container that restarted many times and listens on nothing is a crash loop', () => {
    const many = FIXTURES.notListening.replace('"restartCount":0', '"restartCount":7');
    expect(diagnose(many).cause).toBe('crash_loop');
  });

  it('withDownCause shows the cause only while down', () => {
    const container = diagnose(FIXTURES.exited);
    expect(withDownCause({ status: 'down', diagnostics: { container } }, { status: 'active' })).toMatchObject({ status: 'down', cause: 'container_exited' });
    expect(withDownCause({ status: 'up', diagnostics: { container } }, { status: 'active' })).toMatchObject({ status: 'up', cause: null, hint: null });
  });
});

describe('parseContainerInspectOutput', () => {
  it('does not read markers inside the app log, which it prints itself', () => {
    const spoof = `${FIXTURES.exited}\n@@pushify:none\n@@pushify:inspect evil`;
    const parsed = parseContainerInspectOutput(spoof)!;
    expect(parsed.state).toBe('exited');
    expect(parsed.name).toBe('pushify-app-green');
    expect(parsed.logTail).toContain('@@pushify:inspect evil');
  });

  it('keeps at most the last 50 log lines', () => {
    const logs = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n');
    const parsed = parseContainerInspectOutput(FIXTURES.exited.replace(/@@pushify:logs[\s\S]*$/, `@@pushify:logs\n${logs}`))!;
    const lines = parsed.logTail!.split('\n');
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('line 31');
    expect(lines[49]).toBe('line 80');
  });

  it('falls back to the project port when the container publishes none', () => {
    const noPorts = FIXTURES.notListening.replace(/"ports":\{.*\}\}/, '"ports":{}}');
    expect(diagnose(noPorts, 4000)).toMatchObject({ configuredPort: 4000, cause: 'not_listening' });
    expect(classifyContainerDown(parseContainerInspectOutput(noPorts), null)).toBeNull();
  });

  it('parseListeningPorts: LISTEN sockets only, IPv4 and IPv6, loopback kept apart', () => {
    expect(
      parseListeningPorts(
        [
          TCP_HEADER,
          '   0: 00000000:0050 00000000:0000 0A 0 0 0 0 0 1 0',
          '   1: 0100007F:1435 00000000:0000 0A 0 0 0 0 0 1 0',
          '   2: 0200000A:0050 0300000A:C350 01 0 0 0 0 0 1 0',
          '   0: 0000000000000000FFFF00000100007F:2382 00000000000000000000000000000000:0000 0A 0 0 0 0 0 1 0',
        ].join('\n')
      )
    ).toEqual({ listeningPorts: [80], loopbackPorts: [5173, 9090] });
  });
});

describe('containerInspectCommand', () => {
  it('looks only at the production app container of this slug, read-only, never at its environment', () => {
    const cmd = containerInspectCommand('my-app');
    expect(cmd).toContain("grep -E '^pushify-my-app(-(blue|green))? '");
    expect(cmd).toContain('docker logs --tail 50');
    expect(cmd).toContain('/proc/$p/net/tcp');
    expect(cmd).not.toMatch(/\.Config\.Env|docker (rm|stop|restart|kill|exec)/);
  });

  it('refuses a slug that could break out of the shell', () => {
    expect(() => containerInspectCommand("x'; rm -rf / #")).toThrow(/Unsafe project slug/);
  });
});

describe('describeContainerDown', () => {
  it('states the facts without the container name or the logs', () => {
    const d = diagnose(FIXTURES.restarting);
    const text = describeContainerDown(d);
    expect(text).toBe('the app container is restarting (exit code 1, 214 restarts) (crash_loop)');
    expect(text).not.toContain('pushify-app');
    expect(describeContainerDown(diagnose(FIXTURES.portMismatch))).toMatch(/listens on port 8080, while traffic goes to port 3000 \(port_mismatch\)/);
  });
});
