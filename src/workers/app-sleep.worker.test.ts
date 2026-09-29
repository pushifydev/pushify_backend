import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { containerPattern, sleepCommand, wakeCommand } from './app-sleep.worker';

/**
 * A stand-in `docker` that keeps container states in a JSON file, so the real sleep/wake shell
 * commands run end to end: `ps [-a] [--filter status=…] --format …`, `stop`, `start`.
 * Names listed in FAIL_START refuse to start.
 */
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
const fail = (process.env.FAIL_START || '').split(',').filter(Boolean);
if (cmd === 'ps') {
  const all = rest.includes('-a');
  const statuses = rest.filter((a, i) => rest[i - 1] === '--filter').map((f) => f.replace('status=', ''));
  for (const [name, status] of Object.entries(state)) {
    if (!all && status !== 'running') continue;
    if (statuses.length && !statuses.includes(status)) continue;
    console.log(name);
  }
} else if (cmd === 'stop') {
  for (const name of rest.filter((a) => !a.startsWith('--') && !/^\\d+$/.test(a))) state[name] = 'exited';
} else if (cmd === 'start') {
  let code = 0;
  for (const name of rest) {
    if (fail.includes(name)) { code = 1; continue; }
    state[name] = 'running';
  }
  fs.writeFileSync(file, JSON.stringify(state));
  process.exit(code);
}
fs.writeFileSync(file, JSON.stringify(state));
`;

let dir: string;
let stateFile: string;

function setState(state: Record<string, string>) {
  writeFileSync(stateFile, JSON.stringify(state));
}
function getState(): Record<string, string> {
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}
function run(command: string, env: Record<string, string> = {}) {
  return spawnSync('sh', ['-c', command], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_DOCKER_STATE: stateFile, ...env },
  }).status;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fake-docker-'));
  stateFile = path.join(dir, 'state.json');
  writeFileSync(path.join(dir, 'docker'), FAKE_DOCKER);
  chmodSync(path.join(dir, 'docker'), 0o755);
  writeFileSync(stateFile, '{}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const APP = {
  'pushify-shop-blue': 'running',
  'pushify-shop-blue-2': 'running',
  'pushify-shop-blue-3': 'running',
};
const OTHERS = {
  'pushify-shop-worker-queue': 'running',
  'pushify-shop-db': 'running',
  'pushify-preview-shop-pr-4': 'running',
  'pushify-shopping-blue': 'running',
  'pushify-shopping-blue-2': 'running',
};

describe('containerPattern', () => {
  const re = new RegExp(containerPattern('shop'));

  it('matches the primary and every replica of either slot', () => {
    for (const name of ['pushify-shop', 'pushify-shop-blue', 'pushify-shop-green', 'pushify-shop-blue-2', 'pushify-shop-green-10']) {
      expect(re.test(name), name).toBe(true);
    }
  });

  it('leaves workers, previews, the db sidecar and other projects alone', () => {
    for (const name of Object.keys(OTHERS)) expect(re.test(name), name).toBe(false);
  });
});

describe('sleep and wake commands', () => {
  it('sleep stops every replica and nothing else', () => {
    setState({ ...APP, ...OTHERS });
    expect(run(sleepCommand('shop'))).toBe(0);
    const state = getState();
    for (const name of Object.keys(APP)) expect(state[name], name).toBe('exited');
    for (const name of Object.keys(OTHERS)) expect(state[name], name).toBe('running');
  });

  it('wake starts every replica that sleep stopped', () => {
    setState({ ...APP, ...OTHERS });
    run(sleepCommand('shop'));
    expect(run(wakeCommand('shop'))).toBe(0);
    const state = getState();
    for (const name of Object.keys(APP)) expect(state[name], name).toBe('running');
  });

  it('wake fails while any replica is still down, so the caller retries', () => {
    setState({ ...APP, ...OTHERS });
    run(sleepCommand('shop'));
    expect(run(wakeCommand('shop'), { FAIL_START: 'pushify-shop-blue-3' })).not.toBe(0);
    // A retry once the container can start again succeeds and leaves all of them up
    expect(run(wakeCommand('shop'))).toBe(0);
    expect(Object.values(getState()).every((s) => s === 'running')).toBe(true);
  });

  it('wake fails when the app has no containers at all', () => {
    setState(OTHERS);
    expect(run(wakeCommand('shop'))).not.toBe(0);
  });
});
