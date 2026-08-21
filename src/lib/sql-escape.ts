/**
 * Quoting/escaping helpers for the database studio, which talks to PostgreSQL and MySQL through
 * their CLI clients and therefore cannot use bind parameters.
 *
 * These assume the session has been pinned to a known escaping mode by the caller:
 *   - PostgreSQL: standard_conforming_strings = on  (backslash is a literal, '' escapes a quote)
 *   - MySQL: NO_BACKSLASH_ESCAPES cleared           (backslash escapes are active)
 */

export type SqlEngine = 'postgresql' | 'mysql';

/** Quote a value for the remote POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Identifiers are always checked against the live catalog before use; this is the cheap
 * pre-filter that rejects the shapes which could break out of identifier quoting.
 */
export function isSafeIdentifier(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 128) return false;
  return !/[\u0000-\u001f"`\\]/.test(name);
}

export function quoteIdent(engine: SqlEngine, name: string): string {
  return engine === 'postgresql'
    ? `"${name.replace(/"/g, '""')}"`
    : `\`${name.replace(/`/g, '``')}\``;
}

const MYSQL_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  "'": "\\'",
  '"': '\\"',
  '\u0000': '\\0',
  '\n': '\\n',
  '\r': '\\r',
  '\u001a': '\\Z',
};

export function quoteLiteral(engine: SqlEngine, value: string): string {
  if (engine === 'postgresql') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/[\\'"\u0000\n\r\u001a]/g, (ch) => MYSQL_ESCAPES[ch] ?? ch)}'`;
}

/** Neutralise LIKE wildcards in user input; pair with `ESCAPE '\'`. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface StatementShape {
  /** the statement without its trailing semicolon */
  body: string;
  isSingleStatement: boolean;
  /** a SELECT/WITH that can be wrapped in a subquery for row capping */
  isSelectLike: boolean;
  /** any statement that only reads */
  isReadCommand: boolean;
}

/**
 * Classify console input. `isSingleStatement` is deliberately conservative: a semicolon inside a
 * string literal counts as multi-statement, which only costs the grid view, never safety.
 */
export function classifyStatement(sql: string): StatementShape {
  const body = sql.trim().replace(/;\s*$/, '');
  return {
    body,
    isSingleStatement: !body.includes(';'),
    isSelectLike: /^(select|with)\b/i.test(body),
    isReadCommand: /^(select|with|show|explain|describe|desc|analyze)\b/i.test(body),
  };
}
