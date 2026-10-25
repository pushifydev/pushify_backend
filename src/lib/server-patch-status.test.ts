import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  buildPatchStatusScript,
  checkServerPatchStatus,
  countSimulatedUpgrades,
  parseAptCheckOutput,
  parsePatchStatusOutput,
} from './server-patch-status';
import type { SSHClient } from '../utils/ssh';

const NOW = new Date('2026-10-25T12:00:00Z');
const out = (...lines: string[]) => lines.map((l) => `PUSHIFY_PATCH ${l}`).join('\n') + '\n';

const UNKNOWN = {
  pending: 'unknown',
  security: 'unknown',
  rebootRequired: 'unknown',
  unattendedUpgrades: { enabled: 'unknown', lastRunAt: null },
  checkedAt: '2026-10-25T12:00:00.000Z',
};

describe('buildPatchStatusScript', () => {
  const script = buildPatchStatusScript();

  it('is valid shell', () => {
    const res = spawnSync('bash', ['-n'], { input: script });
    if (res.error) return; // no bash on this machine
    expect(res.status, String(res.stderr)).toBe(0);
  });

  it('is read-only: no apt update, install or upgrade, only a simulation', () => {
    expect(script).not.toMatch(/apt(-get)?\s+(update|upgrade|install|dist-upgrade|full-upgrade|remove|purge|autoremove)\b/);
    expect(script).not.toMatch(/unattended-upgrade\s+(-|--)/);
    expect(script).not.toMatch(/\b(dpkg\s+-|rm|touch|truncate|tee|mv|cp|shutdown)\b/);
    expect(script).not.toMatch(/\breboot\b(?![-=])/);
    const systemctl = [...script.matchAll(/\bsystemctl\s+([a-z-]+)/g)].map((m) => m[1]);
    expect(systemctl).toEqual(['is-enabled']);
    // the only apt-get call is the -s (simulate) one
    const aptGet = script.split('\n').filter((l) => /apt-get\s/.test(l) && !l.includes('command -v apt-get'));
    expect(aptGet.map((l) => l.trim())).toEqual([
      'if SIM=$($T apt-get -s -o Debug::NoLocking=true dist-upgrade 2>/dev/null); then',
    ]);
    // nothing is redirected into a file: only /dev/null and stderr→stdout
    const redirects = script.replace(/[12]?>\/dev\/null/g, '').replace(/2>&1/g, '');
    expect(redirects).not.toContain('>');
  });

  it('bounds the slow apt commands with a timeout', () => {
    expect(script).toContain('T="timeout 30"');
    expect(script).toContain('$T /usr/lib/update-notifier/apt-check');
    expect(script).toContain('$T apt-get -s');
  });

  it('prints apt=no and nothing else on a host without apt', () => {
    // `command` and `echo` are builtins, so the script still runs with apt-get out of PATH
    const res = spawnSync('bash', ['-c', `PATH=/nonexistent\n${script}`]);
    if (res.error) return;
    expect(String(res.stdout)).toBe('PUSHIFY_PATCH apt=no\n');
  });
});

describe('parseAptCheckOutput', () => {
  it('reads pending;security', () => {
    expect(parseAptCheckOutput('12;5')).toEqual({ pending: 12, security: 5 });
    expect(parseAptCheckOutput('0;0\n')).toEqual({ pending: 0, security: 0 });
  });

  it('rejects errors and tracebacks', () => {
    expect(parseAptCheckOutput('')).toBeNull();
    expect(parseAptCheckOutput('E: Error: BrokenCount > 0')).toBeNull();
    expect(parseAptCheckOutput("ModuleNotFoundError: No module named 'apt_pkg'")).toBeNull();
  });
});

describe('countSimulatedUpgrades', () => {
  it('counts Inst lines and the ones from a security pocket (Ubuntu and Debian)', () => {
    const lines = [
      'Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])',
      'Inst openssl [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64]) []',
      'Inst tzdata [2024a-0ubuntu0.22.04] (2024a-0ubuntu0.22.04.1 Ubuntu:22.04/jammy-updates [all])',
      'Inst linux-image-5.15.0-91-generic (5.15.0-91.101 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])',
      'Conf libssl3 (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])',
    ];
    expect(countSimulatedUpgrades(lines)).toEqual({ pending: 4, security: 3 });
  });

  it('does not take a package name with "security" in it for a security update', () => {
    expect(
      countSimulatedUpgrades(['Inst python3-security-tool [1.0] (1.1 Debian:12.5/stable [all])'])
    ).toEqual({ pending: 1, security: 0 });
  });
});

describe('parsePatchStatusOutput', () => {
  it('reads an Ubuntu host with apt-check, a pending reboot and unattended-upgrades on', () => {
    const r = parsePatchStatusOutput(
      'Welcome to Ubuntu\n' +
        out(
          'apt=yes',
          'aptcheck=14;6',
          'reboot=yes',
          'uu_installed=yes',
          'uu_periodic=1',
          'uu_timer=enabled',
          'uu_last=1761300000',
          'uu_last=1761350000'
        ),
      NOW
    );
    expect(r).toEqual({
      pending: 14,
      security: 6,
      rebootRequired: true,
      unattendedUpgrades: { enabled: true, lastRunAt: new Date(1761350000 * 1000).toISOString() },
      checkedAt: '2026-10-25T12:00:00.000Z',
    });
  });

  it('reads a Debian host from the apt simulation', () => {
    const r = parsePatchStatusOutput(
      out(
        'apt=yes',
        'sim=ok',
        'inst=Inst openssl [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64]) []',
        'inst=Inst tzdata [2024a-0+deb12u1] (2025b-0+deb12u1 Debian:12.11/stable [all])',
        'reboot=no',
        'uu_installed=no',
        'uu_periodic=',
        'uu_timer=enabled'
      ),
      NOW
    );
    expect(r).toMatchObject({
      pending: 2,
      security: 1,
      rebootRequired: false,
      unattendedUpgrades: { enabled: false, lastRunAt: null },
    });
  });

  it('reports zero updates when the simulation ran and had nothing to install', () => {
    const r = parsePatchStatusOutput(out('apt=yes', 'sim=ok', 'reboot=no'), NOW);
    expect(r).toMatchObject({ pending: 0, security: 0, rebootRequired: false });
  });

  it('keeps the counts unknown when neither apt-check nor the simulation answered', () => {
    const r = parsePatchStatusOutput(out('apt=yes', 'reboot=no', 'uu_installed=yes', 'uu_periodic=1'), NOW);
    expect(r).toMatchObject({
      pending: 'unknown',
      security: 'unknown',
      rebootRequired: false,
      unattendedUpgrades: { enabled: true },
    });
  });

  it('treats unattended-upgrades as off when APT::Periodic disables it or its timer is off', () => {
    const base = ['apt=yes', 'sim=ok', 'reboot=no', 'uu_installed=yes'];
    expect(parsePatchStatusOutput(out(...base, 'uu_periodic=0'), NOW).unattendedUpgrades.enabled).toBe(false);
    expect(parsePatchStatusOutput(out(...base, 'uu_periodic='), NOW).unattendedUpgrades.enabled).toBe(false);
    expect(
      parsePatchStatusOutput(out(...base, 'uu_periodic=1', 'uu_timer=masked'), NOW).unattendedUpgrades.enabled
    ).toBe(false);
    expect(
      parsePatchStatusOutput(out(...base, 'uu_periodic=always', 'uu_timer='), NOW).unattendedUpgrades.enabled
    ).toBe(true);
  });

  it('returns unknown on a distro without apt', () => {
    expect(parsePatchStatusOutput(out('apt=no'), NOW)).toEqual(UNKNOWN);
  });

  it('returns unknown on output without the marker', () => {
    expect(parsePatchStatusOutput('', NOW)).toEqual(UNKNOWN);
    expect(parsePatchStatusOutput('bash: apt-get: command not found\n', NOW)).toEqual(UNKNOWN);
  });

  it('ignores garbage values and CRLF line endings', () => {
    const r = parsePatchStatusOutput(
      out('apt=yes', 'aptcheck=oops', 'reboot=maybe', 'uu_last=yesterday').replace(/\n/g, '\r\n'),
      NOW
    );
    expect(r).toEqual(UNKNOWN);
  });
});

describe('checkServerPatchStatus', () => {
  it('runs the script once and parses its output', async () => {
    const commands: string[] = [];
    const ssh = {
      exec: async (cmd: string) => {
        commands.push(cmd);
        return { code: 0, stdout: out('apt=yes', 'aptcheck=3;1', 'reboot=no'), stderr: '' };
      },
    } as unknown as SSHClient;
    await expect(checkServerPatchStatus(ssh, NOW)).resolves.toMatchObject({ pending: 3, security: 1, rebootRequired: false });
    expect(commands).toEqual([buildPatchStatusScript()]);
  });

  it('never throws', async () => {
    const ssh = { exec: async () => { throw new Error('boom'); } } as unknown as SSHClient;
    await expect(checkServerPatchStatus(ssh, NOW)).resolves.toEqual(UNKNOWN);
  });
});
