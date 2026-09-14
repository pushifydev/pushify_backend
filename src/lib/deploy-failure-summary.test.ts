import { describe, it, expect } from 'vitest';
import { summarizeDeployFailures, stripFailurePrefix } from './deploy-failure-summary';

describe('stripFailurePrefix', () => {
  it('removes the "[Blame] Label:" prefix the worker writes', () => {
    expect(stripFailurePrefix('[Project] Application build failed: npm ERR! Missing script: "build"')).toBe(
      'npm ERR! Missing script: "build"',
    );
    expect(stripFailurePrefix('[Server] Disk full: ENOSPC: no space left on device')).toBe(
      'ENOSPC: no space left on device',
    );
  });

  it('leaves an unprefixed message alone and keeps only the first line', () => {
    expect(stripFailurePrefix('Docker is not available on this machine.\nsecond line')).toBe(
      'Docker is not available on this machine.',
    );
  });
});

describe('summarizeDeployFailures', () => {
  it('groups by classifier category, newest sample first, sorted by count', () => {
    const summary = summarizeDeployFailures([
      { errorMessage: '[Server] Disk full: ENOSPC: no space left on device', projectId: 'p1' },
      { errorMessage: 'npm ERR! Missing script: "build"', projectId: 'p2' },
      { errorMessage: '[Project] Application build failed: Failed to compile.', projectId: 'p3' },
      { errorMessage: 'error TS2345: type mismatch', projectId: 'p2' },
    ]);

    expect(summary.map((s) => [s.category, s.count, s.projects])).toEqual([
      ['application_build', 3, 2],
      ['disk_space', 1, 1],
    ]);
    // Rows arrive newest first, so the first message seen is the sample.
    expect(summary[0].sample).toBe('npm ERR! Missing script: "build"');
    expect(summary[0].blame).toBe('project');
    expect(summary[1].sample).toBe('ENOSPC: no space left on device');
    expect(summary[1].blame).toBe('server');
  });

  it('puts messages the classifier does not recognise under unknown', () => {
    const [only] = summarizeDeployFailures([
      { errorMessage: 'Docker is not available on this machine.', projectId: 'p1' },
      { errorMessage: null, projectId: 'p1' },
    ]);
    expect(only.category).toBe('unknown');
    expect(only.count).toBe(2);
    expect(only.projects).toBe(1);
    expect(only.sample).toBe('Docker is not available on this machine.');
  });

  it('is empty for no rows', () => {
    expect(summarizeDeployFailures([])).toEqual([]);
  });
});
