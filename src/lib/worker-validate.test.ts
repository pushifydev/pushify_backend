import { describe, it, expect } from 'vitest';
import {
  validateWorkerName,
  validateWorkerCommand,
  workerContainerName,
} from './worker-validate';

describe('validateWorkerName', () => {
  it('accepts simple slugs', () => {
    expect(validateWorkerName('worker')).toBeNull();
    expect(validateWorkerName('queue-2')).toBeNull();
    expect(validateWorkerName('a')).toBeNull();
  });

  it('rejects invalid names', () => {
    expect(validateWorkerName('')).not.toBeNull();
    expect(validateWorkerName('Worker')).not.toBeNull();
    expect(validateWorkerName('-lead')).not.toBeNull();
    expect(validateWorkerName('tail-')).not.toBeNull();
    expect(validateWorkerName('has space')).not.toBeNull();
    expect(validateWorkerName('a'.repeat(41))).not.toBeNull();
    expect(validateWorkerName(undefined)).not.toBeNull();
  });
});

describe('validateWorkerCommand', () => {
  it('accepts normal commands', () => {
    expect(validateWorkerCommand('node dist/worker.js')).toBeNull();
    expect(validateWorkerCommand("npm run queue -- --concurrency 4")).toBeNull();
  });

  it('rejects empty, oversized and multi-line commands', () => {
    expect(validateWorkerCommand('')).not.toBeNull();
    expect(validateWorkerCommand('  ')).not.toBeNull();
    expect(validateWorkerCommand('x'.repeat(1001))).not.toBeNull();
    expect(validateWorkerCommand("node a\nrm -rf /")).not.toBeNull();
  });
});

describe('workerContainerName', () => {
  it('stays inside the teardown regex and outside blue-green space', () => {
    const name = workerContainerName('my-app', 'queue');
    expect(name).toBe('pushify-my-app-worker-queue');
    // teardown matches ^pushify-<slug>(-|$)
    expect(new RegExp('^pushify-my-app(-|$)').test(name)).toBe(true);
    // app-sleep pattern must NOT match worker containers
    expect(new RegExp('^pushify-my-app(-blue|-green)?$').test(name)).toBe(false);
  });
});
