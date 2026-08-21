import { describe, expect, it } from 'vitest';
import { StudioValidationError } from './studio-errors';
import {
  buildClientCommand,
  buildFilterClause,
  buildPkClause,
  capRows,
  collectColumns,
  countSql,
  extractEngineError,
  mutationSql,
  parseAffected,
  cancelQuerySql,
  mysqlKillQuerySql,
  parseCommandTag,
  parseJsonRows,
  parseMysqlXml,
  prologue,
  qualifiedName,
  selectRowsSql,
  stripPrologueTags,
  toSqlValue,
  toTableSchema,
  type RawColumn,
  type StudioColumn,
} from './studio-sql';

const column = (overrides: Partial<StudioColumn> & { name: string }): StudioColumn => ({
  dataType: 'text',
  isNullable: true,
  defaultValue: null,
  isPrimaryKey: false,
  editable: true,
  ordinal: 1,
  ...overrides,
});

describe('prologue', () => {
  it('pins the escaping mode both engines are escaped for', () => {
    expect(prologue('postgresql', false)).toContain('standard_conforming_strings = on');
    expect(prologue('mysql', false)).toContain("REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '')");
  });

  it('adds the read-only guard only for reads', () => {
    expect(prologue('postgresql', true)).toContain('default_transaction_read_only = on');
    expect(prologue('postgresql', false)).not.toContain('read_only');
    expect(prologue('mysql', true)).toContain('transaction_read_only = ON');
    expect(prologue('mysql', false)).not.toContain('transaction_read_only');
  });
});

describe('buildClientCommand', () => {
  const base = {
    containerName: 'pushify-db-app',
    username: 'user',
    databaseName: 'app',
    password: 'secret',
  } as const;

  it('never puts the script on the command line', () => {
    const command = buildClientCommand({
      ...base,
      engine: 'postgresql',
      script: "SELECT 'a; rm -rf /'",
    });

    expect(command).not.toContain('rm -rf');
    expect(command).toContain('base64 -d');
    // The script travels as base64 and is decoded into the client's stdin.
    expect(command).toContain(Buffer.from("SELECT 'a; rm -rf /'", 'utf8').toString('base64'));
  });

  it('bounds runtime and output by default', () => {
    const command = buildClientCommand({ ...base, engine: 'postgresql', script: 'SELECT 1' });
    expect(command).toContain('timeout 30 ');
    expect(command).toContain('head -c 8000000');
  });

  it('omits the timeout wrapper when asked', () => {
    const command = buildClientCommand({
      ...base,
      engine: 'postgresql',
      script: 'SELECT 1',
      timeoutSeconds: 0,
    });
    expect(command).not.toContain('timeout ');
  });

  it('quiets psql unless the caller wants command tags', () => {
    const quiet = buildClientCommand({ ...base, engine: 'postgresql', script: 'SELECT 1' });
    const loud = buildClientCommand({
      ...base,
      engine: 'postgresql',
      script: 'SELECT 1',
      quiet: false,
    });

    expect(quiet).toContain(' -q ');
    expect(loud).not.toContain(' -q ');
  });

  it('switches mysql to XML when arbitrary result sets are expected', () => {
    const batch = buildClientCommand({ ...base, engine: 'mysql', script: 'SELECT 1' });
    const xml = buildClientCommand({ ...base, engine: 'mysql', script: 'SELECT 1', xml: true });

    expect(batch).toContain('--raw --silent --skip-column-names');
    expect(xml).toContain('--xml');
  });

  it('shell-quotes the credentials it does interpolate', () => {
    const command = buildClientCommand({
      ...base,
      password: "pa'ss",
      engine: 'postgresql',
      script: 'SELECT 1',
    });
    expect(command).toContain(`-e PGPASSWORD='pa'\\''ss'`);
  });
});

describe('extractEngineError', () => {
  it('ignores client noise and notices', () => {
    expect(extractEngineError('')).toBeNull();
    expect(extractEngineError('mysql: [Warning] Using a password on the command line')).toBeNull();
    expect(extractEngineError('NOTICE:  table "x" does not exist, skipping')).toBeNull();
  });

  it('reports lines that actually failed', () => {
    expect(extractEngineError('ERROR:  relation "nope" does not exist')).toContain('does not exist');
    expect(extractEngineError('ERROR 1146 (42S02): Table nope doesn\'t exist')).toContain('1146');
  });
});

describe('parsers', () => {
  it('reads an empty result set as no rows', () => {
    expect(parseJsonRows('')).toEqual([]);
    expect(parseJsonRows('  \n')).toEqual([]);
    expect(parseJsonRows('NULL')).toEqual([]);
    expect(parseJsonRows('[]')).toEqual([]);
  });

  it('raises a typed error on output that is not JSON', () => {
    expect(() => parseJsonRows('not json')).toThrow(StudioValidationError);
  });

  it('drops the tags our own prologue produced', () => {
    expect(stripPrologueTags('SET\nBEGIN\nUPDATE 3\nCOMMIT')).toBe('UPDATE 3');
  });

  it('reads the affected count out of a command tag', () => {
    expect(parseCommandTag('UPDATE 3')).toEqual({ command: 'UPDATE', affected: 3 });
    // INSERT reports oid and count; the count is the last number.
    expect(parseCommandTag('INSERT 0 5')).toEqual({ command: 'INSERT', affected: 5 });
    expect(parseCommandTag('some prose')).toEqual({ command: null, affected: null });
  });

  it('reads the trailing count of a mutation script', () => {
    expect(parseAffected('3\n')).toBe(3);
    expect(parseAffected('')).toBe(0);
    expect(parseAffected('not a number')).toBe(0);
  });

  it('parses mysql xml, keeping column order and NULLs', () => {
    const xml = `<?xml version="1.0"?>
<resultset statement="select" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
    <field name="id">1</field>
    <field name="note" xsi:nil="true" />
    <field name="text">a &amp; b &lt;tag&gt;</field>
  </row>
</resultset>`;

    const parsed = parseMysqlXml(xml);
    expect(parsed.columns).toEqual(['id', 'note', 'text']);
    expect(parsed.rows[0]).toEqual({ id: '1', note: null, text: 'a & b <tag>' });
  });

  it('takes the last result set, which is where a trailing ROW_COUNT lands', () => {
    const xml = `<?xml version="1.0"?>
<resultset><row><field name="a">1</field></row></resultset>
<resultset><row><field name="affected_rows">7</field></row></resultset>`;

    expect(parseMysqlXml(xml).rows[0]).toEqual({ affected_rows: '7' });
  });

  it('caps a huge cell instead of returning it whole', () => {
    const [row] = capRows([{ big: 'x'.repeat(5000), small: 'ok' }]);
    expect(String(row.big)).toHaveLength(4001);
    expect(row.small).toBe('ok');
  });

  it('collects the union of keys in row order', () => {
    expect(collectColumns([{ a: 1 }, { b: 2, a: 3 }])).toEqual(['a', 'b']);
  });
});

describe('toSqlValue', () => {
  it('maps null and booleans per engine', () => {
    expect(toSqlValue('postgresql', null)).toBe('NULL');
    expect(toSqlValue('postgresql', true)).toBe('TRUE');
    expect(toSqlValue('mysql', true)).toBe('1');
  });

  it('sends everything else as a quoted literal for the column to coerce', () => {
    expect(toSqlValue('postgresql', 42)).toBe("'42'");
    expect(toSqlValue('postgresql', { a: 1 })).toBe('\'{"a":1}\'');
  });

  it('rejects values that cannot be represented', () => {
    expect(() => toSqlValue('postgresql', Number.NaN)).toThrow(StudioValidationError);
    expect(() => toSqlValue('postgresql', Symbol('x') as unknown)).toThrow(StudioValidationError);
  });
});

describe('buildFilterClause', () => {
  const columns = [column({ name: 'id', dataType: 'integer' }), column({ name: 'title' })];

  it('returns nothing when there is nothing to filter', () => {
    expect(buildFilterClause('postgresql', columns, [])).toBe('');
    expect(buildFilterClause('postgresql', columns, undefined)).toBe('');
  });

  it('only accepts columns the table actually has', () => {
    expect(() =>
      buildFilterClause('postgresql', columns, [
        { column: 'id; DROP TABLE users', operator: 'eq', value: '1' },
      ])
    ).toThrow(StudioValidationError);
  });

  it('rejects an unknown operator and a missing value', () => {
    expect(() =>
      buildFilterClause('postgresql', columns, [
        { column: 'id', operator: 'sneaky' as 'eq', value: '1' },
      ])
    ).toThrow(StudioValidationError);
    expect(() =>
      buildFilterClause('postgresql', columns, [{ column: 'id', operator: 'eq' }])
    ).toThrow(StudioValidationError);
  });

  it('escapes LIKE wildcards and casts to text on postgres', () => {
    const clause = buildFilterClause('postgresql', columns, [
      { column: 'title', operator: 'contains', value: '50%_off' },
    ]);

    expect(clause).toBe(`WHERE "title"::text LIKE '%50\\%\\_off%' ESCAPE '\\'`);
  });

  it('joins several filters with AND, capped at ten', () => {
    const many = Array.from({ length: 25 }, () => ({
      column: 'id' as const,
      operator: 'eq' as const,
      value: '1',
    }));
    const clause = buildFilterClause('postgresql', columns, many);
    expect(clause.split(' AND ')).toHaveLength(10);
  });

  it('needs no value for null checks', () => {
    expect(buildFilterClause('mysql', columns, [{ column: 'title', operator: 'isNull' }])).toBe(
      'WHERE `title` IS NULL'
    );
  });
});

describe('buildPkClause', () => {
  it('matches on every primary-key column', () => {
    expect(buildPkClause('postgresql', ['a', 'b'], { a: 1, b: 'x' })).toBe(
      `"a" = '1' AND "b" = 'x'`
    );
  });

  it('uses IS NULL rather than = NULL', () => {
    expect(buildPkClause('postgresql', ['a'], { a: null })).toBe('"a" IS NULL');
  });

  it('refuses to build a clause it cannot make specific', () => {
    expect(() => buildPkClause('postgresql', [], {})).toThrow(StudioValidationError);
    expect(() => buildPkClause('postgresql', ['a'], { b: 1 })).toThrow(StudioValidationError);
  });
});

describe('statement builders', () => {
  it('qualifies with the schema on postgres and not on mysql', () => {
    expect(qualifiedName('postgresql', 'public', 'users')).toBe('"public"."users"');
    expect(qualifiedName('mysql', 'app', 'users')).toBe('`users`');
  });

  it('stops counting one row past the cap', () => {
    expect(countSql('"public"."t"', '', 100)).toContain('LIMIT 101');
  });

  it('asks postgres for the page as one json document', () => {
    const sql = selectRowsSql({
      engine: 'postgresql',
      target: '"public"."t"',
      where: 'WHERE "a" = 1',
      orderClause: 'ORDER BY "a" ASC',
      pageSize: 25,
      offset: 50,
      columns: [column({ name: 'a' })],
    });

    expect(sql).toContain('json_agg');
    expect(sql).toContain('LIMIT 25 OFFSET 50');
  });

  it('projects mysql columns explicitly and previews binary ones as hex', () => {
    const sql = selectRowsSql({
      engine: 'mysql',
      target: '`t`',
      where: '',
      orderClause: '',
      pageSize: 10,
      offset: 0,
      columns: [column({ name: 'a' }), column({ name: 'blob_col', editable: false })],
    });

    expect(sql).toContain("'a', _q.`a`");
    expect(sql).toContain("CONCAT('0x', HEX(LEFT(_q.`blob_col`, 256)))");
    // Row order is not guaranteed by JSON_ARRAYAGG, so the page carries its own ordinal.
    expect(sql).toContain('ROW_NUMBER() OVER ()');
  });

  it('wraps a write so the script ends with the affected count', () => {
    expect(mutationSql('postgresql', 'UPDATE t SET a = 1')).toContain('RETURNING 1');
    expect(mutationSql('mysql', 'UPDATE t SET a = 1')).toContain('SELECT ROW_COUNT()');
  });
});

describe('cancelQuerySql', () => {
  it('scopes the cancel to the current database and never to itself', () => {
    const sql = cancelQuerySql('postgresql', 42);
    expect(sql).toContain('pg_cancel_backend(pid)');
    expect(sql).toContain('pid = 42');
    expect(sql).toContain('datname = current_database()');
    expect(sql).toContain('pid <> pg_backend_pid()');
  });

  it('confirms ownership before killing on mysql', () => {
    expect(cancelQuerySql('mysql', 42)).toContain('information_schema.PROCESSLIST');
    expect(mysqlKillQuerySql(42)).toBe('KILL QUERY 42;');
  });

  it('refuses anything that is not a positive integer id', () => {
    for (const id of [0, -1, 1.5, Number.NaN, '42; DROP TABLE t' as unknown as number]) {
      expect(() => cancelQuerySql('postgresql', id)).toThrow(StudioValidationError);
      expect(() => mysqlKillQuerySql(id)).toThrow(StudioValidationError);
    }
  });
});

describe('toTableSchema', () => {
  const raw = (overrides: Partial<RawColumn> & { name: string }): RawColumn => ({
    dataType: 'text',
    isNullable: true,
    defaultValue: null,
    ordinal: 1,
    isPrimaryKey: false,
    kind: 'table',
    ...overrides,
  });

  it('orders by ordinal and collects the primary key', () => {
    const schema = toTableSchema('postgresql', 'public', 'users', [
      raw({ name: 'email', ordinal: 2 }),
      raw({ name: 'id', ordinal: 1, isPrimaryKey: true, dataType: 'integer' }),
    ]);

    expect(schema.columns.map((c) => c.name)).toEqual(['id', 'email']);
    expect(schema.primaryKey).toEqual(['id']);
    expect(schema.editable).toBe(true);
  });

  it('marks binary columns non-editable per engine', () => {
    expect(
      toTableSchema('postgresql', 'public', 't', [raw({ name: 'b', dataType: 'bytea' })]).columns[0]
        .editable
    ).toBe(false);
    expect(
      toTableSchema('mysql', 'app', 't', [raw({ name: 'b', dataType: 'longblob' })]).columns[0]
        .editable
    ).toBe(false);
  });

  it('never lets a view or a keyless table be edited', () => {
    expect(
      toTableSchema('postgresql', 'public', 'v', [raw({ name: 'a', kind: 'view' })]).editable
    ).toBe(false);
    expect(toTableSchema('postgresql', 'public', 't', [raw({ name: 'a' })]).editable).toBe(false);
  });
});
