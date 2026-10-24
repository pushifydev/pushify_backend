import { describe, it, expect } from 'vitest';
import { firstErrorLine, FAILURE_SUMMARY_MAX_LENGTH } from './first-error-line';
import { classifyDeployFailure } from './deploy-failure-classify';
import { createLogMasker } from './log-masking';

/** A failed generated build as the worker stores it: timestamped worker lines and streamed BuildKit output. */
const ts = (line: string) => `[2026-10-24T10:00:00.000Z] ${line}`;
const buildLog = (...output: string[]) =>
  [
    ts('🚀 Starting deployment...'),
    ts('⚠️ Could not read pushify.yaml, using defaults'),
    ts('🔨 Building Docker image: pushify-app:abc1234'),
    ts('#11 [builder 5/8] RUN npm run build'),
    ts('#11 0.412 > app@1.0.0 build'),
    ts('#11 0.412 > weird-tool compile --no-error-on-unmatched-pattern'),
    ts('#11 0.500 npm warn deprecated error-ex@1.3.2: use something else'),
    ...output.map((line, i) => ts(`#11 ${(i * 0.01 + 1.2).toFixed(3)} ${line}`)),
    ts('#11 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1'),
    ts('------'),
    ts(' > [builder 5/8] RUN npm run build:'),
    ts('Dockerfile:15'),
    ts(' 15 | >>> RUN npm run build'),
  ].join('\n');

describe('firstErrorLine', () => {
  it('a log no classifier case matches stays unknown and gets the first error line it printed', () => {
    const logs = buildLog(
      'weird-tool v3.1.0',
      'Error: Unexpected token "}" in weird.config at line 3',
      '    at parseConfig (/app/node_modules/weird-tool/index.js:10:5)',
    );
    expect(classifyDeployFailure(logs, 'Deployment failed').category).toBe('unknown');
    expect(firstErrorLine(logs, 'Deployment failed')).toBe('Error: Unexpected token "}" in weird.config at line 3');
  });

  it('skips the worker narration, echoed steps, warnings and stack frames', () => {
    const logs = buildLog('Traceback (most recent call last):', '  File "/app/manage.py", line 22, in <module>', 'ModuleNotFoundError: No module named \'djangoo\'');
    expect(firstErrorLine(logs, 'Docker build failed')).toBe("ModuleNotFoundError: No module named 'djangoo'");
  });

  it('falls back to the BuildKit line when the build printed nothing more specific', () => {
    expect(firstErrorLine(buildLog('compiling…'), 'Deployment failed')).toBe(
      'ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
    );
  });

  it('uses the raw error when the log has no error line, and is null with nothing at all', () => {
    expect(firstErrorLine(ts('🚀 Starting deployment...'), 'Health check timed out after 60s')).toBe('Health check timed out after 60s');
    expect(firstErrorLine('', '')).toBeNull();
    expect(firstErrorLine(null, null)).toBeNull();
  });

  it('never shows a secret value: the project masker first, then the generic scrub', () => {
    const masker = createLogMasker({ STRIPE_KEY: 'super-secret-value-123456' });
    const logs = buildLog(
      'Error: auth failed for super-secret-value-123456',
    );
    const summary = firstErrorLine(logs, 'Deployment failed', (text) => masker.mask(text))!;
    expect(summary).toContain('Error: auth failed for');
    expect(summary).not.toContain('super-secret-value-123456');

    // A value the masker does not know is still caught by its shape or its name.
    const leaked = firstErrorLine(buildLog('Error: DATABASE_URL=postgres://u:p4ss@db:5432/app is invalid, token ghp_abcdefghijklmnopqrstuvwxyz0123'), '')!;
    expect(leaked).not.toContain('p4ss');
    expect(leaked).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });

  it('is at most about 300 characters and strips colour codes', () => {
    const summary = firstErrorLine(buildLog(`\x1b[31mError:\x1b[0m ${'too long '.repeat(100)}`), '')!;
    expect(summary.startsWith('Error: too long')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(FAILURE_SUMMARY_MAX_LENGTH + 1);
  });
});
