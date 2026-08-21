/**
 * DDL rendering for the database studio's schema editor.
 *
 * Types cannot be checked against the catalog the way table and column names are — they do not
 * exist yet — so every type token comes from the allowlist below and only the matched token is
 * emitted. Defaults are quoted literals unless they match a small allowlist of expressions.
 *
 * Validation failures throw `StudioValidationError` carrying an i18n key; the service turns those
 * into 400s in the caller's language.
 */
import { isSafeIdentifier, quoteIdent, quoteLiteral, type SqlEngine } from './sql-escape';
import { StudioValidationError } from './studio-errors';

export interface SqlTypeInfo {
  /** the SQL type token, emitted verbatim once matched */
  name: string;
  hasLength?: boolean;
  hasScale?: boolean;
  autoIncrementable?: boolean;
}

export interface ColumnDefinition {
  name: string;
  type: string;
  length?: number | null;
  scale?: number | null;
  nullable?: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unique?: boolean;
  defaultValue?: string | null;
}

export const MAX_TABLE_COLUMNS = 100;

export const COLUMN_TYPES: Record<SqlEngine, SqlTypeInfo[]> = {
  postgresql: [
    { name: 'text' },
    { name: 'varchar', hasLength: true },
    { name: 'char', hasLength: true },
    { name: 'integer', autoIncrementable: true },
    { name: 'bigint', autoIncrementable: true },
    { name: 'smallint' },
    { name: 'numeric', hasLength: true, hasScale: true },
    { name: 'real' },
    { name: 'double precision' },
    { name: 'boolean' },
    { name: 'date' },
    { name: 'timestamptz' },
    { name: 'timestamp' },
    { name: 'time' },
    { name: 'uuid' },
    { name: 'json' },
    { name: 'jsonb' },
    { name: 'bytea' },
    { name: 'inet' },
  ],
  mysql: [
    { name: 'int', autoIncrementable: true },
    { name: 'bigint', autoIncrementable: true },
    { name: 'smallint' },
    { name: 'tinyint' },
    { name: 'decimal', hasLength: true, hasScale: true },
    { name: 'float' },
    { name: 'double' },
    { name: 'varchar', hasLength: true },
    { name: 'char', hasLength: true },
    { name: 'text' },
    { name: 'mediumtext' },
    { name: 'longtext' },
    { name: 'boolean' },
    { name: 'date' },
    { name: 'datetime' },
    { name: 'timestamp' },
    { name: 'time' },
    { name: 'json' },
    { name: 'blob' },
    { name: 'varbinary', hasLength: true },
  ],
};

/** The expressions people actually reach for in a default. Anything else is quoted. */
const DEFAULT_EXPRESSIONS: Record<SqlEngine, Record<string, string>> = {
  postgresql: {
    'now()': 'now()',
    current_timestamp: 'CURRENT_TIMESTAMP',
    current_date: 'CURRENT_DATE',
    'gen_random_uuid()': 'gen_random_uuid()',
    null: 'NULL',
    true: 'TRUE',
    false: 'FALSE',
  },
  mysql: {
    'now()': 'NOW()',
    current_timestamp: 'CURRENT_TIMESTAMP',
    'uuid()': 'UUID()',
    null: 'NULL',
    true: 'TRUE',
    false: 'FALSE',
  },
};

export function renderDefault(engine: SqlEngine, raw: string): string {
  return DEFAULT_EXPRESSIONS[engine][raw.trim().toLowerCase()] ?? quoteLiteral(engine, raw);
}

function boundedInteger(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new StudioValidationError('studioInvalidColumnType');
  }
  return parsed;
}

export function renderColumnType(engine: SqlEngine, column: ColumnDefinition): string {
  const info = COLUMN_TYPES[engine].find((type) => type.name === column.type);
  if (!info) throw new StudioValidationError('studioInvalidColumnType');

  if (column.autoIncrement) {
    if (!info.autoIncrementable) throw new StudioValidationError('studioAutoIncrementType');
    // Postgres has no AUTO_INCREMENT flag; the serial pseudo-types are the equivalent.
    if (engine === 'postgresql') return column.type === 'bigint' ? 'bigserial' : 'serial';
  }

  if (info.hasLength && column.length !== undefined && column.length !== null) {
    const length = boundedInteger(column.length, 1, 65535);
    if (info.hasScale && column.scale !== undefined && column.scale !== null) {
      return `${info.name}(${length},${boundedInteger(column.scale, 0, length)})`;
    }
    return `${info.name}(${length})`;
  }

  return info.name;
}

export function renderColumnDefinition(engine: SqlEngine, column: ColumnDefinition): string {
  if (!isSafeIdentifier(column.name)) throw new StudioValidationError('studioInvalidIdentifier');

  const parts = [quoteIdent(engine, column.name), renderColumnType(engine, column)];

  // A postgres serial column already carries NOT NULL and its own default.
  const isPgSerial = engine === 'postgresql' && column.autoIncrement === true;

  if (!isPgSerial && (column.nullable === false || column.primaryKey)) {
    parts.push('NOT NULL');
  }

  if (!isPgSerial && !column.autoIncrement && column.defaultValue) {
    parts.push(`DEFAULT ${renderDefault(engine, column.defaultValue)}`);
  }

  if (engine === 'mysql' && column.autoIncrement) {
    parts.push('AUTO_INCREMENT');
  }

  if (column.unique && !column.primaryKey) {
    parts.push('UNIQUE');
  }

  return parts.join(' ');
}

/** Validate a column list for CREATE TABLE / ADD COLUMN and return it unchanged. */
export function validateColumns(
  engine: SqlEngine,
  columns: ColumnDefinition[] | undefined
): ColumnDefinition[] {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new StudioValidationError('studioNoColumns');
  }
  if (columns.length > MAX_TABLE_COLUMNS) {
    throw new StudioValidationError('studioTooManyColumns');
  }

  const seen = new Set<string>();
  for (const column of columns) {
    if (!isSafeIdentifier(column.name)) throw new StudioValidationError('studioInvalidIdentifier');

    const key = column.name.toLowerCase();
    if (seen.has(key)) throw new StudioValidationError('studioDuplicateColumn');
    seen.add(key);

    // MySQL only allows AUTO_INCREMENT on a key column, so keep it tied to the primary key.
    if (engine === 'mysql' && column.autoIncrement && !column.primaryKey) {
      throw new StudioValidationError('studioAutoIncrementKey');
    }
  }

  return columns;
}

/** Body of a CREATE TABLE statement: the column definitions plus an optional primary key. */
export function renderTableBody(engine: SqlEngine, columns: ColumnDefinition[]): string {
  const definitions = columns.map((column) => renderColumnDefinition(engine, column));

  const primaryKey = columns
    .filter((column) => column.primaryKey)
    .map((column) => quoteIdent(engine, column.name));

  if (primaryKey.length > 0) {
    definitions.push(`PRIMARY KEY (${primaryKey.join(', ')})`);
  }

  return definitions.join(',\n  ');
}
