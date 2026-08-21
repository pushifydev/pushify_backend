/** CSV serialisation for query exports. */

/** RFC 4180: quote when the value carries a delimiter, quote or newline; double inner quotes. */
function toCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(toCsvField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => toCsvField(row[column])).join(','));
  }
  return lines.join('\r\n');
}
