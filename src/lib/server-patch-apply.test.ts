import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  applySecurityPatches,
  buildAptInstallCommand,
  buildAptInstallSimulationCommand,
  buildDnfRecheckScript,
  buildDnfSecurityUpgradeCommand,
  buildPatchPrepareScript,
  describePatchRun,
  isExcludedPackage,
  parseDnfRecheckOutput,
  parsePatchPrepareOutput,
  PatchApplyError,
  selectAptSecurityPackages,
  tailOutput,
  type PatchApplyResult,
} from './server-patch-apply';
import type { ExecResult, SSHClient } from '../utils/ssh';

const M = 'PUSHIFY_PATCH_APPLY';
const out = (...lines: string[]) => lines.map((l) => `${M} ${l}`).join('\n') + '\n';

const INST = {
  libssl: 'Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])',
  openssl: 'Inst openssl [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64]) []',
  curl: 'Inst curl [7.81.0-1ubuntu1.14] (7.81.0-1ubuntu1.15 Ubuntu:22.04/jammy-updates [amd64])',
  containerd: 'Inst containerd [1.7.2-0ubuntu1~22.04.1] (1.7.12-0ubuntu2~22.04.1 Ubuntu:22.04/jammy-security [amd64])',
  dockerio: 'Inst docker.io [24.0.5-0ubuntu1~22.04.1] (24.0.7-0ubuntu2~22.04.1 Ubuntu:22.04/jammy-security [amd64])',
  runc: 'Inst runc [1.1.7-0ubuntu1~22.04.1] (1.1.12-0ubuntu2~22.04.1 Ubuntu:22.04/jammy-security [amd64])',
  libc32: 'Inst libc6:i386 [2.35-0ubuntu3.4] (2.35-0ubuntu3.5 Ubuntu:22.04/jammy-security [i386])',
  newKernel: 'Inst linux-image-5.15.0-91-generic (5.15.0-91.101 Ubuntu:22.04/jammy-security [amd64])',
};

function bashSyntaxOk(script: string): boolean | null {
  const res = spawnSync('bash', ['-n'], { input: script });
  if (res.error) return null; // no bash on this machine
  return res.status === 0;
}

/** No command that reboots or powers off the server, whatever the run does. */
function expectNoReboot(script: string) {
  expect(script).not.toMatch(/\b(reboot|shutdown|poweroff|halt)\b/);
  expect(script).not.toMatch(/systemctl\s+(reboot|poweroff|kexec|restart)/);
  expect(script).not.toMatch(/init\s+6/);
}

describe('excluded packages', () => {
  it.each(['docker-ce', 'docker-ce-cli', 'docker.io', 'docker-compose-plugin', 'docker-buildx-plugin', 'containerd', 'containerd.io', 'runc', 'moby-engine', 'containerd.io:amd64'])(
    '%s is never upgraded',
    (name) => expect(isExcludedPackage(name)).toBe(true)
  );

  it.each(['openssl', 'libssl3', 'runc-tools', 'libdocker-perl', 'curl'])('%s is', (name) =>
    expect(isExcludedPackage(name)).toBe(false)
  );
});

describe('buildPatchPrepareScript', () => {
  const script = buildPatchPrepareScript();

  it('is valid shell', () => {
    const ok = bashSyntaxOk(script);
    if (ok !== null) expect(ok).toBe(true);
  });

  it('refreshes the lists and only simulates: nothing is installed or rebooted', () => {
    expect(script).toContain('apt-get -q update');
    expect(script).toContain('apt-get -s -o Debug::NoLocking=true dist-upgrade');
    expect(script).not.toMatch(/apt-get\s+(-y|install|upgrade|dist-upgrade|full-upgrade|remove|purge)/);
    expect(script).not.toMatch(/dnf\s+(-y|upgrade|install)/);
    expectNoReboot(script);
  });

  it('bounds apt-get update with a timeout', () => {
    expect(script).toContain('T="timeout 300"');
    expect(script).toContain('$T apt-get -q update');
  });

  it('reports pm=none on a host with neither apt nor dnf', () => {
    // `.`, `command` and `echo` are builtins, so the script still runs with everything out of PATH
    const res = spawnSync('bash', ['-c', `PATH=/nonexistent\n${script}`]);
    if (res.error) return;
    const parsed = parsePatchPrepareOutput(String(res.stdout));
    expect(parsed.packageManager).toBeNull();
    expect(String(res.stdout)).toContain(`${M} pm=none`);
  });
});

describe('parsePatchPrepareOutput', () => {
  it('reads the os, package manager, update result and Inst lines', () => {
    expect(
      parsePatchPrepareOutput(
        out('os=ubuntu', 'pm=apt', 'update=failed', 'err=E: Failed to fetch https://repo.example/x', 'sim=ok', `inst=${INST.libssl}`, `inst=${INST.curl}`)
      )
    ).toEqual({
      os: 'ubuntu',
      packageManager: 'apt',
      updateOk: false,
      updateErrors: ['E: Failed to fetch https://repo.example/x'],
      simulated: true,
      instLines: [INST.libssl, INST.curl],
    });
  });

  it('does not trust an odd os id', () => {
    expect(parsePatchPrepareOutput(out('os=$(rm -rf /)', 'pm=none')).os).toBe('unknown');
    expect(parsePatchPrepareOutput(out('os=alpine', 'pm=none'))).toMatchObject({ os: 'alpine', packageManager: null });
  });
});

describe('selectAptSecurityPackages', () => {
  it('picks upgrades from a security pocket, keeps Docker/containerd out', () => {
    expect(selectAptSecurityPackages(Object.values(INST))).toEqual({
      packages: ['libssl3', 'openssl', 'libc6:i386'],
      excluded: ['containerd', 'docker.io', 'runc'],
    });
  });

  it('drops anything that is not a plain package name', () => {
    expect(
      selectAptSecurityPackages(['Inst foo;reboot [1] (2 Debian-Security:12/stable-security [amd64])', 'Inst $(id) [1] (2 x-security [amd64])'])
    ).toEqual({ packages: [], excluded: [] });
  });
});

describe('apt install commands', () => {
  const pkgs = ['libssl3', 'openssl', 'libc6:i386'];

  it('upgrades exactly the given packages, non-interactively, keeping local config files', () => {
    const cmd = buildAptInstallCommand(pkgs);
    expect(cmd).toContain('export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l');
    expect(cmd).toContain(
      '$T apt-get -y -q -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install --only-upgrade --no-install-recommends libssl3 openssl libc6:i386 2>&1'
    );
    expect(cmd).toContain('T="timeout 1800"');
    expect(cmd).not.toMatch(/dist-upgrade|full-upgrade|autoremove|--allow-change-held-packages/);
    expectNoReboot(cmd);
    const ok = bashSyntaxOk(cmd);
    if (ok !== null) expect(ok).toBe(true);
  });

  it('the dry run is the same install, simulated', () => {
    expect(buildAptInstallSimulationCommand(pkgs)).toBe(
      'apt-get -s -o Debug::NoLocking=true install --only-upgrade --no-install-recommends libssl3 openssl libc6:i386 2>&1'
    );
  });

  it.each([[[]], [['containerd.io']], [['docker-ce', 'openssl']], [['openssl;reboot']], [['$(id)']]])(
    'refuses %j',
    (bad) => {
      expect(() => buildAptInstallCommand(bad)).toThrow();
      expect(() => buildAptInstallSimulationCommand(bad)).toThrow();
    }
  );
});

describe('dnf commands', () => {
  it('upgrades security updates only, Docker/containerd excluded, non-interactively', () => {
    const cmd = buildDnfSecurityUpgradeCommand();
    expect(cmd).toContain(
      "$T dnf -y --refresh upgrade --security --exclude='docker*' --exclude='containerd*' --exclude='runc' --exclude='moby-*' 2>&1"
    );
    expectNoReboot(cmd);
    const ok = bashSyntaxOk(cmd);
    if (ok !== null) expect(ok).toBe(true);
  });

  it('the recheck only reads', () => {
    const script = buildDnfRecheckScript();
    expect(script).not.toMatch(/dnf\s+(-y|upgrade|install|remove)/);
    expectNoReboot(script);
    const ok = bashSyntaxOk(script);
    if (ok !== null) expect(ok).toBe(true);
  });

  it('counts the packages still under a security advisory and reads needs-restarting', () => {
    expect(
      parseDnfRecheckOutput(
        out(
          'advisories=ok',
          'adv=RHSA-2024:1234 Important/Sec.  openssl-libs-1:3.0.7-27.el9.x86_64',
          'adv=RHSA-2024:1234 Important/Sec.  openssl-1:3.0.7-27.el9.x86_64',
          'adv=RHSA-2024:2000 Moderate/Sec.   openssl-libs-1:3.0.7-27.el9.x86_64',
          'needs_restarting=Core libraries or services have been updated since boot-up: * kernel  Reboot is required to fully utilize these updates. '
        )
      )
    ).toEqual({ security: 2, rebootRequired: true });

    expect(
      parseDnfRecheckOutput(
        out('advisories=ok', 'needs_restarting=No core libraries or services have been updated since boot-up. Reboot should not be necessary. ')
      )
    ).toEqual({ security: 0, rebootRequired: false });

    // plugin missing: exit code 1 as well, so only the text counts
    expect(parseDnfRecheckOutput(out('needs_restarting=No such command: needs-restarting. '))).toEqual({
      security: 'unknown',
      rebootRequired: 'unknown',
    });
  });
});

/** SSH double answering each step of a run by what the command is. */
function fakeSsh(answers: {
  prepare: string;
  sim?: ExecResult;
  install?: ExecResult;
  status?: string;
  dnf?: ExecResult;
  dnfRecheck?: string;
}) {
  const calls: string[] = [];
  const ssh = {
    exec: async (cmd: string): Promise<ExecResult> => {
      calls.push(cmd);
      const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
      if (cmd.includes(`${M} os=`)) return ok(answers.prepare);
      if (cmd.startsWith('apt-get -s') && cmd.includes('install --only-upgrade')) return answers.sim ?? ok('');
      if (cmd.includes('apt-get -y')) return answers.install ?? ok('');
      if (cmd.includes('dnf -y')) return answers.dnf ?? ok('');
      if (cmd.includes('needs-restarting')) return ok(answers.dnfRecheck ?? '');
      if (cmd.includes('PUSHIFY_PATCH ')) return ok(answers.status ?? '');
      throw new Error(`unexpected command: ${cmd}`);
    },
  };
  return { ssh: ssh as unknown as SSHClient, calls };
}

const status = (...lines: string[]) => lines.map((l) => `PUSHIFY_PATCH ${l}`).join('\n') + '\n';

describe('applySecurityPatches', () => {
  it('apt: installs the security updates, then re-reads the patch status', async () => {
    const { ssh, calls } = fakeSsh({
      prepare: out('os=ubuntu', 'pm=apt', 'update=ok', 'sim=ok', `inst=${INST.libssl}`, `inst=${INST.curl}`, `inst=${INST.containerd}`),
      sim: { stdout: `${INST.libssl}\nConf libssl3 (3.0.2-0ubuntu1.12)\n`, stderr: '', code: 0 },
      install: { stdout: 'Setting up libssl3:amd64 (3.0.2-0ubuntu1.12) ...\n', stderr: '', code: 0 },
      status: status('apt=yes', 'aptcheck=2;1', 'reboot=yes'),
    });

    const result = await applySecurityPatches(ssh);
    expect(result).toEqual({
      os: 'ubuntu',
      packageManager: 'apt',
      packages: ['libssl3'],
      excluded: ['containerd'],
      remaining: { pending: 2, security: 1 },
      rebootRequired: true,
      output: 'Setting up libssl3:amd64 (3.0.2-0ubuntu1.12) ...',
      notes: [],
    });
    expect(calls).toHaveLength(4);
    expect(calls[2]).toContain('install --only-upgrade --no-install-recommends libssl3 2>&1');
    expect(describePatchRun(result)).toBe(
      'Installed 1 security update (apt); skipped containerd (Docker/containerd); 1 security / 2 total updates left; reboot required'
    );
  });

  it('apt: nothing to install runs no install, and a failed apt-get update is noted, not fatal', async () => {
    const { ssh, calls } = fakeSsh({
      prepare: out('os=debian', 'pm=apt', 'update=failed', 'err=E: Failed to fetch x', 'sim=ok', `inst=${INST.curl}`),
      status: status('apt=yes', 'sim=ok', `inst=${INST.curl}`, 'reboot=no'),
    });

    const result = await applySecurityPatches(ssh);
    expect(calls.some((c) => c.includes('apt-get -y'))).toBe(false);
    expect(result).toMatchObject({ packages: [], remaining: { pending: 1, security: 0 }, rebootRequired: false });
    expect(result.notes).toEqual(['apt-get update failed; the package lists already on the server were used\nE: Failed to fetch x']);
    expect(describePatchRun(result)).toBe('No security updates to install (apt); 0 security / 1 total updates left');
  });

  it('apt: installs nothing when the updates would drag in a Docker package', async () => {
    const { ssh, calls } = fakeSsh({
      prepare: out('os=ubuntu', 'pm=apt', 'update=ok', 'sim=ok', `inst=${INST.libssl}`),
      sim: { stdout: `${INST.libssl}\n${INST.containerd}\n`, stderr: '', code: 0 },
    });

    const err = await applySecurityPatches(ssh).catch((e) => e);
    expect(err).toBeInstanceOf(PatchApplyError);
    expect(err.code).toBe('DOCKER_DEPENDENCY');
    expect(err.message).toContain('containerd');
    expect(calls.some((c) => c.includes('apt-get -y'))).toBe(false);
  });

  it('apt: a failed install is an INSTALL_FAILED error carrying the output', async () => {
    const { ssh } = fakeSsh({
      prepare: out('os=ubuntu', 'pm=apt', 'update=ok', 'sim=ok', `inst=${INST.libssl}`),
      sim: { stdout: `${INST.libssl}\n`, stderr: '', code: 0 },
      install: { stdout: '', stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend\n', code: 100 },
    });

    const err = await applySecurityPatches(ssh).catch((e) => e);
    expect(err).toMatchObject({ code: 'INSTALL_FAILED', message: 'apt-get install exited with code 100' });
    expect(err.output).toContain('Could not get lock');
  });

  it('dnf: security upgrade, then advisories and needs-restarting', async () => {
    const { ssh, calls } = fakeSsh({
      prepare: out('os=almalinux', 'pm=dnf'),
      dnf: { stdout: 'Upgraded:\n  openssl-libs-1:3.0.7-27.el9.x86_64\nComplete!\n', stderr: '', code: 0 },
      dnfRecheck: out('advisories=ok', 'needs_restarting=Reboot should not be necessary.'),
    });

    const result = await applySecurityPatches(ssh);
    expect(calls[1]).toContain('dnf -y --refresh upgrade --security');
    expect(result).toEqual({
      os: 'almalinux',
      packageManager: 'dnf',
      packages: [],
      excluded: [],
      remaining: { pending: 'unknown', security: 0 },
      rebootRequired: false,
      output: 'Upgraded:\n  openssl-libs-1:3.0.7-27.el9.x86_64\nComplete!',
      notes: [],
    });
    expect(describePatchRun(result)).toBe('Applied security updates with dnf; 0 security updates left');
  });

  it('any other OS fails with a clear UNSUPPORTED_OS error and runs nothing else', async () => {
    const { ssh, calls } = fakeSsh({ prepare: out('os=alpine', 'pm=none') });
    const err = await applySecurityPatches(ssh).catch((e) => e);
    expect(err).toBeInstanceOf(PatchApplyError);
    expect(err.code).toBe('UNSUPPORTED_OS');
    expect(err.message).toBe(
      'Unsupported OS "alpine": security updates can only be applied on Debian/Ubuntu (apt) or Fedora/RHEL-family (dnf) servers'
    );
    expect(calls).toHaveLength(1);
  });
});

describe('tailOutput', () => {
  it('keeps the end, cut at a line start', () => {
    expect(tailOutput('aaaa\nbbbb\ncccc', 9)).toBe('cccc');
    expect(tailOutput('short\r\n', 100)).toBe('short');
  });
});

describe('describePatchRun', () => {
  it('leaves out what is unknown', () => {
    const result: PatchApplyResult = {
      os: 'ubuntu',
      packageManager: 'apt',
      packages: ['a', 'b'],
      excluded: [],
      remaining: { pending: 'unknown', security: 'unknown' },
      rebootRequired: 'unknown',
      output: '',
      notes: [],
    };
    expect(describePatchRun(result)).toBe('Installed 2 security updates (apt)');
  });
});
