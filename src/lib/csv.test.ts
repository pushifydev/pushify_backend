import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('writes a header row and one line per row', () => {
    expect(toCsv(['a', 'b'], [{ a: 1, b: 2 }])).toBe('a,b\r\n1,2');
  });

  it('quotes values carrying a comma, quote or newline', () => {
    expect(toCsv(['a'], [{ a: 'x,y' }])).toBe('a\r\n"x,y"');
    expect(toCsv(['a'], [{ a: 'say "hi"' }])).toBe('a\r\n"say ""hi"""');
    expect(toCsv(['a'], [{ a: 'line1\nline2' }])).toBe('a\r\n"line1\nline2"');
  });

  it('writes null and undefined as an empty field', () => {
    expect(toCsv(['a', 'b'], [{ a: null, b: undefined }])).toBe('a,b\r\n,');
  });

  it('serialises objects as JSON', () => {
    expect(toCsv(['a'], [{ a: { x: 1 } }])).toBe('a\r\n"{""x"":1}"');
  });

  it('keeps column order and tolerates missing keys', () => {
    expect(toCsv(['a', 'b', 'c'], [{ c: 3, a: 1 }])).toBe('a,b,c\r\n1,,3');
  });
});
