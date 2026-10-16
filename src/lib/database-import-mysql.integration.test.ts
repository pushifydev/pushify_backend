import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { buildMysqlImportCommand } from './database-import';

/**
 * Runs the generated MySQL import command in a real shell. A fake `docker` function stands in for
 * `docker exec -i … mysql`: it records its arguments and stdin (what mysql would receive) and
 * fails like mysql when the SQL contains `FAIL`. This checks what a string assertion cannot: the
 * exit code reaches the caller, a corrupt .sql.gz imports nothing, the upload is always removed.
 *
 * With MYSQL_IMPORT_TEST_CONTAINER (+ _USER, _PASSWORD, _DATABASE) set, the last test also runs
 * the command against that real MySQL/MariaDB container.
 */

const hasShell = spawnSync('sh', ['-c', 'command -v gunzip']).status === 0;

describe.skipIf(!hasShell)('MySQL import command (shell)', () => {
  let dir: string;
  let fakeDocker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mysql-import-'));
    // A shell function rather than a file on PATH: temp dirs may be mounted noexec.
    fakeDocker =
      `docker() { echo "$@" > '${dir}/args'; cat > '${dir}/stdin'; ` +
      `if grep -q FAIL '${dir}/stdin'; then echo 'ERROR 1064 (42000) at line 1' >&2; return 1; fi; echo imported; }\n`;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (cmd: string) => {
    const r = spawnSync('sh', ['-c', fakeDocker + cmd], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };

  it('imports a plain .sql and removes the upload', () => {
    const file = join(dir, 'j1.sql');
    writeFileSync(file, 'CREATE TABLE t (id int);\n');
    const r = run(buildMysqlImportCommand('db', 'u', 'p', 'main', file, 'sql'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('imported');
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('CREATE TABLE t (id int);\n');
    expect(readFileSync(join(dir, 'args'), 'utf8')).toContain('exec -i -e MYSQL_PWD=p db mysql --show-warnings -u u main');
    expect(existsSync(file)).toBe(false);
  });

  it('imports a .sql.gz decompressed', () => {
    const file = join(dir, 'j1.sql.gz');
    writeFileSync(file, gzipSync('INSERT INTO t VALUES (1);\n'));
    const r = run(buildMysqlImportCommand('db', 'u', 'p', 'main', file, 'sql.gz'));
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('INSERT INTO t VALUES (1);\n');
    expect(existsSync(file)).toBe(false);
  });

  it('passes the mysql error and exit code through, and still removes the upload', () => {
    const file = join(dir, 'j1.sql');
    writeFileSync(file, 'FAIL;\n');
    const r = run(buildMysqlImportCommand('db', 'u', 'p', 'main', file, 'sql'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR 1064');
    expect(existsSync(file)).toBe(false);
  });

  it('a truncated .sql.gz never reaches mysql', () => {
    const file = join(dir, 'j1.sql.gz');
    const gz = gzipSync('INSERT INTO t VALUES (1);\n'.repeat(1000));
    writeFileSync(file, gz.subarray(0, gz.length - 20));
    const r = run(buildMysqlImportCommand('db', 'u', 'p', 'main', file, 'sql.gz'));
    expect(r.code).not.toBe(0);
    expect(existsSync(join(dir, 'stdin'))).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

const container = process.env.MYSQL_IMPORT_TEST_CONTAINER;

describe.skipIf(!container)('MySQL import command (real container)', () => {
  it('imports a dump and reports a failing one', () => {
    const user = process.env.MYSQL_IMPORT_TEST_USER ?? 'root';
    const pass = process.env.MYSQL_IMPORT_TEST_PASSWORD ?? '';
    const db = process.env.MYSQL_IMPORT_TEST_DATABASE ?? 'test';
    const dir = mkdtempSync(join(tmpdir(), 'mysql-import-real-'));
    try {
      const ok = join(dir, 'ok.sql.gz');
      writeFileSync(
        ok,
        gzipSync(
          'DROP TABLE IF EXISTS pushify_import_t;\nCREATE TABLE pushify_import_t (id int);\nINSERT INTO pushify_import_t VALUES (1),(2);\n',
        ),
      );
      expect(spawnSync('sh', ['-c', buildMysqlImportCommand(container!, user, pass, db, ok, 'sql.gz')]).status).toBe(0);
      const count = execFileSync(
        'docker',
        ['exec', '-e', `MYSQL_PWD=${pass}`, container!, 'mysql', '-N', '-u', user, db, '-e', 'SELECT COUNT(*) FROM pushify_import_t'],
        { encoding: 'utf8' },
      );
      expect(count.trim()).toBe('2');

      // The table exists now, so a dump without DROP fails and must say so.
      const bad = join(dir, 'bad.sql');
      writeFileSync(bad, 'CREATE TABLE pushify_import_t (id int);\n');
      expect(spawnSync('sh', ['-c', buildMysqlImportCommand(container!, user, pass, db, bad, 'sql')]).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
