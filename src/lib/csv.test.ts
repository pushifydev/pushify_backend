import { describe, it, expect } from 'vitest';
import { toCsv, toCsvRows } from './csv';

/** The field-level behaviour is exercised through the two writers. */
const csvField = (value: unknown) => toCsv(['v'], [{ v: value }]).split('\r\n')[1];

describe('csvField', () => {
  it('quotes what has to be quoted, and doubles inner quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('defuses a formula — an export is opened in a spreadsheet', () => {
    // Without the leading quote, Excel runs this when the admin opens the audit log
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('-2+3')).toBe("'-2+3");
    expect(csvField('+1')).toBe("'+1");
    // …and one that also needs quoting gets both
    expect(csvField('=cmd|"/c calc"!A1')).toBe(`"'=cmd|""/c calc""!A1"`);
  });

  it('writes nothing for nothing, and JSON for an object', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField(0)).toBe('0');
    expect(csvField(false)).toBe('false');
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('the two writers', () => {
  it('writes a header and CRLF line endings, from objects or from rows', () => {
    expect(toCsv(['when', 'who'], [{ when: '2026-01-01', who: 'dana@acme.com' }])).toBe(
      'when,who\r\n2026-01-01,dana@acme.com'
    );
    expect(toCsvRows(['when', 'who'], [['2026-01-01', 'dana@acme.com']])).toBe(
      'when,who\r\n2026-01-01,dana@acme.com\r\n'
    );
  });

  it('a missing column is an empty field, not "undefined"', () => {
    expect(toCsv(['a', 'b'], [{ a: 1 }])).toBe('a,b\r\n1,');
  });
});
