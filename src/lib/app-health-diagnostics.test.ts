import { describe, it, expect } from 'vitest';
import {
  buildServerDiagnostics,
  classifyProbeError,
  diagnosticsDue,
  DIAGNOSTICS_REFRESH_MS,
  type ServerProbeOutcomes,
} from './app-health';

const allOk: ServerProbeOutcomes = { ssh: 'ok', docker: 'ok', httpPort: 'ok', httpsPort: 'ok' };
const now = new Date(Date.UTC(2026, 9, 8, 12));

describe('buildServerDiagnostics', () => {
  it('reports every check and no advice when everything works', () => {
    const d = buildServerDiagnostics(allOk, { managed: false, now });
    expect(d.checks.map((c) => [c.check, c.ok])).toEqual([
      ['ssh', true],
      ['docker', true],
      ['http_port', true],
      ['https_port', true],
    ]);
    expect(d.failedCheck).toBeNull();
    expect(d.advice).toBeNull();
    expect(d.checkedAt).toBe(now.toISOString());
  });

  it('an SSH timeout points at firewall or a powered-off server, and Docker is skipped, not failed', () => {
    const d = buildServerDiagnostics(
      { ssh: 'timeout', docker: 'failed', httpPort: 'timeout', httpsPort: 'timeout' },
      { managed: false, now }
    );
    expect(d.failedCheck).toBe('ssh');
    expect(d.advice).toMatch(/SSH connection timed out/);
    expect(d.advice).toMatch(/firewall/);
    expect(d.advice).toMatch(/powered off/);
    const docker = d.checks.find((c) => c.check === 'docker')!;
    expect(docker.outcome).toBe('skipped');
    expect(docker.ok).toBeNull();
    expect(docker.advice).toBeNull();
  });

  it('SSH refused and SSH key rejected get their own next step', () => {
    expect(buildServerDiagnostics({ ...allOk, ssh: 'refused' }, { managed: false }).advice).toMatch(/not listening on port 22/);
    expect(buildServerDiagnostics({ ...allOk, ssh: 'auth_failed' }, { managed: false }).advice).toMatch(/authorized_keys/);
  });

  it('a stopped Docker daemon is named when SSH works', () => {
    const d = buildServerDiagnostics({ ...allOk, docker: 'failed' }, { managed: false });
    expect(d.failedCheck).toBe('docker');
    expect(d.advice).toMatch(/systemctl start docker/);
  });

  it('a closed proxy port and a firewalled one are told apart', () => {
    const refused = buildServerDiagnostics({ ...allOk, httpPort: 'refused' }, { managed: false });
    expect(refused.failedCheck).toBe('http_port');
    expect(refused.advice).toMatch(/Nothing is listening on port 80/);
    const blocked = buildServerDiagnostics({ ...allOk, httpsPort: 'timeout' }, { managed: false });
    expect(blocked.failedCheck).toBe('https_port');
    expect(blocked.advice).toMatch(/Allow inbound TCP 443/);
  });

  it('on a managed server the advice says operations was alerted', () => {
    const d = buildServerDiagnostics({ ...allOk, ssh: 'timeout' }, { managed: true });
    expect(d.managed).toBe(true);
    expect(d.advice).toMatch(/operations team has been alerted/);
    expect(buildServerDiagnostics({ ...allOk, ssh: 'timeout' }, { managed: false }).advice).not.toMatch(/operations/);
  });
});

describe('classifyProbeError', () => {
  it('maps socket and SSH errors', () => {
    expect(classifyProbeError(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:22'), { code: 'ECONNREFUSED' }))).toBe('refused');
    expect(classifyProbeError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe('timeout');
    expect(classifyProbeError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }))).toBe('timeout');
    expect(classifyProbeError(new Error('Timed out while waiting for handshake'))).toBe('timeout');
    expect(
      classifyProbeError(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }))
    ).toBe('auth_failed');
    expect(classifyProbeError(new Error('something else'))).toBe('failed');
    expect(classifyProbeError(undefined)).toBe('failed');
  });
});

describe('diagnosticsDue', () => {
  it('runs when there are none, and again only after the refresh interval', () => {
    expect(diagnosticsDue(null, now)).toBe(true);
    expect(diagnosticsDue({ checkedAt: new Date(now.getTime() - 60_000).toISOString() }, now)).toBe(false);
    expect(diagnosticsDue({ checkedAt: new Date(now.getTime() - DIAGNOSTICS_REFRESH_MS).toISOString() }, now)).toBe(true);
    expect(diagnosticsDue({ checkedAt: 'garbage' }, now)).toBe(true);
  });
});
