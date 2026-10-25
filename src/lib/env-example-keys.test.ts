import { describe, it, expect, vi } from 'vitest';
import {
  parseEnvExampleKeys,
  envExampleCandidatePaths,
  detectEnvExampleKeys,
  readTextWithLimit,
  ENV_EXAMPLE_MAX_BYTES,
} from './env-example-keys';

describe('parseEnvExampleKeys', () => {
  it('lists keys with whether the example gives a value, never the value itself', () => {
    const keys = parseEnvExampleKeys('DATABASE_URL=postgres://u:p@db/app\nSTRIPE_SECRET_KEY=\n');
    expect(keys).toEqual([
      { key: 'DATABASE_URL', hasDefault: true },
      { key: 'STRIPE_SECRET_KEY', hasDefault: false },
    ]);
    expect(JSON.stringify(keys)).not.toContain('postgres://');
  });

  it('skips blank lines and comment lines, including commented-out assignments', () => {
    const content = ['# Database', '', '   ', '# OLD_KEY=value', '  # INDENTED=1', 'PORT=3000'].join('\n');
    expect(parseEnvExampleKeys(content)).toEqual([{ key: 'PORT', hasDefault: true }]);
  });

  it('accepts an `export` prefix', () => {
    expect(parseEnvExampleKeys('export API_URL=https://api.example.com\nexport   EMPTY=\n')).toEqual([
      { key: 'API_URL', hasDefault: true },
      { key: 'EMPTY', hasDefault: false },
    ]);
  });

  it('treats empty quotes as no default and quoted text as a default', () => {
    const content = [
      'A=""',
      "B=''",
      'C=``',
      'D="hello world"',
      "E='single # not a comment'",
      'F=`tick`',
      'G="with \\" escaped quote"',
    ].join('\n');
    expect(parseEnvExampleKeys(content)).toEqual([
      { key: 'A', hasDefault: false },
      { key: 'B', hasDefault: false },
      { key: 'C', hasDefault: false },
      { key: 'D', hasDefault: true },
      { key: 'E', hasDefault: true },
      { key: 'F', hasDefault: true },
      { key: 'G', hasDefault: true },
    ]);
  });

  it('ends an unquoted value at an inline comment', () => {
    expect(parseEnvExampleKeys('SECRET= # paste yours here\nNAME=app # the app name')).toEqual([
      { key: 'SECRET', hasDefault: false },
      { key: 'NAME', hasDefault: true },
    ]);
  });

  it('allows a byte-order mark, spaces around = and Windows line endings', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parseEnvExampleKeys(`${bom}HOST = localhost\r\nTOKEN =\r\n`)).toEqual([
      { key: 'HOST', hasDefault: true },
      { key: 'TOKEN', hasDefault: false },
    ]);
  });

  it('does not read lines inside a multi-line quoted value as keys', () => {
    const content = [
      'PRIVATE_KEY="-----BEGIN KEY-----',
      'INNER_LINE=looks-like-a-key',
      '-----END KEY-----"',
      'AFTER=1',
    ].join('\n');
    expect(parseEnvExampleKeys(content)).toEqual([
      { key: 'PRIVATE_KEY', hasDefault: true },
      { key: 'AFTER', hasDefault: true },
    ]);
  });

  it('reads a quote that never closes as a one-line value', () => {
    expect(parseEnvExampleKeys('A="unclosed\nB=2')).toEqual([
      { key: 'A', hasDefault: true },
      { key: 'B', hasDefault: true },
    ]);
  });

  it('stays fast when unclosed quotes are followed by many lines', () => {
    const lines = ['A="never', "B='never", 'C=`never', ...Array.from({ length: 12_000 }, (_, i) => `K${i}=1`)];
    const started = Date.now();
    const keys = parseEnvExampleKeys(lines.join('\n'));
    expect(keys).toHaveLength(12_003);
    expect(keys.slice(0, 3)).toEqual([
      { key: 'A', hasDefault: true },
      { key: 'B', hasDefault: true },
      { key: 'C', hasDefault: true },
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('treats a multi-line value of blank lines as no default', () => {
    expect(parseEnvExampleKeys('A="\n\n"\nB=1')).toEqual([
      { key: 'A', hasDefault: false },
      { key: 'B', hasDefault: true },
    ]);
  });

  it('drops names Pushify would refuse to save', () => {
    const content = [
      'lowercase=1',
      '1STARTS_WITH_DIGIT=1',
      'HAS-DASH=1',
      'HAS.DOT=1',
      '_LEADING_UNDERSCORE=1',
      'export=1',
      'NO_EQUALS_SIGN',
      'TWO WORDS=1',
      `${'A'.repeat(256)}=1`,
      'VALID_KEY=1',
    ].join('\n');
    expect(parseEnvExampleKeys(content)).toEqual([{ key: 'VALID_KEY', hasDefault: true }]);
  });

  it('keeps a repeated key once, at its first position, with the last value', () => {
    expect(parseEnvExampleKeys('A=1\nB=2\nA=')).toEqual([
      { key: 'A', hasDefault: false },
      { key: 'B', hasDefault: true },
    ]);
  });

  it('returns an empty list for an empty file', () => {
    expect(parseEnvExampleKeys('')).toEqual([]);
  });
});

describe('envExampleCandidatePaths', () => {
  it('uses the repository root when no root directory is set', () => {
    for (const root of [undefined, null, '', '.', './', '/']) {
      expect(envExampleCandidatePaths(root)).toEqual(['.env.example', '.env.sample', '.env.template']);
    }
  });

  it('reads from the root directory of a monorepo app', () => {
    expect(envExampleCandidatePaths('/apps/web/')).toEqual([
      'apps/web/.env.example',
      'apps/web/.env.sample',
      'apps/web/.env.template',
    ]);
  });
});

describe('detectEnvExampleKeys', () => {
  it('uses the first file that exists', async () => {
    const files: Record<string, string> = { '.env.sample': 'FROM_SAMPLE=1', '.env.template': 'FROM_TEMPLATE=1' };
    const readFile = vi.fn(async (path: string) => files[path] ?? null);
    await expect(detectEnvExampleKeys(readFile)).resolves.toEqual({
      source: '.env.sample',
      keys: [{ key: 'FROM_SAMPLE', hasDefault: true }],
    });
    expect(readFile).not.toHaveBeenCalledWith('.env.template');
  });

  it('returns an empty list when there is no example file or reading fails', async () => {
    await expect(detectEnvExampleKeys(async () => null)).resolves.toEqual({ source: null, keys: [] });
    await expect(
      detectEnvExampleKeys(async () => {
        throw new Error('network');
      })
    ).resolves.toEqual({ source: null, keys: [] });
  });
});

describe('readTextWithLimit', () => {
  it('returns the body when it fits', async () => {
    await expect(readTextWithLimit(new Response('A=1\n'), 10)).resolves.toBe('A=1\n');
  });

  it('gives up on a body over the limit', async () => {
    const big = 'A'.repeat(ENV_EXAMPLE_MAX_BYTES + 1);
    await expect(readTextWithLimit(new Response(big), ENV_EXAMPLE_MAX_BYTES)).resolves.toBeNull();
  });

  it('gives up on a declared Content-Length over the limit without reading', async () => {
    const response = new Response('small', { headers: { 'content-length': '999999' } });
    await expect(readTextWithLimit(response, 10)).resolves.toBeNull();
  });

  it('counts bytes, not characters', async () => {
    // 'ü' is two bytes in UTF-8: 6 characters, 12 bytes.
    await expect(readTextWithLimit(new Response('üüüüüü'), 11)).resolves.toBeNull();
    await expect(readTextWithLimit(new Response('üüüüüü'), 12)).resolves.toBe('üüüüüü');
  });
});
