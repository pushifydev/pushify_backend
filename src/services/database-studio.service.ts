/**
 * Database Studio — browse and edit the data inside a managed database.
 *
 * This module owns access control, the SSH session and orchestration. The SQL it sends, the
 * command that carries it and the parsing of what comes back all live in `lib/studio-sql.ts`,
 * which is pure and therefore testable against real engines.
 *
 * Managed databases run as Docker containers on the customer's server, so every query takes the
 * same route the rest of database.service.ts uses: SSH to the server (pooled), then `docker exec`
 * the engine's own CLI client.
 *
 * Injection safety rests on three layers, because the CLI clients give us no bind parameters:
 *   1. The SQL script is base64'd onto the client's stdin — the shell never sees user input.
 *   2. Identifiers are resolved against the live catalog before use and then quoted; a name that
 *      does not exist 404s instead of reaching a generated statement.
 *   3. Literals are escaped for the engine, with the session pinned to a known escaping mode.
 */
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { databaseRepository } from '../repositories/database.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';
import { decrypt } from '../lib/encryption';
import { getSSHConnection, type SSHClient, type SSHConnectionConfig } from '../utils/ssh';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { logger } from '../lib/logger';
import { toCsv } from '../lib/csv';
import { classifyStatement, quoteIdent } from '../lib/sql-escape';
import { StudioValidationError } from '../lib/studio-errors';
import {
  COLUMN_TYPES,
  renderColumnDefinition,
  renderTableBody,
  validateColumns,
  type ColumnDefinition,
  type SqlTypeInfo,
} from '../lib/sql-ddl';
import {
  assertSafeIdentifier,
  buildClientCommand,
  buildFilterClause,
  buildPkClause,
  capRows,
  collectColumns,
  columnsSql,
  consoleGridSql,
  countSql,
  extractEngineError,
  mutationSql,
  parseAffected,
  parseCommandTag,
  parseJsonRows,
  parseMysqlXml,
  prologue,
  qualifiedName,
  rowEstimateSql,
  selectRowsSql,
  stripPrologueTags,
  toSqlValue,
  toTableSchema,
  createIndexSql,
  insertRowsSql,
  defaultIndexName,
  dropIndexSql,
  indexesSql,
  normalizeIndexColumns,
  cancelQuerySql,
  mysqlKillQuerySql,
  runningQueriesSql,
  slowQueriesSql,
  slowQuerySupportSql,
  INDEX_METHODS,
  MAX_IMPORT_ROWS_PER_REQUEST,
  CONSOLE_ROW_CAP,
  COUNT_CAP,
  DEFAULT_PAGE_SIZE,
  EXPORT_ROW_CAP,
  MAX_DELETE_ROWS,
  MAX_PAGE_SIZE,
  MAX_SQL_LENGTH,
  MYSQL_SCHEMA_MAP_SQL,
  MYSQL_TABLES_SQL,
  PG_SCHEMA_MAP_SQL,
  PG_TABLES_SQL,
  SCHEMA_MAP_TABLE_CAP,
  UNFILTERED_COUNT_CAP,
  type RawColumn,
  type StudioColumn,
  type StudioEngine,
  type StudioFilter,
  type StudioFilterOperator,
  type StudioIndex,
  type StudioRunningQuery,
  type StudioSlowQuery,
  type StudioTableSchema,
} from '../lib/studio-sql';
import { activityService } from './activity.service';
import { resolveStudioAccess, satisfies, type StudioAccessLevel } from './studio-session.service';

export type {
  StudioIndex,
  StudioRunningQuery,
  StudioSlowQuery,
  StudioColumn,
  StudioEngine,
  StudioFilter,
  StudioFilterOperator,
  StudioTableSchema,
};

// ============ Types ============

export interface StudioTable {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  rowEstimate: number;
  sizeBytes: number | null;
  hasPrimaryKey: boolean;
}

export interface StudioRowsResult extends StudioTableSchema {
  rows: Record<string, unknown>[];
  page: number;
  pageSize: number;
  total: number;
  /** true when a filtered count hit the cap and `total` is a lower bound */
  totalCapped: boolean;
  /** true when `total` is the planner's estimate rather than a counted value */
  totalEstimated: boolean;
}

export interface StudioQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  message: string | null;
  durationMs: number;
  readOnly: boolean;
  /** the leading keyword of the statement, e.g. SELECT / UPDATE / CREATE */
  command: string | null;
  /** rows the statement changed, when the engine reports it */
  affected: number | null;
}

export interface StudioSchemaTable {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: { name: string; dataType: string }[];
}

export interface StudioSchemaMap {
  engine: StudioEngine;
  defaultSchema: string;
  tables: StudioSchemaTable[];
  /** true when the database has more tables than the map returns */
  truncated: boolean;
}

export interface GetRowsInput {
  schema?: string;
  table: string;
  page?: number;
  pageSize?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  filters?: StudioFilter[];
}

export interface MutateRowInput {
  schema?: string;
  table: string;
  values: Record<string, unknown>;
  /** primary key of the row being changed — required for update */
  pk?: Record<string, unknown>;
}

export interface DeleteRowsInput {
  schema?: string;
  table: string;
  pks: Record<string, unknown>[];
}

export interface RunQueryInput {
  sql: string;
  allowWrite?: boolean;
  /** row ceiling for this call; capped server-side. Exports ask for more than the console does. */
  maxRows?: number;
}

export interface ExportQueryInput {
  sql: string;
  format?: 'csv' | 'json';
}

// ============ Schema (DDL) types ============

export type StudioTypeInfo = SqlTypeInfo;
export type ColumnDefinitionInput = ColumnDefinition;

export interface CreateTableInput {
  schema?: string;
  name: string;
  columns: ColumnDefinitionInput[];
}

export interface TableTargetInput {
  schema?: string;
  table: string;
}

export interface RenameTableInput extends TableTargetInput {
  newName: string;
}

export interface AddColumnInput extends TableTargetInput {
  column: ColumnDefinitionInput;
}

export interface DropColumnInput extends TableTargetInput {
  column: string;
}

export interface ImportRowsInput extends TableTargetInput {
  columns: string[];
  rows: (string | null)[][];
  /** CSV cannot express NULL, so an empty cell becomes NULL unless the caller says otherwise */
  emptyAsNull?: boolean;
}

export interface CreateIndexInput extends TableTargetInput {
  name?: string;
  columns: string[];
  unique?: boolean;
  method?: string;
}

export interface DropIndexInput extends TableTargetInput {
  name: string;
}

export interface StudioPerformance {
  engine: StudioEngine;
  slowQueries: {
    available: boolean;
    /** why the statistics are unavailable, in the engine's own words */
    hint: string | null;
    items: StudioSlowQuery[];
  };
  running: {
    available: boolean;
    hint: string | null;
    items: StudioRunningQuery[];
  };
}

// ============ Session ============

interface StudioSession {
  ssh: SSHClient;
  /** what this caller may do — the UI hides write actions when it is 'read' */
  access: 'read' | 'write';
  /** kept so a pooled connection that died between requests can be re-established */
  connectConfig: SSHConnectionConfig;
  engine: StudioEngine;
  containerName: string;
  username: string;
  databaseName: string;
  password: string;
  databaseId: string;
  databaseLabel: string;
}

async function openSession(
  databaseId: string,
  organizationId: string,
  userId: string,
  locale: SupportedLocale,
  required: StudioAccessLevel
): Promise<StudioSession> {
  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
  }

  const granted = resolveStudioAccess(membership);
  if (!satisfies(granted, required)) {
    throw new HTTPException(403, {
      message: t(locale, 'databases', granted === 'read' ? 'studioReadOnlyAccess' : 'studioNoAccess'),
    });
  }

  const database = await databaseRepository.findById(databaseId);
  if (!database || database.organizationId !== organizationId) {
    throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
  }

  if (database.type !== 'postgresql' && database.type !== 'mysql') {
    throw new HTTPException(400, { message: t(locale, 'databases', 'studioUnsupportedEngine') });
  }

  if (database.status !== 'running') {
    throw new HTTPException(400, { message: t(locale, 'databases', 'mustBeRunning') });
  }

  if (!database.serverId || !database.containerName) {
    throw new HTTPException(400, { message: t(locale, 'databases', 'invalidContainer') });
  }

  const server = await db.query.servers.findFirst({ where: eq(servers.id, database.serverId) });
  if (!server?.ipv4 || !server.sshPrivateKey) {
    throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
  }

  // Pooled: the SSH handshake costs more than the query itself, and the studio is interactive.
  const connectConfig: SSHConnectionConfig = {
    host: server.ipv4,
    username: 'root',
    privateKey: decrypt(server.sshPrivateKey),
  };
  const ssh = await getSSHConnection(connectConfig);

  return {
    ssh,
    access: granted === 'write' ? 'write' : 'read',
    connectConfig,
    engine: database.type,
    containerName: database.containerName,
    username: database.username,
    databaseName: database.databaseName,
    password: decrypt(database.password),
    databaseId: database.id,
    databaseLabel: database.name,
  };
}

/**
 * Run `fn` against a studio session. The SSH connection is owned by the pool — it is left open
 * for the next request and reaped by the pool's idle timer, never disconnected here.
 *
 * This is also the single place where the SQL layer's validation errors become HTTP responses.
 */
async function withSession<T>(
  databaseId: string,
  organizationId: string,
  userId: string,
  locale: SupportedLocale,
  required: StudioAccessLevel,
  fn: (session: StudioSession) => Promise<T>
): Promise<T> {
  const session = await openSession(databaseId, organizationId, userId, locale, required);

  try {
    return await fn(session);
  } catch (error) {
    if (error instanceof StudioValidationError) {
      throw new HTTPException(400, { message: t(locale, 'databases', error.key) });
    }
    throw error;
  }
}

// ============ Query execution ============

interface ExecOptions {
  /** Suppress command tags (psql -q). Off for the console's raw path, which shows them. */
  quiet?: boolean;
  /** MySQL only: ask for XML so arbitrary result sets keep column names and NULLs. */
  xml?: boolean;
}

async function execScript(
  session: StudioSession,
  script: string,
  readOnly: boolean,
  locale: SupportedLocale,
  options: ExecOptions = {}
): Promise<string> {
  const command = buildClientCommand({
    engine: session.engine,
    containerName: session.containerName,
    username: session.username,
    databaseName: session.databaseName,
    password: session.password,
    script: `${prologue(session.engine, readOnly)}\n${script}\n`,
    quiet: options.quiet,
    xml: options.xml,
  });

  // A pooled connection can go away between requests; re-acquire before sending rather than
  // retrying afterwards, which could apply a write twice.
  if (!session.ssh.isConnected()) {
    session.ssh = await getSSHConnection(session.connectConfig);
  }

  const { stdout, stderr, code } = await session.ssh.exec(command);

  const engineError = extractEngineError(stderr);
  if (engineError) {
    logger.warn(
      { databaseId: session.databaseId, code, error: engineError },
      'database studio query failed'
    );
    throw new HTTPException(400, { message: engineError });
  }

  if (code !== 0) {
    throw new HTTPException(400, { message: t(locale, 'databases', 'studioQueryFailed') });
  }

  return stdout;
}

// ============ Catalog ============

/**
 * Resolving a table costs a full round trip to the server, and paging/sorting/filtering resolve
 * the same table over and over. A short TTL keeps the interactive path to a single round trip
 * while staying fresh enough for schema changes made outside the studio.
 */
const SCHEMA_CACHE_TTL_MS = 60_000;
const SCHEMA_CACHE_MAX_ENTRIES = 500;
const schemaCache = new Map<string, { value: StudioTableSchema; expiresAt: number }>();

function schemaCacheKey(databaseId: string, schema: string, table: string): string {
  return `${databaseId}|${schema}|${table}`;
}

function readSchemaCache(key: string): StudioTableSchema | null {
  const hit = schemaCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    schemaCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeSchemaCache(key: string, value: StudioTableSchema): void {
  if (schemaCache.size >= SCHEMA_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [entryKey, entry] of schemaCache) {
      if (entry.expiresAt <= now) schemaCache.delete(entryKey);
    }
    // Still full of live entries: drop the oldest insertion to keep the map bounded.
    if (schemaCache.size >= SCHEMA_CACHE_MAX_ENTRIES) {
      const oldest = schemaCache.keys().next();
      if (!oldest.done) schemaCache.delete(oldest.value);
    }
  }
  schemaCache.set(key, { value, expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS });
}

/** Called after our own DDL so in-app schema changes show up immediately. */
function invalidateSchemaCache(databaseId: string): void {
  for (const key of schemaCache.keys()) {
    if (key.startsWith(`${databaseId}|`)) schemaCache.delete(key);
  }
}

function normalizeSchema(session: StudioSession, schema: string | undefined): string {
  if (schema && schema.length > 0) return schema;
  return session.engine === 'postgresql' ? 'public' : session.databaseName;
}

/**
 * Resolve a table against the live catalog. This is the gate that makes identifier injection
 * impossible: anything not found here never reaches a generated statement.
 */
async function resolveTable(
  session: StudioSession,
  rawSchema: string | undefined,
  rawTable: string,
  locale: SupportedLocale
): Promise<StudioTableSchema> {
  const schema = assertSafeIdentifier(normalizeSchema(session, rawSchema));
  const table = assertSafeIdentifier(rawTable);

  const cacheKey = schemaCacheKey(session.databaseId, schema, table);
  const cached = readSchemaCache(cacheKey);
  if (cached) return cached;

  const raw = await execScript(session, columnsSql(session.engine, schema, table), true, locale);
  const parsed = parseJsonRows(raw) as unknown as RawColumn[];

  if (parsed.length === 0) {
    throw new HTTPException(404, { message: t(locale, 'databases', 'studioTableNotFound') });
  }

  const resolved = toTableSchema(session.engine, schema, table, parsed);
  writeSchemaCache(cacheKey, resolved);
  return resolved;
}

function target(session: StudioSession, schema: StudioTableSchema): string {
  return qualifiedName(session.engine, schema.schema, schema.name);
}

// ============ Activity ============

async function logDataChange(
  session: StudioSession,
  organizationId: string,
  userId: string,
  operation: 'insert' | 'update' | 'delete',
  schema: StudioTableSchema,
  affected: number
): Promise<void> {
  await activityService.log({
    organizationId,
    userId,
    action: 'database.data_modified',
    description: `${operation} on ${schema.schema}.${schema.name} in database "${session.databaseLabel}" (${affected} row${affected === 1 ? '' : 's'})`,
    metadata: {
      databaseId: session.databaseId,
      engine: session.engine,
      operation,
      schema: schema.schema,
      table: schema.name,
      affected,
    },
  });
}

async function logSchemaChange(
  session: StudioSession,
  organizationId: string,
  userId: string,
  operation: string,
  targetName: string
): Promise<void> {
  invalidateSchemaCache(session.databaseId);

  await activityService.log({
    organizationId,
    userId,
    action: 'database.schema_changed',
    description: `${operation} ${targetName} in database "${session.databaseLabel}"`,
    metadata: {
      databaseId: session.databaseId,
      engine: session.engine,
      operation,
      target: targetName,
    },
  });
}

// ============ Service ============

export const databaseStudioService = {
  /** Engines the studio can talk to — the UI hides the entry point for the rest. */
  isSupported(type: string): boolean {
    return type === 'postgresql' || type === 'mysql';
  },

  async listTables(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ): Promise<{
    engine: StudioEngine;
    defaultSchema: string;
    tables: StudioTable[];
    columnTypes: StudioTypeInfo[];
    access: 'read' | 'write';
  }> {
    return withSession(databaseId, organizationId, userId, locale, 'read', async (session) => {
      const sql = session.engine === 'postgresql' ? PG_TABLES_SQL : MYSQL_TABLES_SQL;
      const raw = await execScript(session, sql, true, locale);
      const tables = parseJsonRows(raw) as unknown as StudioTable[];

      return {
        engine: session.engine,
        access: session.access,
        defaultSchema: normalizeSchema(session, undefined),
        columnTypes: COLUMN_TYPES[session.engine],
        tables: tables
          .map((table) => ({
            ...table,
            rowEstimate: Number(table.rowEstimate ?? 0),
            sizeBytes: table.sizeBytes === null ? null : Number(table.sizeBytes),
          }))
          .sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name)),
      };
    });
  },

  /** Every table with its columns — the autocomplete source for the SQL console. */
  async getSchemaMap(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ): Promise<StudioSchemaMap> {
    return withSession(databaseId, organizationId, userId, locale, 'read', async (session) => {
      const sql = session.engine === 'postgresql' ? PG_SCHEMA_MAP_SQL : MYSQL_SCHEMA_MAP_SQL;
      const raw = await execScript(session, sql, true, locale);
      const parsed = parseJsonRows(raw) as unknown as (StudioSchemaTable & {
        columns: ({ ordinal?: number } & StudioSchemaTable['columns'][number])[];
      })[];

      const tables = parsed.map((table) => ({
        schema: table.schema,
        name: table.name,
        kind: table.kind === 'view' ? ('view' as const) : ('table' as const),
        // MySQL's JSON_ARRAYAGG does not promise an order, so sort on the ordinal we asked for.
        columns: [...(table.columns ?? [])]
          .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0))
          .map((column) => ({ name: column.name, dataType: column.dataType })),
      }));

      return {
        engine: session.engine,
        defaultSchema: normalizeSchema(session, undefined),
        tables,
        truncated: tables.length >= SCHEMA_MAP_TABLE_CAP,
      };
    });
  },

  async getRows(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: GetRowsInput,
    locale: SupportedLocale
  ): Promise<StudioRowsResult> {
    return withSession(databaseId, organizationId, userId, locale, 'read', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);

      const page = Math.max(1, Math.floor(Number(input.page) || 1));
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Math.floor(Number(input.pageSize) || DEFAULT_PAGE_SIZE))
      );
      const offset = (page - 1) * pageSize;

      const where = buildFilterClause(session.engine, schema.columns, input.filters);

      let orderClause = '';
      if (input.orderBy) {
        const column = schema.columns.find((c) => c.name === input.orderBy);
        if (!column) throw new StudioValidationError('studioInvalidIdentifier');
        const direction = input.orderDir === 'desc' ? 'DESC' : 'ASC';
        orderClause = `ORDER BY ${quoteIdent(session.engine, column.name)} ${direction}`;
      } else if (schema.primaryKey.length > 0) {
        orderClause = `ORDER BY ${schema.primaryKey
          .map((c) => quoteIdent(session.engine, c))
          .join(', ')}`;
      }

      const tableRef = target(session, schema);
      const hasFilters = Boolean(input.filters && input.filters.length > 0);

      // A filtered count has to be counted; an unfiltered one stops early and defers to the
      // planner's estimate above the cap. All three statements ride in one round trip.
      const cap = hasFilters ? COUNT_CAP : UNFILTERED_COUNT_CAP;
      const script = [
        countSql(tableRef, where, cap),
        rowEstimateSql(session.engine, schema.schema, schema.name),
        selectRowsSql({
          engine: session.engine,
          target: tableRef,
          where,
          orderClause,
          pageSize,
          offset,
          columns: schema.columns,
        }),
      ].join('\n');

      const raw = await execScript(session, script, true, locale);
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      const counted = Number(lines[0] ?? 0);
      const estimate = Number(lines[1] ?? 0);
      const rows = parseJsonRows(lines.slice(2).join('\n'));

      if (session.engine === 'mysql') {
        rows.sort((a, b) => Number(a.__rn ?? 0) - Number(b.__rn ?? 0));
        for (const row of rows) delete row.__rn;
      }

      let total = counted;
      let totalCapped = false;
      let totalEstimated = false;

      if (hasFilters) {
        total = Math.min(counted, COUNT_CAP);
        totalCapped = counted > COUNT_CAP;
      } else if (counted > UNFILTERED_COUNT_CAP) {
        total = Math.max(estimate, UNFILTERED_COUNT_CAP);
        totalEstimated = true;
      }

      return {
        ...schema,
        rows: capRows(rows),
        page,
        pageSize,
        total,
        totalCapped,
        totalEstimated,
      };
    });
  },

  async insertRow(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: MutateRowInput,
    locale: SupportedLocale
  ): Promise<{ affected: number }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      if (schema.kind === 'view') {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioViewReadOnly') });
      }

      const entries = Object.entries(input.values ?? {});
      if (entries.length === 0) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioNoValues') });
      }

      const known = new Map(schema.columns.map((c) => [c.name, c]));
      const columns: string[] = [];
      const values: string[] = [];

      for (const [name, value] of entries) {
        const column = known.get(name);
        if (!column || !column.editable) {
          throw new StudioValidationError('studioInvalidIdentifier');
        }
        columns.push(quoteIdent(session.engine, column.name));
        values.push(toSqlValue(session.engine, value));
      }

      const statement = `INSERT INTO ${target(session, schema)} (${columns.join(', ')}) VALUES (${values.join(', ')})`;
      const raw = await execScript(session, mutationSql(session.engine, statement), false, locale);
      const affected = parseAffected(raw);

      await logDataChange(session, organizationId, userId, 'insert', schema, affected);
      return { affected };
    });
  },

  async updateRow(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: MutateRowInput,
    locale: SupportedLocale
  ): Promise<{ affected: number }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      if (!schema.editable) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioNoPrimaryKey') });
      }

      const entries = Object.entries(input.values ?? {});
      if (entries.length === 0) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioNoValues') });
      }
      if (!input.pk) throw new StudioValidationError('studioPrimaryKeyRequired');

      const known = new Map(schema.columns.map((c) => [c.name, c]));
      const assignments = entries.map(([name, value]) => {
        const column = known.get(name);
        if (!column || !column.editable) {
          throw new StudioValidationError('studioInvalidIdentifier');
        }
        return `${quoteIdent(session.engine, column.name)} = ${toSqlValue(session.engine, value)}`;
      });

      const where = buildPkClause(session.engine, schema.primaryKey, input.pk);
      const statement = `UPDATE ${target(session, schema)} SET ${assignments.join(', ')} WHERE ${where}`;
      const raw = await execScript(session, mutationSql(session.engine, statement), false, locale);
      const affected = parseAffected(raw);

      await logDataChange(session, organizationId, userId, 'update', schema, affected);
      return { affected };
    });
  },

  async deleteRows(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: DeleteRowsInput,
    locale: SupportedLocale
  ): Promise<{ affected: number }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      if (!schema.editable) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioNoPrimaryKey') });
      }

      const pks = Array.isArray(input.pks) ? input.pks : [];
      if (pks.length === 0) throw new StudioValidationError('studioPrimaryKeyRequired');
      if (pks.length > MAX_DELETE_ROWS) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioTooManyRows') });
      }

      const conditions = pks.map(
        (pk) => `(${buildPkClause(session.engine, schema.primaryKey, pk)})`
      );
      const statement = `DELETE FROM ${target(session, schema)} WHERE ${conditions.join(' OR ')}`;
      const raw = await execScript(session, mutationSql(session.engine, statement), false, locale);
      const affected = parseAffected(raw);

      await logDataChange(session, organizationId, userId, 'delete', schema, affected);
      return { affected };
    });
  },

  // ============ Schema (DDL) ============

  async createTable(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: CreateTableInput,
    locale: SupportedLocale
  ): Promise<{ schema: string; name: string }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      // A new table cannot be catalog-checked, so the identifier filter plus quoting is the gate.
      const schema = assertSafeIdentifier(normalizeSchema(session, input.schema));
      const name = assertSafeIdentifier(input.name);
      const columns = validateColumns(session.engine, input.columns);

      const tableRef = qualifiedName(session.engine, schema, name);
      await execScript(
        session,
        `CREATE TABLE ${tableRef} (\n  ${renderTableBody(session.engine, columns)}\n);`,
        false,
        locale
      );

      await logSchemaChange(session, organizationId, userId, 'create table', `${schema}.${name}`);
      return { schema, name };
    });
  },

  async dropTable(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: TableTargetInput,
    locale: SupportedLocale
  ): Promise<{ dropped: true }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      const tableRef = target(session, schema);
      const statement = schema.kind === 'view' ? `DROP VIEW ${tableRef};` : `DROP TABLE ${tableRef};`;

      await execScript(session, statement, false, locale);

      await logSchemaChange(
        session,
        organizationId,
        userId,
        `drop ${schema.kind}`,
        `${schema.schema}.${schema.name}`
      );
      return { dropped: true };
    });
  },

  async truncateTable(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: TableTargetInput,
    locale: SupportedLocale
  ): Promise<{ truncated: true }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      if (schema.kind === 'view') {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioViewReadOnly') });
      }

      await execScript(session, `TRUNCATE TABLE ${target(session, schema)};`, false, locale);

      await logSchemaChange(
        session,
        organizationId,
        userId,
        'truncate table',
        `${schema.schema}.${schema.name}`
      );
      return { truncated: true };
    });
  },

  async renameTable(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: RenameTableInput,
    locale: SupportedLocale
  ): Promise<{ schema: string; name: string }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      const newName = assertSafeIdentifier(input.newName);

      await execScript(
        session,
        `ALTER TABLE ${target(session, schema)} RENAME TO ${quoteIdent(session.engine, newName)};`,
        false,
        locale
      );

      await logSchemaChange(
        session,
        organizationId,
        userId,
        'rename table',
        `${schema.schema}.${schema.name} -> ${newName}`
      );
      return { schema: schema.schema, name: newName };
    });
  },

  async addColumn(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: AddColumnInput,
    locale: SupportedLocale
  ): Promise<{ added: true }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      if (schema.kind === 'view') {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioViewReadOnly') });
      }

      const [column] = validateColumns(session.engine, input.column ? [input.column] : []);
      if (schema.columns.some((existing) => existing.name === column.name)) {
        throw new StudioValidationError('studioDuplicateColumn');
      }

      // A primary key is a table-level change, not something ADD COLUMN should smuggle in.
      const definition = renderColumnDefinition(session.engine, {
        ...column,
        primaryKey: false,
        autoIncrement: false,
      });

      await execScript(
        session,
        `ALTER TABLE ${target(session, schema)} ADD COLUMN ${definition};`,
        false,
        locale
      );

      await logSchemaChange(
        session,
        organizationId,
        userId,
        'add column',
        `${schema.schema}.${schema.name}.${column.name}`
      );
      return { added: true };
    });
  },

  async dropColumn(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: DropColumnInput,
    locale: SupportedLocale
  ): Promise<{ dropped: true }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      if (schema.kind === 'view') {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioViewReadOnly') });
      }

      const column = schema.columns.find((existing) => existing.name === input.column);
      if (!column) throw new StudioValidationError('studioInvalidIdentifier');
      if (schema.columns.length === 1) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioLastColumn') });
      }

      await execScript(
        session,
        `ALTER TABLE ${target(session, schema)} DROP COLUMN ${quoteIdent(session.engine, column.name)};`,
        false,
        locale
      );

      await logSchemaChange(
        session,
        organizationId,
        userId,
        'drop column',
        `${schema.schema}.${schema.name}.${column.name}`
      );
      return { dropped: true };
    });
  },

  /** Append a batch of rows to a table. The client sends one batch per request. */
  async importRows(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: ImportRowsInput,
    locale: SupportedLocale
  ): Promise<{ affected: number }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      if (schema.kind === 'view') {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioViewReadOnly') });
      }

      const columns = Array.isArray(input.columns) ? input.columns : [];
      const rows = Array.isArray(input.rows) ? input.rows : [];

      if (columns.length === 0) throw new StudioValidationError('studioNoColumns');
      if (rows.length === 0) throw new StudioValidationError('studioNoValues');
      if (rows.length > MAX_IMPORT_ROWS_PER_REQUEST) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioTooManyRows') });
      }

      // Only real, writable columns of this table may be targeted.
      for (const column of columns) {
        const known = schema.columns.find((existing) => existing.name === column);
        if (!known || !known.editable) throw new StudioValidationError('studioInvalidIdentifier');
      }

      const emptyAsNull = input.emptyAsNull !== false;
      const normalized = rows.map((row) =>
        row.map((cell) => {
          if (cell === null || cell === undefined) return null;
          if (typeof cell !== 'string') throw new StudioValidationError('studioInvalidValue');
          return emptyAsNull && cell === '' ? null : cell;
        })
      );

      const statement = insertRowsSql(
        session.engine,
        target(session, schema),
        columns,
        normalized
      );
      const raw = await execScript(session, mutationSql(session.engine, statement), false, locale);
      const affected = parseAffected(raw);

      await logDataChange(session, organizationId, userId, 'insert', schema, affected);
      return { affected };
    });
  },

  // ============ Indexes ============

  async listIndexes(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: TableTargetInput,
    locale: SupportedLocale
  ): Promise<StudioIndex[]> {
    return withSession(databaseId, organizationId, userId, locale, 'read', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      const raw = await execScript(
        session,
        indexesSql(session.engine, schema.schema, schema.name),
        true,
        locale
      );

      return (parseJsonRows(raw) as unknown as (StudioIndex & { columns: unknown })[]).map(
        (index) => ({
          name: index.name,
          columns: normalizeIndexColumns(index.columns),
          isUnique: Boolean(index.isUnique),
          isPrimary: Boolean(index.isPrimary),
          method: index.method ?? null,
          definition: index.definition ?? null,
          sizeBytes: index.sizeBytes === null ? null : Number(index.sizeBytes),
        })
      );
    });
  },

  async createIndex(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: CreateIndexInput,
    locale: SupportedLocale
  ): Promise<{ name: string }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);
      if (schema.kind === 'view') {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioViewReadOnly') });
      }

      const columns = Array.isArray(input.columns) ? input.columns : [];
      if (columns.length === 0) throw new StudioValidationError('studioNoColumns');

      // Every column has to exist on the table; that is what keeps a name from being invented.
      for (const column of columns) {
        if (!schema.columns.some((existing) => existing.name === column)) {
          throw new StudioValidationError('studioInvalidIdentifier');
        }
      }

      let method: string | undefined;
      if (input.method) {
        const allowed = INDEX_METHODS[session.engine].find(
          (candidate) => candidate === input.method?.toLowerCase()
        );
        if (!allowed) {
          throw new HTTPException(400, {
            message: t(locale, 'databases', 'studioInvalidIndexMethod'),
          });
        }
        method = allowed;
      }

      const name = assertSafeIdentifier(
        input.name?.trim() ? input.name.trim() : defaultIndexName(schema.name, columns)
      );

      await execScript(
        session,
        createIndexSql({
          engine: session.engine,
          schema: schema.schema,
          table: schema.name,
          name,
          columns,
          unique: input.unique === true,
          method,
        }),
        false,
        locale
      );

      await logSchemaChange(
        session,
        organizationId,
        userId,
        'create index',
        `${schema.schema}.${schema.name}.${name}`
      );
      return { name };
    });
  },

  async dropIndex(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: DropIndexInput,
    locale: SupportedLocale
  ): Promise<{ dropped: true }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const schema = await resolveTable(session, input.schema, input.table, locale);

      const raw = await execScript(
        session,
        indexesSql(session.engine, schema.schema, schema.name),
        true,
        locale
      );
      const indexes = parseJsonRows(raw) as unknown as StudioIndex[];
      const index = indexes.find((candidate) => candidate.name === input.name);

      if (!index) {
        throw new HTTPException(404, { message: t(locale, 'databases', 'studioIndexNotFound') });
      }
      if (index.isPrimary) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioPrimaryIndex') });
      }

      await execScript(
        session,
        dropIndexSql(session.engine, schema.schema, schema.name, index.name),
        false,
        locale
      );

      await logSchemaChange(
        session,
        organizationId,
        userId,
        'drop index',
        `${schema.schema}.${schema.name}.${index.name}`
      );
      return { dropped: true };
    });
  },

  /** Cancel a statement that is still running. Ownership is enforced by the SQL itself. */
  async cancelQuery(
    databaseId: string,
    organizationId: string,
    userId: string,
    id: number,
    locale: SupportedLocale
  ): Promise<{ cancelled: boolean }> {
    return withSession(databaseId, organizationId, userId, locale, 'write', async (session) => {
      const raw = await execScript(session, cancelQuerySql(session.engine, id), false, locale);
      const matched = Number(raw.trim()) > 0;

      if (session.engine === 'mysql' && matched) {
        await execScript(session, mysqlKillQuerySql(id), false, locale);
      }

      return { cancelled: matched };
    });
  },

  // ============ Performance ============

  /**
   * Statement statistics need an extension (postgres) or privileges on performance_schema
   * (mysql) that a managed user may not have — so an unavailable source is reported, not thrown.
   */
  async getPerformance(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ): Promise<StudioPerformance> {
    return withSession(databaseId, organizationId, userId, locale, 'read', async (session) => {
      const readOptional = async <T>(sql: string): Promise<{ items: T[]; hint: string | null }> => {
        try {
          const raw = await execScript(session, sql, true, locale);
          return { items: parseJsonRows(raw) as unknown as T[], hint: null };
        } catch (error) {
          const hint = error instanceof HTTPException ? error.message : String(error);
          return { items: [], hint: hint.slice(0, 500) };
        }
      };

      let slowQueries: StudioPerformance['slowQueries'] = {
        available: false,
        hint: t(locale, 'databases', 'studioSlowQueriesUnavailable'),
        items: [],
      };

      // The probe returns a bare count; a missing source or a denied read both read as zero.
      const supported = await execScript(session, slowQuerySupportSql(session.engine), true, locale)
        .then((value) => Number(value.trim()) > 0)
        .catch(() => false);

      if (supported) {
        const result = await readOptional<StudioSlowQuery>(slowQueriesSql(session.engine));
        slowQueries = {
          available: result.hint === null,
          hint: result.hint ?? null,
          items: result.items.map((item) => ({
            ...item,
            calls: Number(item.calls ?? 0),
            totalMs: Number(item.totalMs ?? 0),
            meanMs: Number(item.meanMs ?? 0),
            rows: Number(item.rows ?? 0),
          })),
        };
      }

      const running = await readOptional<StudioRunningQuery>(runningQueriesSql(session.engine));

      return {
        engine: session.engine,
        slowQueries,
        running: {
          available: running.hint === null,
          hint: running.hint,
          items: running.items.map((item) => ({
            ...item,
            runningMs: item.runningMs === null ? null : Number(item.runningMs),
          })),
        },
      };
    });
  },

  // ============ Console ============

  async runQuery(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: RunQueryInput,
    locale: SupportedLocale
  ): Promise<StudioQueryResult> {
    const sql = typeof input.sql === 'string' ? input.sql.trim() : '';
    if (!sql) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'studioEmptyQuery') });
    }
    if (sql.length > MAX_SQL_LENGTH) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'studioQueryTooLong') });
    }

    const allowWrite = input.allowWrite === true;
    const rowCap = Math.min(
      Math.max(1, Math.floor(Number(input.maxRows) || CONSOLE_ROW_CAP)),
      EXPORT_ROW_CAP
    );
    const { body, isSingleStatement, isSelectLike, isReadCommand } = classifyStatement(sql);

    // Read-only mode accepts exactly one read statement — that stops a trailing
    // `COMMIT; DROP ...` from escaping the read-only transaction we wrap it in.
    if (!allowWrite && (!isSingleStatement || !isReadCommand)) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'studioReadOnlyBlocked') });
    }

    const command = body.split(/\s+/, 1)[0]?.toUpperCase() || null;

    return withSession(
      databaseId,
      organizationId,
      userId,
      locale,
      allowWrite ? 'write' : 'read',
      async (session) => {
      const startedAt = Date.now();
      const wrapAsGrid = isSelectLike && isSingleStatement;
      let result: StudioQueryResult;

      if (session.engine === 'postgresql') {
        const statement = wrapAsGrid ? consoleGridSql(body, rowCap) : `${body};`;
        const script = allowWrite ? statement : `BEGIN READ ONLY;\n${statement}\nCOMMIT;`;
        const raw = await execScript(session, script, !allowWrite, locale, {
          quiet: wrapAsGrid ? undefined : false,
        });

        if (wrapAsGrid) {
          const rows = parseJsonRows(raw);
          const truncated = rows.length > rowCap;
          const visible = rows.slice(0, rowCap);
          result = {
            columns: collectColumns(visible),
            rows: capRows(visible),
            rowCount: visible.length,
            truncated,
            message: null,
            durationMs: Date.now() - startedAt,
            readOnly: !allowWrite,
            command,
            affected: null,
          };
        } else {
          const output = stripPrologueTags(raw);
          const tag = parseCommandTag(output);
          result = {
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
            message: output || 'OK',
            durationMs: Date.now() - startedAt,
            readOnly: !allowWrite,
            command: tag.command ?? command,
            affected: tag.affected,
          };
        }
      } else {
        // MySQL does not print a command tag, so ask it for the row count alongside a write.
        const wantsRowCount = allowWrite && isSingleStatement && !isSelectLike;
        const statements = wantsRowCount
          ? `${body};\nSELECT ROW_COUNT() AS affected_rows;`
          : `${body};`;
        const script = allowWrite
          ? statements
          : `START TRANSACTION READ ONLY;\n${statements}\nCOMMIT;`;

        const raw = await execScript(session, script, !allowWrite, locale, { xml: true });
        const parsed = parseMysqlXml(raw, rowCap);

        if (wantsRowCount) {
          const affected = Number(parsed.rows[0]?.affected_rows ?? 0);
          result = {
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
            message: 'OK',
            durationMs: Date.now() - startedAt,
            readOnly: false,
            command,
            affected: Number.isFinite(affected) ? affected : null,
          };
        } else {
          const truncated = parsed.rows.length > rowCap;
          const visible = parsed.rows.slice(0, rowCap);
          result = {
            columns: parsed.columns,
            rows: capRows(visible),
            rowCount: visible.length,
            truncated,
            message: visible.length === 0 ? 'OK' : null,
            durationMs: Date.now() - startedAt,
            readOnly: !allowWrite,
            command,
            affected: null,
          };
        }
      }

      await activityService.log({
        organizationId,
        userId,
        action: 'database.query_executed',
        description: `Ran a ${allowWrite ? 'write' : 'read-only'} query on database "${session.databaseLabel}"`,
        metadata: {
          databaseId: session.databaseId,
          engine: session.engine,
          allowWrite,
          durationMs: result.durationMs,
          sql: sql.slice(0, 1000),
        },
      });

      return result;
      }
    );
  },

  /**
   * Export a query's full result. Always read-only and always the same execution path as the
   * console — only the row ceiling differs.
   */
  async exportQuery(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: ExportQueryInput,
    locale: SupportedLocale
  ): Promise<{
    body: string;
    contentType: string;
    fileName: string;
    rowCount: number;
    truncated: boolean;
  }> {
    const format = input.format === 'json' ? 'json' : 'csv';

    const result = await this.runQuery(
      databaseId,
      organizationId,
      userId,
      { sql: input.sql, allowWrite: false, maxRows: EXPORT_ROW_CAP },
      locale
    );

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

    if (format === 'json') {
      return {
        body: JSON.stringify(result.rows, null, 2),
        contentType: 'application/json; charset=utf-8',
        fileName: `query-${stamp}.json`,
        rowCount: result.rowCount,
        truncated: result.truncated,
      };
    }

    return {
      body: toCsv(result.columns, result.rows),
      contentType: 'text/csv; charset=utf-8',
      fileName: `query-${stamp}.csv`,
      rowCount: result.rowCount,
      truncated: result.truncated,
    };
  },
};
