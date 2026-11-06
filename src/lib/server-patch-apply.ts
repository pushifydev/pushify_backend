import type { SSHClient } from '../utils/ssh';
import { checkServerPatchStatus, type PatchUnknown } from './server-patch-status';

/**
 * Apply the pending OS security updates of a deployment server (connected BYOS and managed alike).
 * Runs in the server-patches worker (POST /servers/:serverId/patches/apply), never in a request.
 *
 * - Security updates only. apt: the packages whose new version comes from a security pocket, the
 *   same rule the health report counts with (server-patch-status.ts), after an `apt-get update`.
 *   dnf: `upgrade --security`.
 * - Non-interactive: DEBIAN_FRONTEND=noninteractive, changed config files keep the local version,
 *   needrestart is suspended so it restarts no service on its own.
 * - Docker / containerd / runc are left alone: upgrading them restarts the daemon and with it every
 *   running container. On apt a run that would pull one in as a dependency installs nothing.
 * - Never reboots. Whether the server now needs one is part of the result.
 * - Any other OS fails with UNSUPPORTED_OS.
 */

export const PATCH_APPLY_MARKER = 'PUSHIFY_PATCH_APPLY';

/** `apt-get update` reads every configured repository. */
export const APT_UPDATE_TIMEOUT_SECONDS = 300;
/** The install itself (apt-get install / dnf upgrade). */
export const PATCH_INSTALL_TIMEOUT_SECONDS = 1800;
/** How long apt waits for the dpkg lock (e.g. unattended-upgrades running) before giving up. */
export const PACKAGE_LOCK_WAIT_SECONDS = 300;
/** dnf updateinfo / needs-restarting after the run. */
export const PATCH_RECHECK_TIMEOUT_SECONDS = 120;
/** Package manager output kept for the timeline and the audit log. */
export const PATCH_OUTPUT_MAX_CHARS = 4000;

/** Packages never upgraded by a run: upgrading them restarts Docker and every running container. */
export const EXCLUDED_PACKAGE_GLOBS = ['docker*', 'containerd*', 'runc', 'moby-*'] as const;

const EXCLUDED_PACKAGE_RE = new RegExp(
  `^(${EXCLUDED_PACKAGE_GLOBS.map((g) => g.replace(/[.+]/g, '\\$&').replace(/\*/g, '.*')).join('|')})$`
);

/** Debian package name, optionally with its architecture (`libc6:i386`). Anything else never reaches a command line. */
const APT_PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9-]+)?$/;

export type PackageManager = 'apt' | 'dnf';

export type PatchApplyErrorCode = 'UNSUPPORTED_OS' | 'DOCKER_DEPENDENCY' | 'INSTALL_FAILED' | 'SSH_UNAVAILABLE';

export class PatchApplyError extends Error {
  constructor(
    public readonly code: PatchApplyErrorCode,
    message: string,
    /** Tail of the package manager output, when there is one */
    public readonly output: string = ''
  ) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

export interface PatchApplyResult {
  /** `ID` from /etc/os-release */
  os: string;
  packageManager: PackageManager;
  /** apt: the packages that were upgraded. dnf picks them itself, so it stays empty there. */
  packages: string[];
  /** apt: security updates skipped because they are Docker / containerd packages */
  excluded: string[];
  /** Updates still pending after the run (excluded packages included) */
  remaining: { pending: number | PatchUnknown; security: number | PatchUnknown };
  rebootRequired: boolean | PatchUnknown;
  /** Tail of the package manager output */
  output: string;
  /** Things worth knowing that did not stop the run */
  notes: string[];
}

export function isExcludedPackage(name: string): boolean {
  return EXCLUDED_PACKAGE_RE.test(name.replace(/:.*$/, ''));
}

/** Last `max` characters of a command's output, cut at a line start. */
export function tailOutput(text: string, max: number = PATCH_OUTPUT_MAX_CHARS): string {
  const trimmed = text.replace(/\r/g, '').trim();
  if (trimmed.length <= max) return trimmed;
  const tail = trimmed.slice(-max);
  const nl = tail.indexOf('\n');
  return nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
}

function timeoutVar(seconds: number): string {
  return `T=""; command -v timeout >/dev/null 2>&1 && T="timeout ${seconds}"`;
}

/**
 * First step, run over SSH. Prints one `PUSHIFY_PATCH_APPLY key=value` line per fact:
 *   os=<ID from /etc/os-release>
 *   pm=apt|dnf|none
 *   apt only: update=ok|failed (+ err=<line>), then sim=ok + inst=<Inst line>… from a simulated
 *   dist-upgrade on the refreshed lists (nothing is installed by this step).
 */
export function buildPatchPrepareScript(): string {
  const out = (line: string) => `echo "${PATCH_APPLY_MARKER} ${line}"`;
  return [
    'OS=$( (. /etc/os-release 2>/dev/null; echo "${ID:-unknown}") )',
    `${out('os=$OS')}`,
    'if command -v apt-get >/dev/null 2>&1 && command -v dpkg-query >/dev/null 2>&1; then',
    `  ${out('pm=apt')}`,
    `  ${timeoutVar(APT_UPDATE_TIMEOUT_SECONDS)}`,
    '  if UP=$($T apt-get -q update 2>&1); then',
    `    ${out('update=ok')}`,
    '  else',
    `    ${out('update=failed')}`,
    `    printf '%s\\n' "$UP" | grep -E '^(E|W|Err):' | tail -n 5 | sed 's/^/${PATCH_APPLY_MARKER} err=/'`,
    '  fi',
    '  if SIM=$($T apt-get -s -o Debug::NoLocking=true dist-upgrade 2>/dev/null); then',
    `    ${out('sim=ok')}`,
    `    printf '%s\\n' "$SIM" | grep '^Inst ' | sed 's/^/${PATCH_APPLY_MARKER} inst=/'`,
    '  fi',
    'elif command -v dnf >/dev/null 2>&1; then',
    `  ${out('pm=dnf')}`,
    'else',
    `  ${out('pm=none')}`,
    'fi',
  ].join('\n');
}

export interface PatchPrepareOutput {
  os: string;
  packageManager: PackageManager | null;
  updateOk: boolean;
  updateErrors: string[];
  simulated: boolean;
  instLines: string[];
}

function markerFields(stdout: string, marker: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith(`${marker} `)) continue;
    const rest = line.slice(marker.length + 1);
    const eq = rest.indexOf('=');
    if (eq <= 0) continue;
    const key = rest.slice(0, eq);
    const values = fields.get(key) ?? [];
    values.push(rest.slice(eq + 1).trim());
    fields.set(key, values);
  }
  return fields;
}

export function parsePatchPrepareOutput(stdout: string): PatchPrepareOutput {
  const fields = markerFields(stdout, PATCH_APPLY_MARKER);
  const first = (key: string) => fields.get(key)?.[0];
  const os = first('os') ?? '';
  const pm = first('pm');
  return {
    os: /^[a-z0-9._-]{1,40}$/.test(os) ? os : 'unknown',
    packageManager: pm === 'apt' || pm === 'dnf' ? pm : null,
    updateOk: first('update') === 'ok',
    updateErrors: fields.get('err') ?? [],
    simulated: first('sim') === 'ok',
    instLines: fields.get('inst') ?? [],
  };
}

/**
 * The security updates of a simulated `apt-get -s dist-upgrade`: `Inst` lines of an installed
 * package (`[old version]`) whose new version comes from a security pocket, e.g.
 *   Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
 * Docker / containerd packages go to `excluded`; names that are not plain package names are dropped.
 */
export function selectAptSecurityPackages(instLines: string[]): { packages: string[]; excluded: string[] } {
  const packages = new Set<string>();
  const excluded = new Set<string>();
  for (const line of instLines) {
    const match = line.match(/^Inst (\S+) \[[^\]]*\] \(([^)]*)\)/);
    if (!match) continue;
    const [, name, origins] = match;
    if (!/security/i.test(origins) || !APT_PACKAGE_NAME_RE.test(name)) continue;
    (isExcludedPackage(name) ? excluded : packages).add(name);
  }
  return { packages: [...packages], excluded: [...excluded] };
}

/** Names of the packages an apt simulation would install or upgrade. */
export function simulatedPackageNames(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.match(/^Inst (\S+)/)?.[1])
    .filter((n): n is string => !!n);
}

const APT_ENV =
  'export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l APT_LISTCHANGES_FRONTEND=none';

function assertAptPackages(packages: string[]): void {
  if (packages.length === 0) throw new Error('No packages to upgrade');
  for (const p of packages) {
    if (!APT_PACKAGE_NAME_RE.test(p)) throw new Error(`Invalid package name: ${p}`);
    if (isExcludedPackage(p)) throw new Error(`Excluded package: ${p}`);
  }
}

/** Dry run of exactly the install below, to see what it would drag in as dependencies. */
export function buildAptInstallSimulationCommand(packages: string[]): string {
  assertAptPackages(packages);
  return `apt-get -s -o Debug::NoLocking=true install --only-upgrade --no-install-recommends ${packages.join(' ')} 2>&1`;
}

/** Upgrade exactly these packages, non-interactively, keeping local config files. */
export function buildAptInstallCommand(packages: string[]): string {
  assertAptPackages(packages);
  return [
    APT_ENV,
    timeoutVar(PATCH_INSTALL_TIMEOUT_SECONDS),
    `$T apt-get -y -q -o DPkg::Lock::Timeout=${PACKAGE_LOCK_WAIT_SECONDS} -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install --only-upgrade --no-install-recommends ${packages.join(' ')} 2>&1`,
  ].join('\n');
}

/** Security updates through dnf, Docker / containerd excluded. */
export function buildDnfSecurityUpgradeCommand(): string {
  const excludes = EXCLUDED_PACKAGE_GLOBS.map((g) => `--exclude='${g}'`).join(' ');
  return [
    timeoutVar(PATCH_INSTALL_TIMEOUT_SECONDS),
    `$T dnf -y --refresh upgrade --security ${excludes} 2>&1`,
  ].join('\n');
}

/**
 * After a dnf run: the security advisories still open (`adv=` lines) and what needs-restarting says
 * about a reboot (its text, since its exit code is also 1 when the plugin is missing).
 */
export function buildDnfRecheckScript(): string {
  const out = (line: string) => `echo "${PATCH_APPLY_MARKER} ${line}"`;
  return [
    timeoutVar(PATCH_RECHECK_TIMEOUT_SECONDS),
    'if ADV=$($T dnf -q updateinfo list --security 2>/dev/null); then',
    `  ${out('advisories=ok')}`,
    `  printf '%s\\n' "$ADV" | sed 's/^/${PATCH_APPLY_MARKER} adv=/'`,
    'fi',
    `NR=$($T dnf needs-restarting -r 2>&1 | tr '\\n' ' ')`,
    `${out('needs_restarting=$NR')}`,
  ].join('\n');
}

const RPM_ARCH_RE = /\.(x86_64|aarch64|noarch|i686|ppc64le|s390x)$/;

export function parseDnfRecheckOutput(stdout: string): {
  security: number | PatchUnknown;
  rebootRequired: boolean | PatchUnknown;
} {
  const fields = markerFields(stdout, PATCH_APPLY_MARKER);
  let security: number | PatchUnknown = 'unknown';
  if (fields.get('advisories')?.[0] === 'ok') {
    // `RHSA-2024:1234 Important/Sec. openssl-libs-1:3.0.7-27.el9.x86_64`: count distinct packages
    const pkgs = new Set<string>();
    for (const line of fields.get('adv') ?? []) {
      for (const token of line.split(/\s+/).slice(1)) if (RPM_ARCH_RE.test(token)) pkgs.add(token);
    }
    security = pkgs.size;
  }
  const nr = fields.get('needs_restarting')?.[0] ?? '';
  const rebootRequired = /reboot is required/i.test(nr) ? true : /reboot should not be necessary/i.test(nr) ? false : 'unknown';
  return { security, rebootRequired };
}

function exitMessage(code: number, what: string): string {
  return code === 124 ? `${what} timed out after ${PATCH_INSTALL_TIMEOUT_SECONDS}s` : `${what} exited with code ${code}`;
}

/** Apply the security updates over an open SSH connection. Throws PatchApplyError on a failed run. */
export async function applySecurityPatches(ssh: SSHClient): Promise<PatchApplyResult> {
  const prepared = parsePatchPrepareOutput((await ssh.exec(buildPatchPrepareScript())).stdout ?? '');

  if (!prepared.packageManager) {
    throw new PatchApplyError(
      'UNSUPPORTED_OS',
      `Unsupported OS "${prepared.os}": security updates can only be applied on Debian/Ubuntu (apt) or Fedora/RHEL-family (dnf) servers`
    );
  }

  if (prepared.packageManager === 'dnf') {
    const run = await ssh.exec(buildDnfSecurityUpgradeCommand());
    const output = tailOutput(run.stdout ?? '');
    if (run.code !== 0) throw new PatchApplyError('INSTALL_FAILED', exitMessage(run.code, 'dnf upgrade --security'), output);
    const recheck = parseDnfRecheckOutput((await ssh.exec(buildDnfRecheckScript())).stdout ?? '');
    return {
      os: prepared.os,
      packageManager: 'dnf',
      packages: [],
      excluded: [],
      remaining: { pending: 'unknown', security: recheck.security },
      rebootRequired: recheck.rebootRequired,
      output,
      notes: [],
    };
  }

  const notes: string[] = [];
  if (!prepared.updateOk) {
    notes.push(
      ['apt-get update failed; the package lists already on the server were used', ...prepared.updateErrors].join('\n')
    );
  }
  if (!prepared.simulated) {
    throw new PatchApplyError('INSTALL_FAILED', 'apt-get could not compute the pending upgrades (simulation failed)');
  }

  const { packages, excluded } = selectAptSecurityPackages(prepared.instLines);
  let output = 'No security updates to install.';

  if (packages.length > 0) {
    const sim = await ssh.exec(buildAptInstallSimulationCommand(packages));
    const simOutput = `${sim.stdout ?? ''}${sim.stderr ?? ''}`;
    if (sim.code !== 0) {
      throw new PatchApplyError('INSTALL_FAILED', exitMessage(sim.code, 'apt-get simulation'), tailOutput(simOutput));
    }
    const dragged = simulatedPackageNames(simOutput).filter(isExcludedPackage);
    if (dragged.length > 0) {
      throw new PatchApplyError(
        'DOCKER_DEPENDENCY',
        `Nothing was installed: these updates would also upgrade ${[...new Set(dragged)].join(', ')}, which restarts running containers`,
        tailOutput(simOutput)
      );
    }

    const run = await ssh.exec(buildAptInstallCommand(packages));
    output = tailOutput(`${run.stdout ?? ''}${run.stderr ?? ''}`);
    if (run.code !== 0) throw new PatchApplyError('INSTALL_FAILED', exitMessage(run.code, 'apt-get install'), output);
  }

  // The health report's patch check, now on the refreshed lists
  const after = await checkServerPatchStatus(ssh);
  return {
    os: prepared.os,
    packageManager: 'apt',
    packages,
    excluded,
    remaining: { pending: after.pending, security: after.security },
    rebootRequired: after.rebootRequired,
    output,
    notes,
  };
}

/** One line for the audit log and the server timeline. */
export function describePatchRun(result: PatchApplyResult): string {
  const parts: string[] = [];
  if (result.packageManager === 'dnf') {
    parts.push('Applied security updates with dnf');
  } else if (result.packages.length === 0) {
    parts.push('No security updates to install (apt)');
  } else {
    const n = result.packages.length;
    parts.push(`Installed ${n} security update${n === 1 ? '' : 's'} (apt)`);
  }
  if (result.excluded.length > 0) parts.push(`skipped ${result.excluded.join(', ')} (Docker/containerd)`);
  const { pending, security } = result.remaining;
  if (security !== 'unknown') {
    parts.push(pending !== 'unknown' ? `${security} security / ${pending} total updates left` : `${security} security updates left`);
  }
  if (result.rebootRequired === true) parts.push('reboot required');
  return parts.join('; ');
}
