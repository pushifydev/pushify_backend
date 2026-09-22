/** CSV serialisation for query exports and the audit-log export. */

/**
 * A field starting with `=`, `+`, `-` or `@` is read as a *formula* by Excel and Google Sheets,
 * so a value someone else wrote — a project name, a commit message, a row in a table — could run
 * when an admin opens the export. Prefixing those with a quote keeps the text readable and inert.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180: quote when the value carries a delimiter, quote or newline; double inner quotes. */
function toCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(toCsvField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => toCsvField(row[column])).join(','));
  }
  return lines.join('\r\n');
}

/** The same file from rows given positionally, for an export that is built rather than queried. */
export function toCsvRows(headers: string[], rows: unknown[][]): string {
  return [headers.map(toCsvField).join(','), ...rows.map((row) => row.map(toCsvField).join(','))].join('\r\n') + '\r\n';
}
