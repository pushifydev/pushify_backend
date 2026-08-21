/**
 * The database studio's engine layer: the SQL it generates, the shell command that carries it,
 * and the parsing of what comes back.
 *
 * Everything here is pure — no SSH, no database, no HTTP — so it can be exercised directly
 * against real PostgreSQL and MySQL containers in the integration suite, and asserted on
 * string-by-string in the unit suite. The service on top adds auth, sessions and transport.
 */
import {
  escapeLikePattern,
  isSafeIdentifier,
  quoteIdent,
  quoteLiteral,
  shellQuote,
  type SqlEngine,
} from './sql-escape';
import { StudioValidationError } from './studio-errors';

export type StudioEngine = SqlEngine;

// ============ Types ============

export interface StudioColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  /** false for binary/blob columns — those are shown read-only as a hex preview */
  editable: boolean;
  ordinal: number;
}

export interface StudioTableSchema {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: StudioColumn[];
  primaryKey: string[];
  editable: boolean;
}

export type StudioFilterOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'startsWith' | 'endsWith' | 'isNull' | 'isNotNull';

export interface StudioFilter {
  column: string;
  operator: StudioFilterOperator;
  value?: string;
}

// ============ Limits ============

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const COUNT_CAP = 100_000;
/** Unfiltered counts stop here and fall back to the planner's estimate, so a big table never scans. */
export const UNFILTERED_COUNT_CAP = 10_000;
export const CONSOLE_ROW_CAP = 500;
export const EXPORT_ROW_CAP = 20_000;
export const SCHEMA_MAP_TABLE_CAP = 500;
export const MAX_CELL_CHARS = 4_000;
export const MAX_OUTPUT_BYTES = 8_000_000;
export const MAX_SQL_LENGTH = 20_000;
export const MAX_DELETE_ROWS = 200;
export const STATEMENT_TIMEOUT_MS = 20_000;
export const COMMAND_TIMEOUT_SECONDS = 30;
export const MAX_FILTERS = 10;

/** Column types the grid never edits — the value we show is a lossy preview. */
const PG_BINARY_TYPES = /^(bytea|bit|bit varying)/i;
const MYSQL_BINARY_TYPES = /(blob|binary|geometry|point|polygon|linestring)/i;

// ============ Values ============

export function assertSafeIdentifier(name: unknown): string {
  if (!isSafeIdentifier(name)) throw new StudioValidationError('studioInvalidIdentifier');
  return name;
}

/**
 * Render a JSON value as a SQL literal. Everything except NULL/boolean goes out as a quoted
 * string and is coerced by the target column's type, which keeps dates, json, arrays and
 * numerics working without modelling every type system.
 */
export function toSqlValue(engine: StudioEngine, value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') {
    if (engine === 'postgresql') return value ? 'TRUE' : 'FALSE';
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StudioValidationError('studioInvalidValue');
    return quoteLiteral(engine, String(value));
  }
  if (typeof value === 'string') return quoteLiteral(engine, value);
  if (typeof value === 'object') return quoteLiteral(engine, JSON.stringify(value));
  throw new StudioValidationError('studioInvalidValue');
}

// ============ Transport ============

export interface ClientCommandOptions {
  engine: StudioEngine;
  containerName: string;
  username: string;
  databaseName: string;
  password: string;
  script: string;
  /** false keeps psql's command tags, which the console's raw path shows */
  quiet?: boolean;
  /** MySQL only: ask for XML so arbitrary result sets keep column names and NULLs */
  xml?: boolean;
  /** wall-clock ceiling via coreutils `timeout`; 0 omits it (macOS dev boxes have no `timeout`) */
  timeoutSeconds?: number;
  maxOutputBytes?: number;
}

export function prologue(engine: StudioEngine, readOnly: boolean): string {
  if (engine === 'postgresql') {
    const lines = [
      'SET standard_conforming_strings = on;',
      `SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms';`,
    ];
    if (readOnly) lines.push('SET default_transaction_read_only = on;');
    return lines.join('\n');
  }
  const lines = [
    "SET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '');",
    `SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_MS};`,
  ];
  if (readOnly) lines.push('SET SESSION transaction_read_only = ON;');
  return lines.join('\n');
}

/**
 * The SQL is base64'd onto the client's stdin, so nothing the user typed is ever seen by the
 * shell. Only values we control (container, user, password) are shell-quoted.
 */
export function buildClientCommand(options: ClientCommandOptions): string {
  const payload = Buffer.from(options.script, 'utf8').toString('base64');
  const timeout = options.timeoutSeconds ?? COMMAND_TIMEOUT_SECONDS;
  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  const client =
    options.engine === 'postgresql'
      ? [
          'docker exec -i',
          `-e PGPASSWORD=${shellQuote(options.password)}`,
          '-e PGCONNECT_TIMEOUT=10',
          shellQuote(options.containerName),
          'psql -X -A -t -v ON_ERROR_STOP=1',
          options.quiet === false ? '' : '-q',
          `-U ${shellQuote(options.username)}`,
          `-d ${shellQuote(options.databaseName)}`,
          '-f -',
        ]
      : [
          'docker exec -i',
          `-e MYSQL_PWD=${shellQuote(options.password)}`,
          shellQuote(options.containerName),
          'mysql --batch --connect-timeout=10',
          options.xml ? '--xml' : '--raw --silent --skip-column-names',
          `-u ${shellQuote(options.username)}`,
          shellQuote(options.databaseName),
        ];

  const pipeline = client.filter(Boolean).join(' ');
  const guarded = timeout > 0 ? `timeout ${timeout} ${pipeline}` : pipeline;
  return `printf '%s' ${shellQuote(payload)} | base64 -d | ${guarded} | head -c ${maxBytes}`;
}

/** Client noise that is not an actual query error. */
function isIgnorableStderr(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  if (/^mysql: \[Warning\]/i.test(l)) return true;
  if (/^Warning: Using a password/i.test(l)) return true;
  return false;
}

/**
 * Both clients also write notices to stderr (psql `NOTICE:`, mysql warnings), so a non-empty
 * stderr is not by itself a failure — only a line that actually reports an error is.
 */
export function extractEngineError(stderr: string): string | null {
  const lines = stderr.split('\n').filter((line) => !isIgnorableStderr(line));
  if (lines.length === 0) return null;
  if (!lines.some((line) => /\b(error|fatal|panic)\b/i.test(line))) return null;
  return lines.join('\n').trim().slice(0, 2000);
}

// ============ Parsing ============

/** The console's raw path shows command tags; drop the ones our own prologue produced. */
export function stripPrologueTags(output: string): string {
  return output
    .split('\n')
    .filter((line) => !['SET', 'BEGIN', 'COMMIT', 'START TRANSACTION'].includes(line.trim()))
    .join('\n')
    .trim();
}

export function parseJsonRows(raw: string): Record<string, unknown>[] {
  const text = raw.trim();
  if (!text || text === 'NULL') return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    throw new StudioValidationError('studioQueryFailed');
  }
}

/** Keep one huge cell from blowing up the response; the grid marks the value as truncated. */
export function capCell(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}…`;
  }
  if (value !== null && typeof value === 'object') {
    const encoded = JSON.stringify(value);
    if (encoded.length > MAX_CELL_CHARS) return `${encoded.slice(0, MAX_CELL_CHARS)}…`;
  }
  return value;
}

export function capRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = capCell(value);
    return out;
  });
}

export function collectColumns(rows: Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

/** psql prints a command tag such as `UPDATE 3`; mysql reports the same via ROW_COUNT(). */
export function parseCommandTag(output: string): { command: string | null; affected: number | null } {
  const tag = output
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => /^[A-Z]+( \d+)+$/.test(line));

  if (!tag) return { command: null, affected: null };

  const parts = tag.split(' ');
  const numbers = parts.slice(1).map(Number);
  return { command: parts[0], affected: numbers.length > 0 ? numbers[numbers.length - 1] : null };
}

/** Mutation scripts end with a single count; that is the number of rows affected. */
export function parseAffected(raw: string): number {
  const last = raw.trim().split('\n').filter((line) => line.trim().length > 0).pop();
  const affected = Number(last);
  return Number.isFinite(affected) ? affected : 0;
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXml(value: string): string {
  return value
    .replace(/&(lt|gt|amp|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export function parseMysqlXml(
  xml: string,
  rowCap = CONSOLE_ROW_CAP
): { columns: string[]; rows: Record<string, unknown>[] } {
  // Multiple statements produce multiple <resultset> blocks; the last one with rows is the answer.
  const resultsets = xml.match(/<resultset[\s\S]*?<\/resultset>/g) ?? [];
  const target = [...resultsets].reverse().find((block) => block.includes('<row>')) ?? '';

  const columns: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const rowMatches = target.match(/<row>[\s\S]*?<\/row>/g) ?? [];

  for (const rowXml of rowMatches.slice(0, rowCap + 1)) {
    const row: Record<string, unknown> = {};
    const fieldRe = /<field name="([^"]*)"(?:\s+xsi:nil="true"\s*\/>|>([\s\S]*?)<\/field>)/g;
    let match: RegExpExecArray | null;
    while ((match = fieldRe.exec(rowXml)) !== null) {
      const name = decodeXml(match[1]);
      if (!columns.includes(name)) columns.push(name);
      row[name] = match[2] === undefined ? null : decodeXml(match[2]);
    }
    rows.push(row);
  }

  return { columns, rows };
}

// ============ Catalog SQL ============

export const PG_TABLES_SQL = `
SELECT coalesce(json_agg(_t ORDER BY _t.schema, _t.name), '[]'::json) FROM (
  SELECT n.nspname AS schema,
         c.relname AS name,
         CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS kind,
         GREATEST(c.reltuples, 0)::bigint AS "rowEstimate",
         pg_total_relation_size(c.oid)::bigint AS "sizeBytes",
         EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS "hasPrimaryKey"
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%'
    AND n.nspname NOT LIKE 'pg_temp%'
) _t;`;

export const MYSQL_TABLES_SQL = `
SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
  'schema', _t.TABLE_SCHEMA,
  'name', _t.TABLE_NAME,
  'kind', IF(_t.TABLE_TYPE = 'VIEW', 'view', 'table'),
  'rowEstimate', COALESCE(_t.TABLE_ROWS, 0),
  'sizeBytes', COALESCE(_t.DATA_LENGTH, 0) + COALESCE(_t.INDEX_LENGTH, 0),
  'hasPrimaryKey', EXISTS (
    SELECT 1 FROM information_schema.STATISTICS s
    WHERE s.TABLE_SCHEMA = _t.TABLE_SCHEMA AND s.TABLE_NAME = _t.TABLE_NAME AND s.INDEX_NAME = 'PRIMARY'
  )
)), JSON_ARRAY())
FROM information_schema.TABLES _t
WHERE _t.TABLE_SCHEMA = DATABASE();`;

/** Every table with its columns in one round trip — the autocomplete source for the console. */
export const PG_SCHEMA_MAP_SQL = `
SELECT coalesce(json_agg(_t ORDER BY _t.schema, _t.name), '[]'::json) FROM (
  SELECT n.nspname AS schema,
         c.relname AS name,
         CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS kind,
         json_agg(
           json_build_object('name', a.attname, 'dataType', format_type(a.atttypid, a.atttypmod))
           ORDER BY a.attnum
         ) AS columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%'
    AND n.nspname NOT LIKE 'pg_temp%'
  GROUP BY n.nspname, c.relname, c.relkind
  ORDER BY n.nspname, c.relname
  LIMIT ${SCHEMA_MAP_TABLE_CAP}
) _t;`;

export const MYSQL_SCHEMA_MAP_SQL = `
SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
  'schema', _t.TABLE_SCHEMA,
  'name', _t.TABLE_NAME,
  'kind', _t.kind,
  'columns', _t.cols
)), JSON_ARRAY())
FROM (
  SELECT c.TABLE_SCHEMA,
         c.TABLE_NAME,
         IF((SELECT tb.TABLE_TYPE FROM information_schema.TABLES tb
             WHERE tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME) = 'VIEW',
            'view', 'table') AS kind,
         JSON_ARRAYAGG(JSON_OBJECT(
           'name', c.COLUMN_NAME,
           'dataType', c.COLUMN_TYPE,
           'ordinal', c.ORDINAL_POSITION
         )) AS cols
  FROM information_schema.COLUMNS c
  WHERE c.TABLE_SCHEMA = DATABASE()
  GROUP BY c.TABLE_SCHEMA, c.TABLE_NAME
  ORDER BY c.TABLE_NAME
  LIMIT ${SCHEMA_MAP_TABLE_CAP}
) _t;`;

export function columnsSql(engine: StudioEngine, schema: string, table: string): string {
  if (engine === 'postgresql') {
    return `
SELECT coalesce(json_agg(_c ORDER BY _c.ordinal), '[]'::json) FROM (
  SELECT a.attname AS name,
         format_type(a.atttypid, a.atttypmod) AS "dataType",
         NOT a.attnotnull AS "isNullable",
         pg_get_expr(d.adbin, d.adrelid) AS "defaultValue",
         a.attnum AS ordinal,
         EXISTS (
           SELECT 1 FROM pg_index i
           WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
         ) AS "isPrimaryKey",
         CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS kind
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  WHERE n.nspname = ${quoteLiteral('postgresql', schema)}
    AND c.relname = ${quoteLiteral('postgresql', table)}
    AND a.attnum > 0
    AND NOT a.attisdropped
) _c;`;
  }

  return `
SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
  'name', c.COLUMN_NAME,
  'dataType', c.COLUMN_TYPE,
  'isNullable', c.IS_NULLABLE = 'YES',
  'defaultValue', c.COLUMN_DEFAULT,
  'ordinal', c.ORDINAL_POSITION,
  'isPrimaryKey', c.COLUMN_KEY = 'PRI',
  'kind', IF((SELECT tb.TABLE_TYPE FROM information_schema.TABLES tb
              WHERE tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME) = 'VIEW', 'view', 'table')
)), JSON_ARRAY())
FROM information_schema.COLUMNS c
WHERE c.TABLE_SCHEMA = DATABASE()
  AND c.TABLE_NAME = ${quoteLiteral('mysql', table)};`;
}

/** Planner estimate — a catalog read, so it costs nothing even on a huge table. */
export function rowEstimateSql(engine: StudioEngine, schema: string, table: string): string {
  if (engine === 'postgresql') {
    return `SELECT COALESCE((
      SELECT GREATEST(c.reltuples, 0)::bigint
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${quoteLiteral('postgresql', schema)}
        AND c.relname = ${quoteLiteral('postgresql', table)}
    ), 0);`;
  }
  return `SELECT COALESCE((
    SELECT TABLE_ROWS FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${quoteLiteral('mysql', table)}
  ), 0);`;
}

export interface RawColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  ordinal: number;
  isPrimaryKey: boolean;
  kind: 'table' | 'view';
}

/** Turn the catalog rows into the schema the rest of the studio works with. */
export function toTableSchema(
  engine: StudioEngine,
  schema: string,
  table: string,
  parsed: RawColumn[]
): StudioTableSchema {
  const binaryPattern = engine === 'postgresql' ? PG_BINARY_TYPES : MYSQL_BINARY_TYPES;

  const columns: StudioColumn[] = parsed
    .map((c) => ({
      name: c.name,
      dataType: c.dataType,
      isNullable: Boolean(c.isNullable),
      defaultValue: c.defaultValue ?? null,
      isPrimaryKey: Boolean(c.isPrimaryKey),
      editable: !binaryPattern.test(c.dataType),
      ordinal: Number(c.ordinal),
    }))
    .sort((a, b) => a.ordinal - b.ordinal);

  const kind = parsed[0]?.kind === 'view' ? 'view' : 'table';
  const primaryKey = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);

  return {
    schema,
    name: table,
    kind,
    columns,
    primaryKey,
    // Rows are only editable when a primary key can identify exactly one row.
    editable: kind === 'table' && primaryKey.length > 0,
  };
}

// ============ Query building ============

export function qualifiedName(engine: StudioEngine, schema: string, table: string): string {
  return engine === 'postgresql'
    ? `${quoteIdent('postgresql', schema)}.${quoteIdent('postgresql', table)}`
    : quoteIdent('mysql', table);
}

/** MySQL has no row_to_json, so the projection is built from the resolved column list. */
export function mysqlRowProjection(columns: StudioColumn[]): string {
  return columns
    .map((column) => {
      const ident = `_q.${quoteIdent('mysql', column.name)}`;
      const value = column.editable ? ident : `CONCAT('0x', HEX(LEFT(${ident}, 256)))`;
      return `${quoteLiteral('mysql', column.name)}, ${value}`;
    })
    .join(', ');
}

const COMPARISON_OPERATORS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

export function buildFilterClause(
  engine: StudioEngine,
  columns: StudioColumn[],
  filters: StudioFilter[] | undefined
): string {
  if (!filters || filters.length === 0) return '';

  const known = new Map(columns.map((c) => [c.name, c]));
  const parts = filters.slice(0, MAX_FILTERS).map((filter) => {
    const column = known.get(filter.column);
    if (!column) throw new StudioValidationError('studioInvalidIdentifier');

    const ident = quoteIdent(engine, column.name);

    switch (filter.operator) {
      case 'isNull':
        return `${ident} IS NULL`;
      case 'isNotNull':
        return `${ident} IS NOT NULL`;
      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        const escaped = escapeLikePattern(String(filter.value ?? ''));
        const pattern =
          filter.operator === 'contains'
            ? `%${escaped}%`
            : filter.operator === 'startsWith'
              ? `${escaped}%`
              : `%${escaped}`;
        // LIKE needs text on both sides; postgres will not apply it to a non-text column.
        const cast = engine === 'postgresql' ? `${ident}::text` : ident;
        return `${cast} LIKE ${quoteLiteral(engine, pattern)} ESCAPE ${quoteLiteral(engine, '\\')}`;
      }
      default: {
        const op = COMPARISON_OPERATORS[filter.operator];
        if (!op) throw new StudioValidationError('studioInvalidFilter');
        if (filter.value === undefined || filter.value === null) {
          throw new StudioValidationError('studioInvalidFilter');
        }
        // No cast here: the quoted literal is coerced to the column's own type, so numbers,
        // dates, uuids and enums all compare correctly (and can still use an index).
        return `${ident} ${op} ${toSqlValue(engine, filter.value)}`;
      }
    }
  });

  return `WHERE ${parts.join(' AND ')}`;
}

export function buildPkClause(
  engine: StudioEngine,
  primaryKey: string[],
  pk: Record<string, unknown>
): string {
  if (primaryKey.length === 0) throw new StudioValidationError('studioNoPrimaryKey');

  return primaryKey
    .map((column) => {
      if (!(column in pk)) throw new StudioValidationError('studioPrimaryKeyRequired');
      const ident = quoteIdent(engine, column);
      const value = pk[column];
      return value === null ? `${ident} IS NULL` : `${ident} = ${toSqlValue(engine, value)}`;
    })
    .join(' AND ');
}

/** Wrap a write so the script's last statement reports how many rows it touched. */
export function mutationSql(engine: StudioEngine, statement: string): string {
  return engine === 'postgresql'
    ? `WITH _m AS (${statement} RETURNING 1) SELECT count(*) FROM _m;`
    : `${statement};\nSELECT ROW_COUNT();`;
}

export function countSql(target: string, where: string, cap: number): string {
  return `SELECT count(*) FROM (SELECT 1 FROM ${target} ${where} LIMIT ${cap + 1}) _c;`;
}

export interface SelectRowsOptions {
  engine: StudioEngine;
  target: string;
  where: string;
  orderClause: string;
  pageSize: number;
  offset: number;
  columns: StudioColumn[];
}

/** The page of rows, returned as a single JSON document so types survive the trip. */
export function selectRowsSql(options: SelectRowsOptions): string {
  const { engine, target, where, orderClause, pageSize, offset, columns } = options;
  const page = `SELECT * FROM ${target} ${where} ${orderClause} LIMIT ${pageSize} OFFSET ${offset}`;

  if (engine === 'postgresql') {
    return `SELECT coalesce(json_agg(_q), '[]'::json) FROM (${page}) _q;`;
  }

  // ROW_NUMBER keeps the page order, which JSON_ARRAYAGG does not promise on its own.
  return `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(${mysqlRowProjection(columns)}, '__rn', _q.__rn)), JSON_ARRAY())
    FROM (
      SELECT _p.*, ROW_NUMBER() OVER () AS __rn FROM (${page}) _p
    ) _q;`;
}

/** Wrap a console SELECT so the row cap is applied by the engine, not by us after the fact. */
export function consoleGridSql(body: string, rowCap: number): string {
  return `SELECT coalesce(json_agg(_q), '[]'::json) FROM (
    SELECT * FROM (${body}) _inner LIMIT ${rowCap + 1}
  ) _q;`;
}

// ============ Bulk insert (CSV import) ============

export const MAX_IMPORT_ROWS_PER_REQUEST = 500;

/**
 * A multi-row INSERT for imported data. Every cell goes through the same literal escaping as a
 * hand-edited row, so a CSV is no more trusted than anything else the user types.
 */
export function insertRowsSql(
  engine: StudioEngine,
  target: string,
  columns: string[],
  rows: (string | null)[][]
): string {
  if (columns.length === 0) throw new StudioValidationError('studioNoColumns');
  if (rows.length === 0) throw new StudioValidationError('studioNoValues');
  if (rows.length > MAX_IMPORT_ROWS_PER_REQUEST) {
    throw new StudioValidationError('studioTooManyRows');
  }

  const columnList = columns.map((column) => quoteIdent(engine, column)).join(', ');
  const values = rows
    .map((row) => {
      if (row.length !== columns.length) throw new StudioValidationError('studioInvalidValue');
      return `(${row.map((cell) => toSqlValue(engine, cell)).join(', ')})`;
    })
    .join(',\n  ');

  return `INSERT INTO ${target} (${columnList}) VALUES\n  ${values}`;
}

// ============ Indexes ============

export interface StudioIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  method: string | null;
  definition: string | null;
  sizeBytes: number | null;
}

/** Index methods we are willing to emit, per engine. */
export const INDEX_METHODS: Record<StudioEngine, string[]> = {
  postgresql: ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'],
  mysql: ['btree', 'hash'],
};

export function indexesSql(engine: StudioEngine, schema: string, table: string): string {
  if (engine === 'postgresql') {
    return `
SELECT coalesce(json_agg(_i ORDER BY _i.name), '[]'::json) FROM (
  SELECT i.relname AS name,
         ix.indisunique AS "isUnique",
         ix.indisprimary AS "isPrimary",
         am.amname AS method,
         pg_get_indexdef(ix.indexrelid) AS definition,
         pg_relation_size(ix.indexrelid)::bigint AS "sizeBytes",
         (
           SELECT coalesce(json_agg(att.attname ORDER BY k.ord), '[]'::json)
           FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute att ON att.attrelid = t.oid AND att.attnum = k.attnum
         ) AS columns
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  WHERE n.nspname = ${quoteLiteral('postgresql', schema)}
    AND t.relname = ${quoteLiteral('postgresql', table)}
) _i;`;
  }

  return `
SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
  'name', _i.INDEX_NAME,
  'isUnique', _i.NON_UNIQUE = 0,
  'isPrimary', _i.INDEX_NAME = 'PRIMARY',
  'method', _i.INDEX_TYPE,
  'definition', NULL,
  'sizeBytes', NULL,
  'columns', _i.cols
)), JSON_ARRAY())
FROM (
  SELECT s.INDEX_NAME,
         MIN(s.NON_UNIQUE) AS NON_UNIQUE,
         MIN(s.INDEX_TYPE) AS INDEX_TYPE,
         JSON_ARRAYAGG(JSON_OBJECT('name', s.COLUMN_NAME, 'seq', s.SEQ_IN_INDEX)) AS cols
  FROM information_schema.STATISTICS s
  WHERE s.TABLE_SCHEMA = DATABASE() AND s.TABLE_NAME = ${quoteLiteral('mysql', table)}
  GROUP BY s.INDEX_NAME
) _i;`;
}

/** MySQL reports index columns unordered, so the sequence rides along and is sorted here. */
export function normalizeIndexColumns(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  if (raw.every((entry) => typeof entry === 'string')) return raw as string[];

  return [...(raw as { name: string; seq?: number }[])]
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
    .map((entry) => entry.name);
}

export interface CreateIndexOptions {
  engine: StudioEngine;
  schema: string;
  table: string;
  name: string;
  columns: string[];
  unique?: boolean;
  method?: string;
}

export function createIndexSql(options: CreateIndexOptions): string {
  const { engine, schema, table, name, columns, unique, method } = options;
  if (columns.length === 0) throw new StudioValidationError('studioNoColumns');

  const quotedColumns = columns.map((column) => quoteIdent(engine, column)).join(', ');
  const target = qualifiedName(engine, schema, table);
  const unique_ = unique ? 'UNIQUE ' : '';

  if (engine === 'postgresql') {
    // The method is matched against the allowlist by the caller; only the match is emitted.
    const using = method ? ` USING ${method}` : '';
    return `CREATE ${unique_}INDEX ${quoteIdent('postgresql', name)} ON ${target}${using} (${quotedColumns});`;
  }

  const using = method ? ` USING ${method.toUpperCase()}` : '';
  return `CREATE ${unique_}INDEX ${quoteIdent('mysql', name)} ON ${target} (${quotedColumns})${using};`;
}

export function dropIndexSql(
  engine: StudioEngine,
  schema: string,
  table: string,
  name: string
): string {
  if (engine === 'postgresql') {
    return `DROP INDEX ${quoteIdent('postgresql', schema)}.${quoteIdent('postgresql', name)};`;
  }
  return `DROP INDEX ${quoteIdent('mysql', name)} ON ${qualifiedName('mysql', schema, table)};`;
}

/** A generated name stays inside the identifier rules and is stable for the same columns. */
export function defaultIndexName(table: string, columns: string[]): string {
  return `idx_${[table, ...columns].join('_')}`.slice(0, 60).replace(/[^A-Za-z0-9_]/g, '_');
}

// ============ Performance ============

export interface StudioSlowQuery {
  id: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
}

export interface StudioRunningQuery {
  id: string;
  user: string | null;
  state: string | null;
  runningMs: number | null;
  query: string | null;
}

/** Whether the engine's statement-statistics source is present and readable. */
export function slowQuerySupportSql(engine: StudioEngine): string {
  if (engine === 'postgresql') {
    return `SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements';`;
  }
  return `SELECT count(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = 'performance_schema'
      AND TABLE_NAME = 'events_statements_summary_by_digest';`;
}

export function slowQueriesSql(engine: StudioEngine, limit = 20): string {
  if (engine === 'postgresql') {
    return `
SELECT coalesce(json_agg(_q ORDER BY _q."totalMs" DESC), '[]'::json) FROM (
  SELECT queryid::text AS id,
         query,
         calls,
         round(total_exec_time::numeric, 2) AS "totalMs",
         round(mean_exec_time::numeric, 2) AS "meanMs",
         rows
  FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  ORDER BY total_exec_time DESC
  LIMIT ${limit}
) _q;`;
  }

  return `
SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
  'id', _q.DIGEST,
  'query', _q.DIGEST_TEXT,
  'calls', _q.COUNT_STAR,
  'totalMs', ROUND(_q.SUM_TIMER_WAIT / 1000000000, 2),
  'meanMs', ROUND(_q.AVG_TIMER_WAIT / 1000000000, 2),
  'rows', _q.SUM_ROWS_SENT
)), JSON_ARRAY())
FROM (
  SELECT DIGEST, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, AVG_TIMER_WAIT, SUM_ROWS_SENT
  FROM performance_schema.events_statements_summary_by_digest
  WHERE SCHEMA_NAME = DATABASE()
  ORDER BY SUM_TIMER_WAIT DESC
  LIMIT ${limit}
) _q;`;
}

/**
 * Cancel one running statement. The id is always an integer, and each engine's form is scoped to
 * the current database, so a session can never cancel a backend that is not its own database's.
 */
export function cancelQuerySql(engine: StudioEngine, id: number): string {
  if (!Number.isInteger(id) || id <= 0) throw new StudioValidationError('studioInvalidValue');

  if (engine === 'postgresql') {
    return `SELECT count(*) FROM (
      SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE pid = ${id} AND datname = current_database() AND pid <> pg_backend_pid()
    ) _c;`;
  }

  // MySQL's KILL takes no predicate, so ownership is confirmed first.
  return `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID = ${id} AND DB = DATABASE();`;
}

export function mysqlKillQuerySql(id: number): string {
  if (!Number.isInteger(id) || id <= 0) throw new StudioValidationError('studioInvalidValue');
  return `KILL QUERY ${id};`;
}

export function runningQueriesSql(engine: StudioEngine, limit = 20): string {
  if (engine === 'postgresql') {
    return `
SELECT coalesce(json_agg(_a), '[]'::json) FROM (
  SELECT pid::text AS id,
         usename AS "user",
         state,
         round(EXTRACT(EPOCH FROM (now() - query_start)) * 1000)::bigint AS "runningMs",
         query
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
    AND state IS DISTINCT FROM 'idle'
  ORDER BY query_start
  LIMIT ${limit}
) _a;`;
  }

  return `
SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
  'id', CAST(_p.ID AS CHAR),
  'user', _p.USER,
  'state', _p.COMMAND,
  'runningMs', _p.TIME * 1000,
  'query', _p.INFO
)), JSON_ARRAY())
FROM (
  SELECT ID, USER, COMMAND, TIME, INFO
  FROM information_schema.PROCESSLIST
  WHERE DB = DATABASE() AND COMMAND <> 'Sleep'
  ORDER BY TIME DESC
  LIMIT ${limit}
) _p;`;
}
