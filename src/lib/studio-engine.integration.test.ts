/**
 * Studio engine integration tests — the generated SQL run against real PostgreSQL and MySQL.
 *
 * Only the SSH hop is replaced: the command string is exactly what production sends, executed
 * with a local shell instead of over the wire. That covers the parts unit tests cannot reach —
 * whether the catalog queries are valid, whether the escaping matches what the engines parse,
 * and whether the read-only wrappers actually refuse a write.
 *
 * Opt-in, because it needs Docker and pulls images:
 *   PUSHIFY_STUDIO_IT=1 npx vitest run src/lib/studio-engine.integration.test.ts
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildClientCommand,
  buildFilterClause,
  buildPkClause,
  columnsSql,
  consoleGridSql,
  countSql,
  extractEngineError,
  mutationSql,
  parseAffected,
  parseCommandTag,
  parseJsonRows,
  cancelQuerySql,
  createIndexSql,
  insertRowsSql,
  dropIndexSql,
  indexesSql,
  normalizeIndexColumns,
  parseMysqlXml,
  prologue,
  runningQueriesSql,
  slowQuerySupportSql,
  qualifiedName,
  rowEstimateSql,
  selectRowsSql,
  stripPrologueTags,
  toSqlValue,
  toTableSchema,
  MYSQL_SCHEMA_MAP_SQL,
  MYSQL_TABLES_SQL,
  PG_SCHEMA_MAP_SQL,
  PG_TABLES_SQL,
  type RawColumn,
  type StudioEngine,
  type StudioTableSchema,
} from './studio-sql';
import { renderColumnDefinition, renderTableBody } from './sql-ddl';

const execAsync = promisify(exec);
const ENABLED = process.env.PUSHIFY_STUDIO_IT === '1';

const CREDENTIALS = {
  username: 'studio_user',
  password: 'studio_pass',
  databaseName: 'studio_db',
};

interface EngineFixture {
  engine: StudioEngine;
  container: string;
  image: string;
  schema: string;
  runArgs: string[];
  readyCommand: string;
}

const FIXTURES: EngineFixture[] = [
  {
    engine: 'postgresql',
    container: 'pushify-studio-it-pg',
    image: 'postgres:16-alpine',
    schema: 'public',
    runArgs: [
      `-e POSTGRES_USER=${CREDENTIALS.username}`,
      `-e POSTGRES_PASSWORD=${CREDENTIALS.password}`,
      `-e POSTGRES_DB=${CREDENTIALS.databaseName}`,
    ],
    readyCommand: `pg_isready -U ${CREDENTIALS.username} -d ${CREDENTIALS.databaseName}`,
  },
  {
    engine: 'mysql',
    container: 'pushify-studio-it-mysql',
    image: 'mysql:8.0',
    schema: CREDENTIALS.databaseName,
    runArgs: [
      `-e MYSQL_ROOT_PASSWORD=${CREDENTIALS.password}`,
      `-e MYSQL_USER=${CREDENTIALS.username}`,
      `-e MYSQL_PASSWORD=${CREDENTIALS.password}`,
      `-e MYSQL_DATABASE=${CREDENTIALS.databaseName}`,
    ],
    readyCommand: `mysqladmin ping -u${CREDENTIALS.username} -p${CREDENTIALS.password} --silent`,
  },
];

async function sh(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(error), code: e.code ?? 1 };
  }
}

async function startContainer(fixture: EngineFixture): Promise<void> {
  await sh(`docker rm -f ${fixture.container}`);
  const started = await sh(
    `docker run -d --name ${fixture.container} ${fixture.runArgs.join(' ')} ${fixture.image}`
  );
  if (started.code !== 0) throw new Error(`could not start ${fixture.image}: ${started.stderr}`);

  // First boot initialises the data directory, which is the slow part.
  const deadline = Date.now() + 180_000;
  for (;;) {
    const ready = await sh(`docker exec ${fixture.container} ${fixture.readyCommand}`);
    if (ready.code === 0) break;
    if (Date.now() > deadline) throw new Error(`${fixture.image} never became ready`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  // The container's own probe can pass while the credentials we use are still being created,
  // so readiness means "answers a query sent the way the studio sends one".
  for (;;) {
    const probe = await run(fixture, 'SELECT 1;', { readOnly: true });
    if (probe.code === 0 && !extractEngineError(probe.stderr)) return;
    if (Date.now() > deadline) throw new Error(`${fixture.image} never accepted a query`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Run a script the way the service would, minus the SSH hop. */
async function run(
  fixture: EngineFixture,
  script: string,
  options: { readOnly?: boolean; quiet?: boolean; xml?: boolean } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = buildClientCommand({
    engine: fixture.engine,
    containerName: fixture.container,
    username: CREDENTIALS.username,
    databaseName: CREDENTIALS.databaseName,
    password: CREDENTIALS.password,
    script: `${prologue(fixture.engine, options.readOnly ?? false)}\n${script}\n`,
    quiet: options.quiet,
    xml: options.xml,
    // macOS has no coreutils `timeout`; the wrapper itself is covered by the unit suite.
    timeoutSeconds: 0,
  });

  return sh(command);
}

async function expectOk(
  fixture: EngineFixture,
  script: string,
  options?: { readOnly?: boolean; quiet?: boolean; xml?: boolean }
): Promise<string> {
  const result = await run(fixture, script, options);
  const engineError = extractEngineError(result.stderr);
  if (engineError) throw new Error(`${fixture.engine}: ${engineError}`);
  return result.stdout;
}

async function resolve(
  fixture: EngineFixture,
  table: string
): Promise<StudioTableSchema> {
  const raw = await expectOk(
    fixture,
    columnsSql(fixture.engine, fixture.schema, table),
    { readOnly: true }
  );
  const parsed = parseJsonRows(raw) as unknown as RawColumn[];
  return toTableSchema(fixture.engine, fixture.schema, table, parsed);
}

describe.runIf(ENABLED)('studio engine against real databases', () => {
  beforeAll(async () => {
    await Promise.all(FIXTURES.map(startContainer));
  }, 400_000);

  afterAll(async () => {
    await Promise.all(FIXTURES.map((fixture) => sh(`docker rm -f ${fixture.container}`)));
  }, 60_000);

  describe.each(FIXTURES)('$engine', (fixture) => {
    const engine = fixture.engine;
    const ref = (table: string) => qualifiedName(engine, fixture.schema, table);

    it('creates a table from a rendered definition', async () => {
      const body = renderTableBody(engine, [
        { name: 'id', type: engine === 'mysql' ? 'int' : 'integer', primaryKey: true, autoIncrement: true },
        { name: 'title', type: 'varchar', length: 200, nullable: false },
        { name: 'body', type: 'text' },
        { name: 'score', type: engine === 'mysql' ? 'decimal' : 'numeric', length: 10, scale: 2 },
        { name: 'payload', type: engine === 'mysql' ? 'blob' : 'bytea' },
        {
          name: 'created_at',
          type: engine === 'mysql' ? 'datetime' : 'timestamptz',
          nullable: false,
          defaultValue: 'now()',
        },
      ]);

      await expectOk(fixture, `CREATE TABLE ${ref('posts')} (\n  ${body}\n);`);

      const schema = await resolve(fixture, 'posts');
      expect(schema.kind).toBe('table');
      expect(schema.primaryKey).toEqual(['id']);
      expect(schema.editable).toBe(true);
      expect(schema.columns.map((c) => c.name)).toEqual([
        'id',
        'title',
        'body',
        'score',
        'payload',
        'created_at',
      ]);

      const title = schema.columns.find((c) => c.name === 'title')!;
      expect(title.isNullable).toBe(false);
      expect(title.dataType).toMatch(/varchar|character varying/i);

      // Binary columns are the ones the grid refuses to edit.
      expect(schema.columns.find((c) => c.name === 'payload')!.editable).toBe(false);
      expect(schema.columns.find((c) => c.name === 'body')!.editable).toBe(true);
    });

    it('lists the table with a primary-key flag', async () => {
      const raw = await expectOk(
        fixture,
        engine === 'postgresql' ? PG_TABLES_SQL : MYSQL_TABLES_SQL,
        { readOnly: true }
      );
      const tables = parseJsonRows(raw) as unknown as {
        name: string;
        kind: string;
        hasPrimaryKey: boolean;
      }[];

      const posts = tables.find((table) => table.name === 'posts');
      expect(posts).toBeDefined();
      expect(posts!.kind).toBe('table');
      expect(Boolean(posts!.hasPrimaryKey)).toBe(true);
    });

    it('returns every table with its columns in the schema map', async () => {
      const raw = await expectOk(
        fixture,
        engine === 'postgresql' ? PG_SCHEMA_MAP_SQL : MYSQL_SCHEMA_MAP_SQL,
        { readOnly: true }
      );
      const tables = parseJsonRows(raw) as unknown as {
        name: string;
        columns: { name: string }[];
      }[];

      const posts = tables.find((table) => table.name === 'posts');
      expect(posts).toBeDefined();
      expect(posts!.columns.map((c) => c.name)).toContain('title');
    });

    it('round-trips values that would break naive escaping', async () => {
      const schema = await resolve(fixture, 'posts');
      const hostile = [
        "O'Brien",
        'back\\slash',
        "'; DROP TABLE posts; --",
        'line1\nline2',
        'tab\there',
        '100% _underscore_',
        'unicode: ıçğüşö 日本語 🎉',
        '"double" quotes',
      ];

      for (const value of hostile) {
        const statement = `INSERT INTO ${ref('posts')} (${['title', 'body']
          .map((c) => (engine === 'mysql' ? `\`${c}\`` : `"${c}"`))
          .join(', ')}) VALUES (${toSqlValue(engine, value)}, ${toSqlValue(engine, 'x')})`;

        const affected = parseAffected(await expectOk(fixture, mutationSql(engine, statement)));
        expect(affected).toBe(1);
      }

      const rows = parseJsonRows(
        await expectOk(
          fixture,
          selectRowsSql({
            engine,
            target: ref('posts'),
            where: '',
            orderClause: `ORDER BY ${engine === 'mysql' ? '`id`' : '"id"'} ASC`,
            pageSize: 100,
            offset: 0,
            columns: schema.columns,
          }),
          { readOnly: true }
        )
      );

      // The table survived, and every value came back byte-for-byte.
      expect(rows).toHaveLength(hostile.length);
      expect(rows.map((row) => row.title)).toEqual(hostile);
    });

    it('counts, estimates and pages in a single round trip', async () => {
      const schema = await resolve(fixture, 'posts');
      const script = [
        countSql(ref('posts'), '', 10_000),
        rowEstimateSql(engine, fixture.schema, 'posts'),
        selectRowsSql({
          engine,
          target: ref('posts'),
          where: '',
          orderClause: `ORDER BY ${engine === 'mysql' ? '`id`' : '"id"'} ASC`,
          pageSize: 3,
          offset: 2,
          columns: schema.columns,
        }),
      ].join('\n');

      const lines = (await expectOk(fixture, script, { readOnly: true }))
        .split('\n')
        .filter((line) => line.trim().length > 0);

      expect(Number(lines[0])).toBe(8);
      expect(Number.isFinite(Number(lines[1]))).toBe(true);

      const rows = parseJsonRows(lines.slice(2).join('\n'));
      expect(rows).toHaveLength(3);
      // Third row onwards, in id order.
      expect(rows[0].title).toBe("'; DROP TABLE posts; --");
    });

    it('filters without letting wildcards or quotes leak into the pattern', async () => {
      const schema = await resolve(fixture, 'posts');

      const select = async (where: string) =>
        parseJsonRows(
          await expectOk(
            fixture,
            selectRowsSql({
              engine,
              target: ref('posts'),
              where,
              orderClause: '',
              pageSize: 50,
              offset: 0,
              columns: schema.columns,
            }),
            { readOnly: true }
          )
        );

      const exact = await select(
        buildFilterClause(engine, schema.columns, [
          { column: 'title', operator: 'eq', value: "O'Brien" },
        ])
      );
      expect(exact).toHaveLength(1);

      // `%` and `_` in user input must match literally, not as wildcards.
      const literalWildcards = await select(
        buildFilterClause(engine, schema.columns, [
          { column: 'title', operator: 'contains', value: '100% _under' },
        ])
      );
      expect(literalWildcards).toHaveLength(1);

      const noWildcardMatch = await select(
        buildFilterClause(engine, schema.columns, [
          { column: 'title', operator: 'contains', value: '100%%%' },
        ])
      );
      expect(noWildcardMatch).toHaveLength(0);

      const nulls = await select(
        buildFilterClause(engine, schema.columns, [{ column: 'score', operator: 'isNull' }])
      );
      expect(nulls.length).toBeGreaterThan(0);
    });

    it('updates and deletes exactly one row by primary key', async () => {
      const schema = await resolve(fixture, 'posts');
      const rows = parseJsonRows(
        await expectOk(
          fixture,
          selectRowsSql({
            engine,
            target: ref('posts'),
            where: '',
            orderClause: `ORDER BY ${engine === 'mysql' ? '`id`' : '"id"'} ASC`,
            pageSize: 1,
            offset: 0,
            columns: schema.columns,
          }),
          { readOnly: true }
        )
      );

      const pk = { id: rows[0].id };
      const where = buildPkClause(engine, schema.primaryKey, pk);

      const updated = parseAffected(
        await expectOk(
          fixture,
          mutationSql(
            engine,
            `UPDATE ${ref('posts')} SET ${engine === 'mysql' ? '`body`' : '"body"'} = ${toSqlValue(engine, 'edited')} WHERE ${where}`
          )
        )
      );
      expect(updated).toBe(1);

      const deleted = parseAffected(
        await expectOk(fixture, mutationSql(engine, `DELETE FROM ${ref('posts')} WHERE ${where}`))
      );
      expect(deleted).toBe(1);
    });

    it('refuses a write inside the read-only wrapper', async () => {
      const script =
        engine === 'postgresql'
          ? `BEGIN READ ONLY;\nDELETE FROM ${ref('posts')};\nCOMMIT;`
          : `START TRANSACTION READ ONLY;\nDELETE FROM ${ref('posts')};\nCOMMIT;`;

      const result = await run(fixture, script, { readOnly: true, quiet: false });
      expect(extractEngineError(result.stderr)).toBeTruthy();

      // And the rows are still there.
      const remaining = await expectOk(fixture, countSql(ref('posts'), '', 100), {
        readOnly: true,
      });
      expect(Number(remaining.trim().split('\n')[0])).toBeGreaterThan(0);
    });

    it('runs a console SELECT through the grid wrapper', async () => {
      if (engine === 'postgresql') {
        const raw = await expectOk(
          fixture,
          consoleGridSql(`SELECT id, title FROM ${ref('posts')} ORDER BY id`, 2),
          { readOnly: true }
        );
        const rows = parseJsonRows(raw);
        // The cap is applied by the engine: 2 asked for, 3 fetched to detect truncation.
        expect(rows.length).toBe(3);
        expect(Object.keys(rows[0])).toEqual(['id', 'title']);
      } else {
        const raw = await expectOk(
          fixture,
          `SELECT id, title FROM ${ref('posts')} ORDER BY id LIMIT 3;`,
          { readOnly: true, xml: true }
        );
        const parsed = parseMysqlXml(raw);
        expect(parsed.columns).toEqual(['id', 'title']);
        expect(parsed.rows).toHaveLength(3);
      }
    });

    it('reports NULL distinctly in console output', async () => {
      if (engine === 'postgresql') {
        const rows = parseJsonRows(
          await expectOk(fixture, consoleGridSql(`SELECT NULL::text AS a, '' AS b`, 10), {
            readOnly: true,
          })
        );
        expect(rows[0].a).toBeNull();
        expect(rows[0].b).toBe('');
      } else {
        const parsed = parseMysqlXml(
          await expectOk(fixture, `SELECT NULL AS a, '' AS b;`, { readOnly: true, xml: true })
        );
        expect(parsed.rows[0].a).toBeNull();
        expect(parsed.rows[0].b).toBe('');
      }
    });

    it('adds, renames and drops schema objects', async () => {
      const definition = renderColumnDefinition(engine, {
        name: 'tag',
        type: 'varchar',
        length: 40,
        defaultValue: 'none',
      });
      await expectOk(fixture, `ALTER TABLE ${ref('posts')} ADD COLUMN ${definition};`);

      let schema = await resolve(fixture, 'posts');
      const tag = schema.columns.find((c) => c.name === 'tag');
      expect(tag).toBeDefined();
      expect(tag!.defaultValue).toMatch(/none/);

      await expectOk(
        fixture,
        `ALTER TABLE ${ref('posts')} DROP COLUMN ${engine === 'mysql' ? '`tag`' : '"tag"'};`
      );
      schema = await resolve(fixture, 'posts');
      expect(schema.columns.find((c) => c.name === 'tag')).toBeUndefined();

      await expectOk(
        fixture,
        `ALTER TABLE ${ref('posts')} RENAME TO ${engine === 'mysql' ? '`articles`' : '"articles"'};`
      );
      const renamed = await resolve(fixture, 'articles');
      expect(renamed.columns.length).toBeGreaterThan(0);

      await expectOk(fixture, `TRUNCATE TABLE ${ref('articles')};`);
      const afterTruncate = await expectOk(fixture, countSql(ref('articles'), '', 100), {
        readOnly: true,
      });
      expect(Number(afterTruncate.trim())).toBe(0);

      await expectOk(fixture, `DROP TABLE ${ref('articles')};`);
      const tables = parseJsonRows(
        await expectOk(fixture, engine === 'postgresql' ? PG_TABLES_SQL : MYSQL_TABLES_SQL, {
          readOnly: true,
        })
      ) as unknown as { name: string }[];
      expect(tables.find((table) => table.name === 'articles')).toBeUndefined();
    });

    it('reports what a write touched', async () => {
      await expectOk(
        fixture,
        `CREATE TABLE ${ref('counters')} (${engine === 'mysql' ? '`n` int' : '"n" integer'});`
      );
      await expectOk(
        fixture,
        `INSERT INTO ${ref('counters')} VALUES (1), (2), (3);`,
        { quiet: false }
      );

      if (engine === 'postgresql') {
        const raw = await run(fixture, `UPDATE ${ref('counters')} SET "n" = "n" + 1;`, {
          quiet: false,
        });
        const tag = parseCommandTag(stripPrologueTags(raw.stdout));
        expect(tag.command).toBe('UPDATE');
        expect(tag.affected).toBe(3);
      } else {
        const parsed = parseMysqlXml(
          await expectOk(
            fixture,
            `UPDATE ${ref('counters')} SET \`n\` = \`n\` + 1;\nSELECT ROW_COUNT() AS affected_rows;`,
            { xml: true }
          )
        );
        expect(Number(parsed.rows[0].affected_rows)).toBe(3);
      }

      await expectOk(fixture, `DROP TABLE ${ref('counters')};`);
    });

    it('imports a batch of rows the way a CSV arrives', async () => {
      await expectOk(
        fixture,
        `CREATE TABLE ${ref('import_demo')} (${engine === 'mysql' ? '`name` varchar(100), `note` text, `amount` decimal(10,2)' : '"name" varchar(100), "note" text, "amount" numeric(10,2)'});`
      );

      const rows: (string | null)[][] = [
        ['alice', 'plain', '10.50'],
        ["O'Brien", 'has "quotes", commas and\nnewlines', '0'],
        ['empty', null, '3.14'],
      ];

      const affected = parseAffected(
        await expectOk(
          fixture,
          mutationSql(
            engine,
            insertRowsSql(engine, ref('import_demo'), ['name', 'note', 'amount'], rows)
          )
        )
      );
      expect(affected).toBe(3);

      const schema = await resolve(fixture, 'import_demo');
      const stored = parseJsonRows(
        await expectOk(
          fixture,
          selectRowsSql({
            engine,
            target: ref('import_demo'),
            where: '',
            orderClause: `ORDER BY ${engine === 'mysql' ? '`name`' : '"name"'} ASC`,
            pageSize: 10,
            offset: 0,
            columns: schema.columns,
          }),
          { readOnly: true }
        )
      );

      expect(stored).toHaveLength(3);
      const obrien = stored.find((row) => row.name === "O'Brien")!;
      expect(obrien.note).toBe('has "quotes", commas and\nnewlines');
      // An empty cell arrives as null, not as an empty string.
      expect(stored.find((row) => row.name === 'empty')!.note).toBeNull();

      await expectOk(fixture, `DROP TABLE ${ref('import_demo')};`);
    });

    it('creates, lists and drops an index', async () => {
      await expectOk(
        fixture,
        `CREATE TABLE ${ref('idx_demo')} (${engine === 'mysql' ? '`a` int, `b` varchar(50)' : '"a" integer, "b" varchar(50)'});`
      );

      await expectOk(
        fixture,
        createIndexSql({
          engine,
          schema: fixture.schema,
          table: 'idx_demo',
          name: 'idx_demo_a_b',
          columns: ['a', 'b'],
          unique: true,
          method: 'btree',
        })
      );

      const indexes = parseJsonRows(
        await expectOk(fixture, indexesSql(engine, fixture.schema, 'idx_demo'), { readOnly: true })
      ) as unknown as { name: string; isUnique: boolean; columns: unknown }[];

      const created = indexes.find((index) => index.name === 'idx_demo_a_b');
      expect(created).toBeDefined();
      expect(Boolean(created!.isUnique)).toBe(true);
      // MySQL reports index columns unordered, so the ordinal has to survive the trip.
      expect(normalizeIndexColumns(created!.columns)).toEqual(['a', 'b']);

      await expectOk(fixture, dropIndexSql(engine, fixture.schema, 'idx_demo', 'idx_demo_a_b'));
      const after = parseJsonRows(
        await expectOk(fixture, indexesSql(engine, fixture.schema, 'idx_demo'), { readOnly: true })
      ) as unknown as { name: string }[];
      expect(after.find((index) => index.name === 'idx_demo_a_b')).toBeUndefined();

      await expectOk(fixture, `DROP TABLE ${ref('idx_demo')};`);
    });

    it('reports whether statement statistics are available', async () => {
      const support = await run(fixture, slowQuerySupportSql(engine), { readOnly: true });
      // Either it answers with a count or it refuses; both are answers the UI can render.
      const answered = support.code === 0 && /^\d+$/.test(support.stdout.trim());
      const refused = extractEngineError(support.stderr) !== null;
      expect(answered || refused).toBe(true);
    });

    it('lists what is running right now', async () => {
      const result = await run(fixture, runningQueriesSql(engine), { readOnly: true });
      if (extractEngineError(result.stderr)) {
        // A managed user without PROCESS privileges is an expected outcome, not a failure.
        expect(extractEngineError(result.stderr)).toMatch(/denied|privilege|permission/i);
        return;
      }
      expect(Array.isArray(parseJsonRows(result.stdout))).toBe(true);
    });

    it('reports nothing to cancel for an id that is not running', async () => {
      // 999999 is not a live backend; the statement must come back clean rather than error.
      const raw = await expectOk(fixture, cancelQuerySql(engine, 999999));
      expect(Number(raw.trim())).toBe(0);
    });

    it('surfaces a real engine error', async () => {
      const result = await run(fixture, 'SELECT * FROM table_that_does_not_exist;', {
        readOnly: true,
      });
      const message = extractEngineError(result.stderr);
      expect(message).toBeTruthy();
      expect(message!.toLowerCase()).toMatch(/exist|unknown/);
    });
  });
});
