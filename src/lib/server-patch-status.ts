import type { SSHClient } from '../utils/ssh';

/**
 * OS patch status of a deployment server (Debian / Ubuntu), part of the server health report.
 *
 * Read-only: nothing is installed, upgraded or written. There is no `apt update` either — the
 * counts come from the package lists already on the server (refreshed by the distro's own
 * apt-daily timer), so they are as fresh as that cache. Ubuntu's `apt-check` (update-notifier)
 * is used when present; otherwise a simulated `apt-get -s dist-upgrade`, which is what apt-check
 * counts as well. Anything that cannot be read — another distro, a missing tool, a failed or
 * timed-out command — is reported as `unknown` instead of failing the health report.
 */

export const PATCH_MARKER = 'PUSHIFY_PATCH';

/** Upper bound for apt-check / the apt simulation, which read the whole package cache. */
export const PATCH_COMMAND_TIMEOUT_SECONDS = 30;

export const APT_CHECK_PATH = '/usr/lib/update-notifier/apt-check';

/** Written by apt.systemd.daily after it ran unattended-upgrade, and the log of that run. */
export const UNATTENDED_UPGRADES_RUN_FILES = [
  '/var/lib/apt/periodic/unattended-upgrades-stamp',
  '/var/log/unattended-upgrades/unattended-upgrades.log',
] as const;

export type PatchUnknown = 'unknown';

export interface ServerPatchStatus {
  /** Packages with a newer version in the local apt cache */
  pending: number | PatchUnknown;
  /** Of those, how many come from a security pocket */
  security: number | PatchUnknown;
  /** `/var/run/reboot-required` exists */
  rebootRequired: boolean | PatchUnknown;
  unattendedUpgrades: {
    /** Installed, enabled in APT::Periodic and its timer not disabled */
    enabled: boolean | PatchUnknown;
    /** Last time unattended-upgrades ran (ISO), null when it never did or it is not known */
    lastRunAt: string | null;
  };
  checkedAt: string;
}

export function unknownPatchStatus(now: Date = new Date()): ServerPatchStatus {
  return {
    pending: 'unknown',
    security: 'unknown',
    rebootRequired: 'unknown',
    unattendedUpgrades: { enabled: 'unknown', lastRunAt: null },
    checkedAt: now.toISOString(),
  };
}

/**
 * Shell run over SSH. Prints one `PUSHIFY_PATCH key=value` line per fact:
 *   apt=yes|no                       Debian family (apt-get + dpkg-query); nothing else on `no`
 *   aptcheck=<pending>;<security>    apt-check output, when it is installed and answered
 *   sim=ok + inst=<Inst line>…       apt-get simulation otherwise (one line per package)
 *   reboot=yes|no
 *   uu_installed=yes|no  uu_periodic=<APT::Periodic::Unattended-Upgrade>  uu_timer=<is-enabled>
 *   uu_last=<epoch seconds>          mtime of each unattended-upgrades run file that exists
 */
export function buildPatchStatusScript(): string {
  const out = (line: string) => `echo "${PATCH_MARKER} ${line}"`;
  return [
    'if command -v apt-get >/dev/null 2>&1 && command -v dpkg-query >/dev/null 2>&1; then',
    `  ${out('apt=yes')}`,
    '  T=""',
    `  command -v timeout >/dev/null 2>&1 && T="timeout ${PATCH_COMMAND_TIMEOUT_SECONDS}"`,
    '  AC=""',
    // apt-check prints "<pending>;<security>" on stderr
    `  if [ -x ${APT_CHECK_PATH} ]; then AC=$($T ${APT_CHECK_PATH} 2>&1 | tail -n 1); fi`,
    '  case "$AC" in',
    `    [0-9]*';'[0-9]*) ${out('aptcheck=$AC')} ;;`,
    '    *)',
    // -s only simulates; NoLocking so a running apt/unattended-upgrades does not make it fail
    '      if SIM=$($T apt-get -s -o Debug::NoLocking=true dist-upgrade 2>/dev/null); then',
    `        ${out('sim=ok')}`,
    `        printf '%s\\n' "$SIM" | grep '^Inst ' | sed 's/^/${PATCH_MARKER} inst=/'`,
    '      fi',
    '      ;;',
    '  esac',
    `  if [ -e /var/run/reboot-required ]; then ${out('reboot=yes')}; else ${out('reboot=no')}; fi`,
    '  UU=no',
    "  dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q 'ok installed' && UU=yes",
    `  ${out('uu_installed=$UU')}`,
    `  UUP=$(apt-config dump 2>/dev/null | sed -n 's/^APT::Periodic::Unattended-Upgrade "\\(.*\\)";$/\\1/p' | tail -n 1)`,
    `  ${out('uu_periodic=$UUP')}`,
    '  if command -v systemctl >/dev/null 2>&1; then',
    `    ${out('uu_timer=$(systemctl is-enabled apt-daily-upgrade.timer 2>/dev/null)')}`,
    '  fi',
    `  for f in ${UNATTENDED_UPGRADES_RUN_FILES.join(' ')}; do`,
    `    s=$(stat -c %Y "$f" 2>/dev/null) && ${out('uu_last=$s')}`,
    '  done',
    'else',
    `  ${out('apt=no')}`,
    'fi',
  ].join('\n');
}

/** `apt-check` output: `<pending>;<security>`. Null when it is anything else (an error, a traceback). */
export function parseAptCheckOutput(raw: string): { pending: number; security: number } | null {
  const match = raw.trim().match(/^(\d+);(\d+)(?:;\d+)*$/);
  if (!match) return null;
  return { pending: parseInt(match[1], 10), security: parseInt(match[2], 10) };
}

/**
 * Count the `Inst` lines of `apt-get -s dist-upgrade`. A package is a security update when one of
 * the origins it would come from is a security pocket, e.g.
 *   Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])
 *   Inst openssl [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64]) []
 */
export function countSimulatedUpgrades(lines: string[]): { pending: number; security: number } {
  let pending = 0;
  let security = 0;
  for (const line of lines) {
    if (!line.startsWith('Inst ')) continue;
    pending++;
    const origins = line.match(/\(([^)]*)\)/)?.[1] ?? '';
    if (/security/i.test(origins)) security++;
  }
  return { pending, security };
}

function unattendedUpgradesEnabled(
  installed: string | undefined,
  periodic: string | undefined,
  timer: string | undefined
): boolean | PatchUnknown {
  if (installed === 'no') return false;
  if (installed !== 'yes' || periodic === undefined) return 'unknown';
  // APT::Periodic::Unattended-Upgrade is an interval in days ("always" in newer apt); unset or 0 is off
  if (periodic === '' || /^0+$/.test(periodic)) return false;
  // On systemd hosts apt.systemd.daily only runs from this timer
  if (timer === 'disabled' || timer === 'masked') return false;
  return true;
}

export function parsePatchStatusOutput(stdout: string, now: Date = new Date()): ServerPatchStatus {
  const status = unknownPatchStatus(now);
  const fields = new Map<string, string[]>();
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith(`${PATCH_MARKER} `)) continue;
    const rest = line.slice(PATCH_MARKER.length + 1);
    const eq = rest.indexOf('=');
    if (eq <= 0) continue;
    const key = rest.slice(0, eq);
    const values = fields.get(key) ?? [];
    values.push(rest.slice(eq + 1).trim());
    fields.set(key, values);
  }
  const first = (key: string) => fields.get(key)?.[0];

  if (first('apt') !== 'yes') return status;

  const counts =
    parseAptCheckOutput(first('aptcheck') ?? '') ??
    (first('sim') === 'ok' ? countSimulatedUpgrades(fields.get('inst') ?? []) : null);
  if (counts) {
    status.pending = counts.pending;
    status.security = counts.security;
  }

  const reboot = first('reboot');
  if (reboot === 'yes' || reboot === 'no') status.rebootRequired = reboot === 'yes';

  status.unattendedUpgrades.enabled = unattendedUpgradesEnabled(
    first('uu_installed'),
    first('uu_periodic'),
    first('uu_timer')
  );

  const lastRun = Math.max(
    0,
    ...(fields.get('uu_last') ?? []).map((v) => (/^\d+$/.test(v) ? parseInt(v, 10) : 0))
  );
  if (lastRun > 0) status.unattendedUpgrades.lastRunAt = new Date(lastRun * 1000).toISOString();

  return status;
}

/** Read the patch status of a server. Never throws: a failed check must not break the health report. */
export async function checkServerPatchStatus(
  ssh: SSHClient,
  now: Date = new Date()
): Promise<ServerPatchStatus> {
  try {
    const result = await ssh.exec(buildPatchStatusScript());
    return parsePatchStatusOutput(result.stdout ?? '', now);
  } catch {
    return unknownPatchStatus(now);
  }
}
