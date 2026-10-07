import { describe, it, expect } from 'vitest';
import { formatContainerCrashSummary, parseContainerExitState } from './container-crash-summary';
import { classifyDeployFailure } from './deploy-failure-classify';
import { createLogMasker } from './log-masking';

describe('parseContainerExitState', () => {
  it('returns the exit code of a stopped container', () => {
    expect(parseContainerExitState('false 137\n')).toBe(137);
    expect(parseContainerExitState('false 0')).toBe(0);
  });

  it('returns null while running or when inspect gave nothing usable', () => {
    expect(parseContainerExitState('true 0')).toBeNull();
    expect(parseContainerExitState('')).toBeNull();
    expect(parseContainerExitState('false')).toBeNull();
    expect(parseContainerExitState('Error: No such object')).toBeNull();
  });
});

describe('formatContainerCrashSummary', () => {
  it('includes the exit code and only the last 50 log lines', () => {
    const logs = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n');
    const summary = formatContainerCrashSummary({
      headline: 'Container exited unexpectedly',
      exitCode: 1,
      logs,
    });

    expect(summary.startsWith('Container exited unexpectedly (exit code 1)\n')).toBe(true);
    expect(summary).toContain('Runtime log (last 50 lines):');
    expect(summary).toContain('line 80');
    expect(summary).toContain('line 31');
    expect(summary).not.toContain('line 30\n');
  });

  it('omits the exit code when unknown and says when there was no output', () => {
    const summary = formatContainerCrashSummary({
      headline: 'Container health check timeout',
      exitCode: null,
      logs: '  \n',
    });
    expect(summary).toBe('Container health check timeout\nThe container produced no log output.');
  });

  it('is classified as a container start failure and secrets can be masked out of it', () => {
    const rawError = `Blue-green deployment failed:\n${formatContainerCrashSummary({
      headline: 'Container exited unexpectedly',
      exitCode: 1,
      logs: 'connecting to postgres://app:s3cr3t-pass@db/app\nError: connect ECONNREFUSED',
    })}`;

    expect(classifyDeployFailure('', rawError).category).toBe('container_start');

    const masked = createLogMasker({ DATABASE_PASSWORD: 's3cr3t-pass' }).mask(rawError);
    expect(masked).not.toContain('s3cr3t-pass');
    expect(masked).toContain('(exit code 1)');
  });
});
