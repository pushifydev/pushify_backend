import { describe, it, expect } from 'vitest';
import {
  buildVerifyScript,
  parseVerifyOutput,
  wrapForSsh,
  verifyUnitFor,
  VERIFY_MARKER,
  VERIFY_TIMEOUT_SECONDS,
} from './backup-verify';

const base = {
  containerName: 'pushify-db-shop',
  filePath: '/opt/pushify/databases/shop/backups/shop_2026.sql.gz',
  username: 'shop',
  password: "p'ss\"w rd",
  databaseName: 'shop',
  verifyContainerName: 'pushify-verify-abc',
};

describe('buildVerifyScript', () => {
  it('never touches the live container beyond inspecting its image, and always cleans up', () => {
    const s = buildVerifyScript({ ...base, type: 'postgresql' });
    expect(s).toContain(`docker inspect --format '{{.Config.Image}}' "$CN"`);
    expect(s).toContain('trap cleanup EXIT');
    expect(s).toContain('docker rm -f "$V"');
    // Every docker exec / run targets the throwaway, not the source.
    const execs = s.match(/docker (exec|run|create|cp)[^\n]*/g) ?? [];
    for (const line of execs) expect(line).not.toMatch(/"\$CN"/);
    expect(s).toContain('--network none');
  });

  it('escapes credentials with single quotes safely', () => {
    const s = buildVerifyScript({ ...base, type: 'postgresql' });
    expect(s).toContain(`P='p'\\''ss"w rd'`);
  });

  it('emits the marker on both success and failure paths', () => {
    for (const type of ['postgresql', 'mysql', 'mongodb', 'redis'] as const) {
      const s = buildVerifyScript({ ...base, type });
      expect(s).toContain(`${VERIFY_MARKER} {\\"ok\\":true`);
      expect(s).toContain(`${VERIFY_MARKER} {\\"ok\\":false`);
      expect(s).toContain('READY');
    }
  });

  it('does not pass MYSQL_USER=root (the image rejects it)', () => {
    const s = buildVerifyScript({ ...base, type: 'mysql', username: 'root' });
    expect(s).toContain('if [ "$U" != root ]');
  });
});

describe('wrapForSsh', () => {
  it('bounds the run with timeout and a quoted heredoc', () => {
    const w = wrapForSsh('echo hi');
    expect(w.startsWith(`timeout ${VERIFY_TIMEOUT_SECONDS} bash -s <<'PUSHIFY_VERIFY_EOF'`)).toBe(true);
    expect(w.trim().endsWith('PUSHIFY_VERIFY_EOF')).toBe(true);
  });
});

describe('parseVerifyOutput', () => {
  it('reads the last marker line and ignores engine noise', () => {
    const out = `WARNING: something\n${VERIFY_MARKER} {"ok":true,"tables":14,"rows":12345}\n`;
    expect(parseVerifyOutput(out)).toEqual({ ok: true, tables: 14, rows: 12345, error: undefined });
  });
  it('surfaces script failures and timeouts', () => {
    expect(parseVerifyOutput(`${VERIFY_MARKER} {"ok":false,"error":"container did not become ready"}`)).toMatchObject({
      ok: false,
      error: 'container did not become ready',
    });
    expect(parseVerifyOutput('', 124).error).toContain('timed out');
    expect(parseVerifyOutput('garbage').ok).toBe(false);
  });
});

describe('verifyUnitFor', () => {
  it('labels counts per engine', () => {
    expect(verifyUnitFor('postgresql')).toBe('rows');
    expect(verifyUnitFor('mongodb')).toBe('documents');
    expect(verifyUnitFor('redis')).toBe('keys');
  });
});
