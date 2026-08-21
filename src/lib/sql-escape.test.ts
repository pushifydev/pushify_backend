import { describe, expect, it } from 'vitest';
import {
  classifyStatement,
  escapeLikePattern,
  isSafeIdentifier,
  quoteIdent,
  quoteLiteral,
  shellQuote,
} from './sql-escape';

describe('shellQuote', () => {
  it('keeps a quote from ending the argument', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('leaves shell metacharacters inert inside the quotes', () => {
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellQuote('a; whoami')).toBe("'a; whoami'");
  });
});

describe('isSafeIdentifier', () => {
  it('accepts ordinary and unicode table names', () => {
    expect(isSafeIdentifier('users')).toBe(true);
    expect(isSafeIdentifier('order items')).toBe(true);
    expect(isSafeIdentifier('kullanıcılar')).toBe(true);
  });

  it('rejects quoting characters and control characters', () => {
    expect(isSafeIdentifier('users"')).toBe(false);
    expect(isSafeIdentifier('users`')).toBe(false);
    expect(isSafeIdentifier('users\\')).toBe(false);
    expect(isSafeIdentifier('users\nDROP')).toBe(false);
    expect(isSafeIdentifier('a\u0000b')).toBe(false);
  });

  it('rejects non-strings and out-of-range lengths', () => {
    expect(isSafeIdentifier(undefined)).toBe(false);
    expect(isSafeIdentifier(42)).toBe(false);
    expect(isSafeIdentifier('')).toBe(false);
    expect(isSafeIdentifier('x'.repeat(129))).toBe(false);
  });
});

describe('quoteIdent', () => {
  it('doubles the engine quote character', () => {
    expect(quoteIdent('postgresql', 'we"ird')).toBe('"we""ird"');
    expect(quoteIdent('mysql', 'we`ird')).toBe('`we``ird`');
  });
});

describe('quoteLiteral', () => {
  it('doubles single quotes for postgres', () => {
    expect(quoteLiteral('postgresql', "O'Brien")).toBe("'O''Brien'");
  });

  it('leaves backslashes alone for postgres (standard_conforming_strings)', () => {
    expect(quoteLiteral('postgresql', 'a\\b')).toBe("'a\\b'");
  });

  it('backslash-escapes for mysql', () => {
    expect(quoteLiteral('mysql', "O'Brien")).toBe("'O\\'Brien'");
    expect(quoteLiteral('mysql', 'a\\b')).toBe("'a\\\\b'");
  });

  it('neutralises a backslash-quote break-out attempt on mysql', () => {
    // Without escaping the backslash first, `\' OR 1=1 -- ` would close the literal.
    expect(quoteLiteral('mysql', "\\' OR 1=1 -- ")).toBe("'\\\\\\' OR 1=1 -- '");
  });

  it('escapes the control characters mysql treats specially', () => {
    expect(quoteLiteral('mysql', 'a\u0000b')).toBe("'a\\0b'");
    expect(quoteLiteral('mysql', 'a\nb')).toBe("'a\\nb'");
    expect(quoteLiteral('mysql', 'a\u001ab')).toBe("'a\\Zb'");
  });
});

describe('escapeLikePattern', () => {
  it('escapes wildcards so a filter cannot match everything', () => {
    expect(escapeLikePattern('100%_off')).toBe('100\\%\\_off');
  });
});

describe('classifyStatement', () => {
  it('strips the trailing semicolon', () => {
    expect(classifyStatement('SELECT 1;').body).toBe('SELECT 1');
  });

  it('marks a single select as wrappable', () => {
    const shape = classifyStatement('select * from users where id = 1');
    expect(shape.isSingleStatement).toBe(true);
    expect(shape.isSelectLike).toBe(true);
    expect(shape.isReadCommand).toBe(true);
  });

  it('treats a chained statement as multi-statement', () => {
    const shape = classifyStatement('SELECT 1; DROP TABLE users');
    expect(shape.isSingleStatement).toBe(false);
  });

  it('treats a commit break-out attempt as multi-statement', () => {
    const shape = classifyStatement('SELECT 1; COMMIT; DELETE FROM users');
    expect(shape.isSingleStatement).toBe(false);
  });

  it('does not call a write statement a read command', () => {
    expect(classifyStatement('DELETE FROM users').isReadCommand).toBe(false);
    expect(classifyStatement('UPDATE users SET a = 1').isReadCommand).toBe(false);
    expect(classifyStatement('  drop table users  ').isReadCommand).toBe(false);
  });

  it('accepts CTEs and inspection commands as reads', () => {
    expect(classifyStatement('WITH x AS (SELECT 1) SELECT * FROM x').isSelectLike).toBe(true);
    expect(classifyStatement('SHOW TABLES').isReadCommand).toBe(true);
    expect(classifyStatement('EXPLAIN SELECT 1').isReadCommand).toBe(true);
    // EXPLAIN cannot be wrapped in a subquery, so it must not be grid-wrapped
    expect(classifyStatement('EXPLAIN SELECT 1').isSelectLike).toBe(false);
  });
});
