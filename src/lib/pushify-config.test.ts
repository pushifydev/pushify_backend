import { describe, expect, it } from 'vitest';
import { parsePushifyConfig, describeOverrides } from './pushify-config';

describe('parsePushifyConfig', () => {
  it('parses a full valid config', () => {
    const { config, error } = parsePushifyConfig(`
build: npm run build
install: pnpm install
start: node server.js
output: dist
port: 8080
framework: nextjs
cron:
  - name: nightly-cleanup
    schedule: "0 3 * * *"
    command: node scripts/cleanup.js
    timezone: Europe/Istanbul
volumes:
  - name: uploads
    path: /app/uploads
`);
    expect(error).toBeNull();
    expect(config?.build).toBe('npm run build');
    expect(config?.port).toBe(8080);
    expect(config?.cron?.[0].timezone).toBe('Europe/Istanbul');
    expect(config?.volumes?.[0].path).toBe('/app/uploads');
    expect(describeOverrides(config!)).toContain('port 8080');
  });

  it('rejects invalid YAML without throwing', () => {
    const { config, error } = parsePushifyConfig('build: [unclosed');
    expect(config).toBeNull();
    expect(error).toContain('invalid YAML');
  });

  it('rejects unknown keys (strict schema)', () => {
    const { config, error } = parsePushifyConfig('bulid: npm run build');
    expect(config).toBeNull();
    expect(error).toBeTruthy();
  });

  it('rejects an invalid cron expression', () => {
    const { config, error } = parsePushifyConfig(`
cron:
  - name: bad
    schedule: "every day"
    command: echo hi
`);
    expect(config).toBeNull();
    expect(error).toContain('cron "bad"');
  });

  it('rejects duplicate cron names and bad volume paths', () => {
    expect(
      parsePushifyConfig(`
cron:
  - { name: a, schedule: "0 3 * * *", command: x }
  - { name: a, schedule: "0 4 * * *", command: y }
`).error
    ).toContain('duplicate cron name');

    expect(
      parsePushifyConfig(`
volumes:
  - { name: uploads, path: relative/path }
`).error
    ).toContain('volume "uploads"');
  });

  it('rejects secrets-looking env keys — env is not supported at all', () => {
    const { config, error } = parsePushifyConfig('env:\n  API_KEY: abc');
    expect(config).toBeNull();
    expect(error).toBeTruthy();
  });

  it('treats an empty file as an error, not a crash', () => {
    const { config, error } = parsePushifyConfig('');
    expect(config).toBeNull();
    expect(error).toContain('empty');
  });
});

describe('workers key', () => {
  it('accepts valid workers', () => {
    const { config, error } = parsePushifyConfig(`
workers:
  - name: queue
    command: node dist/worker.js
  - name: mailer
    command: npm run mailer
`);
    expect(error).toBeNull();
    expect(config?.workers).toHaveLength(2);
    expect(describeOverrides(config!)).toContain('2 worker(s)');
  });

  it('rejects invalid worker names and duplicate names', () => {
    expect(parsePushifyConfig(`
workers:
  - name: Bad Name
    command: node w.js
`).error).not.toBeNull();

    expect(parsePushifyConfig(`
workers:
  - name: queue
    command: node a.js
  - name: queue
    command: node b.js
`).error).not.toBeNull();
  });

  it('rejects multi-line worker commands', () => {
    expect(parsePushifyConfig(`
workers:
  - name: queue
    command: "node a.js\\nrm -rf /"
`).error).not.toBeNull();
  });
});
