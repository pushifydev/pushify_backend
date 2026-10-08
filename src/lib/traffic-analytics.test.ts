import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildTrafficAnalytics,
  buildTrafficCleanupCommand,
  buildTrafficCollectCommand,
  isTrafficAnalyticsEnabledFor,
  parseLogHour,
  parseTrafficCollectOutput,
  parseTrafficRange,
} from './traffic-analytics';
import { generateProjectSitesConfig, TRAFFIC_LOG_DIR, trafficLogLines } from '../workers/nginx-manager';
import { firstProjectSettingsError } from './repo-settings-validate';

const PID = '11111111-2222-4333-8444-555555555555';
const PID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const line = (time: string, status: number, bytes: number, path = '/') =>
  `203.0.113.7 - - [${time}] "GET ${path} HTTP/1.1" ${status} ${bytes} "-" "Mozilla/5.0 (X11; \\x22quoted\\x22)"`;

describe('parseTrafficRange', () => {
  it('defaults to 24h and accepts only the supported ranges', () => {
    expect(parseTrafficRange(undefined)).toBe('24h');
    expect(parseTrafficRange('')).toBe('24h');
    expect(parseTrafficRange('7d')).toBe('7d');
    expect(parseTrafficRange('30d')).toBeNull();
    expect(parseTrafficRange('toString')).toBeNull();
  });
});

describe('isTrafficAnalyticsEnabledFor', () => {
  it('is on by default and off when the project opts out', () => {
    expect(isTrafficAnalyticsEnabledFor({})).toBe(true);
    expect(isTrafficAnalyticsEnabledFor(null)).toBe(true);
    expect(isTrafficAnalyticsEnabledFor({ trafficAnalytics: false })).toBe(false);
  });

  it('validates the project setting', () => {
    expect(firstProjectSettingsError({ trafficAnalytics: false })).toBeNull();
    expect(firstProjectSettingsError({ trafficAnalytics: 'no' })).toMatch(/trafficAnalytics/);
  });
});

describe('parseLogHour', () => {
  it('converts the nginx local hour to the UTC hour', () => {
    expect(parseLogHour('08/Oct/2026:13 +0000')?.toISOString()).toBe('2026-10-08T13:00:00.000Z');
    expect(parseLogHour('08/Oct/2026:13 +0300')?.toISOString()).toBe('2026-10-08T10:00:00.000Z');
    expect(parseLogHour('08/Oct/2026:23 -0200')?.toISOString()).toBe('2026-10-09T01:00:00.000Z');
    expect(parseLogHour('garbage')).toBeNull();
    expect(parseLogHour('08/Foo/2026:13 +0000')).toBeNull();
  });
});

describe('parseTrafficCollectOutput', () => {
  it('sums rows for the same project and hour and keeps only valid file names', () => {
    const out = [
      `#FILE ${PID}.1700000000.collect`,
      `${PID}\t08/Oct/2026:13 +0000\t10\t2\t1\t5000`,
      `#FILE ${PID}.1700003600.collect`,
      `${PID}\t08/Oct/2026:13 +0000\t5\t0\t1\t100`,
      `${PID}\t08/Oct/2026:14 +0000\t1\t0\t0\t0`,
      '#FILE ../../etc/passwd',
      `not-a-uuid\t08/Oct/2026:13 +0000\t1\t0\t0\t0`,
      `${PID}\tbad\t1\t0\t0\t0`,
    ].join('\n');
    const { rows, files } = parseTrafficCollectOutput(out);
    expect(files).toEqual([`${PID}.1700000000.collect`, `${PID}.1700003600.collect`]);
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.hour.toISOString() === '2026-10-08T13:00:00.000Z')!;
    expect(first).toMatchObject({ projectId: PID, requests: 15, status4xx: 2, status5xx: 2, bytesSent: 5100 });
  });
});

describe('buildTrafficCleanupCommand', () => {
  it('only deletes validated collect files', () => {
    expect(buildTrafficCleanupCommand([])).toBeNull();
    expect(buildTrafficCleanupCommand(['x; rm -rf /'])).toBeNull();
    expect(buildTrafficCleanupCommand([`${PID}.1.collect`, '../x'])).toBe(
      `cd ${TRAFFIC_LOG_DIR} && rm -f -- ${PID}.1.collect`
    );
  });
});

describe('buildTrafficAnalytics', () => {
  const now = new Date('2026-10-08T13:25:00Z');

  it('fills every hour of the range and computes totals and error rates', () => {
    const result = buildTrafficAnalytics(
      [
        { hour: new Date('2026-10-08T13:00:00Z'), requests: 8, status4xx: 2, status5xx: 1, bytesSent: 800 },
        { hour: new Date('2026-10-08T00:00:00Z'), requests: 2, status4xx: 0, status5xx: 1, bytesSent: 200 },
      ],
      '24h',
      true,
      now
    );
    expect(result.series).toHaveLength(24);
    expect(result.series[0].hour).toBe('2026-10-07T14:00:00.000Z');
    expect(result.series[23]).toMatchObject({ hour: '2026-10-08T13:00:00.000Z', requests: 8 });
    expect(result.totals).toEqual({
      requests: 10,
      status4xx: 2,
      status5xx: 2,
      bytesSent: 1000,
      errorRate4xx: 0.2,
      errorRate5xx: 0.2,
    });
    expect(result.enabled).toBe(true);
  });

  it('returns zero rates with no traffic, 168 points for 7d', () => {
    const result = buildTrafficAnalytics([], '7d', false, now);
    expect(result.series).toHaveLength(168);
    expect(result.totals.errorRate5xx).toBe(0);
    expect(result.enabled).toBe(false);
  });
});

describe('nginx traffic log', () => {
  it('adds the per-app access log to serving blocks only', () => {
    const conf = generateProjectSitesConfig({
      projectSlug: 'my-app',
      containerPort: 3000,
      trafficLogId: PID,
      domains: [{ domain: 'example.com', kind: 'custom', ssl: true, aliases: ['www.example.com'], sslAliases: [] }],
    });
    const logLine = `access_log ${TRAFFIC_LOG_DIR}/${PID}.log combined buffer=64k flush=1m;`;
    // Port 80 only redirects (forceHttps); the 443 block serves the app.
    expect(conf.split(logLine)).toHaveLength(2);
    expect(conf).toContain('access_log /var/log/nginx/access.log;');
  });

  it('writes no access_log when analytics is off or the id is not a uuid', () => {
    const conf = generateProjectSitesConfig({
      projectSlug: 'my-app',
      containerPort: 3000,
      domains: [{ domain: 'example.com', kind: 'custom', ssl: false }],
    });
    expect(conf).not.toContain('access_log');
    expect(trafficLogLines('../../etc/x')).toBe('');
  });
});

function hasShellTools(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v awk >/dev/null && command -v sed >/dev/null']);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasShellTools())('collect command on a real log', () => {
  it('rotates the logs and aggregates per hour with awk', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'traffic-'));
    writeFileSync(
      join(dir, `${PID}.log`),
      [
        line('08/Oct/2026:13:01:02 +0000', 200, 1000),
        // nginx escapes a quote in the request line as \x22, so fields never shift
        line('08/Oct/2026:13:59:59 +0000', 404, 50, '/a\\x22b'),
        line('08/Oct/2026:13:30:00 +0000', 502, 0),
        line('08/Oct/2026:14:00:00 +0000', 301, 0),
      ].join('\n') + '\n'
    );
    writeFileSync(join(dir, `${PID2}.log`), '');
    // Point the script at the temp dir; no nginx here, so reopen is a harmless no-op.
    const script = buildTrafficCollectCommand()
      .replace(`D=${TRAFFIC_LOG_DIR}`, `D=${dir}`)
      .replace(/if \[ -s \/run\/nginx\.pid \].*\n/, ':\n')
      .replace('sleep 2', ':');
    const out = execFileSync('sh', ['-c', script], { encoding: 'utf8' });
    const { rows, files } = parseTrafficCollectOutput(out);

    expect(files).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual([`${PID2}.log`, files[0]].sort());
    const h13 = rows.find((r) => r.hour.toISOString() === '2026-10-08T13:00:00.000Z');
    const h14 = rows.find((r) => r.hour.toISOString() === '2026-10-08T14:00:00.000Z');
    expect(h13).toMatchObject({ projectId: PID, requests: 3, status4xx: 1, status5xx: 1, bytesSent: 1050 });
    expect(h14).toMatchObject({ requests: 1, status4xx: 0, status5xx: 0, bytesSent: 0 });
  });
});
