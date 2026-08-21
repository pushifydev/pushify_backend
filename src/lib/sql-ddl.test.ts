import { describe, expect, it } from 'vitest';
import { StudioValidationError } from './studio-errors';
import {
  renderColumnDefinition,
  renderColumnType,
  renderDefault,
  renderTableBody,
  validateColumns,
  type ColumnDefinition,
} from './sql-ddl';

const col = (overrides: Partial<ColumnDefinition> & { name: string; type: string }): ColumnDefinition =>
  overrides;

describe('renderColumnType', () => {
  it('emits plain types verbatim', () => {
    expect(renderColumnType('postgresql', col({ name: 'a', type: 'text' }))).toBe('text');
    expect(renderColumnType('mysql', col({ name: 'a', type: 'json' }))).toBe('json');
  });

  it('rejects any type outside the allowlist', () => {
    expect(() => renderColumnType('postgresql', col({ name: 'a', type: 'money' }))).toThrow(
      StudioValidationError
    );
    // The allowlist is what stops a type field from carrying SQL of its own.
    expect(() =>
      renderColumnType('postgresql', col({ name: 'a', type: 'text); DROP TABLE users; --' }))
    ).toThrow(StudioValidationError);
    expect(() => renderColumnType('mysql', col({ name: 'a', type: 'timestamptz' }))).toThrow(
      StudioValidationError
    );
  });

  it('applies length and scale only where the type takes them', () => {
    expect(renderColumnType('postgresql', col({ name: 'a', type: 'varchar', length: 120 }))).toBe(
      'varchar(120)'
    );
    expect(
      renderColumnType('postgresql', col({ name: 'a', type: 'numeric', length: 10, scale: 2 }))
    ).toBe('numeric(10,2)');
    // text takes no length, so the length is ignored rather than emitted
    expect(renderColumnType('postgresql', col({ name: 'a', type: 'text', length: 10 }))).toBe('text');
  });

  it('rejects lengths that are not sane integers', () => {
    for (const length of [0, -1, 70000, 1.5, Number.NaN, '10; DROP TABLE t' as unknown as number]) {
      expect(() =>
        renderColumnType('postgresql', col({ name: 'a', type: 'varchar', length }))
      ).toThrow(StudioValidationError);
    }
  });

  it('maps auto-increment to the postgres serial types', () => {
    expect(
      renderColumnType('postgresql', col({ name: 'id', type: 'integer', autoIncrement: true }))
    ).toBe('serial');
    expect(
      renderColumnType('postgresql', col({ name: 'id', type: 'bigint', autoIncrement: true }))
    ).toBe('bigserial');
  });

  it('refuses auto-increment on a type that cannot carry it', () => {
    expect(() =>
      renderColumnType('postgresql', col({ name: 'id', type: 'text', autoIncrement: true }))
    ).toThrow(StudioValidationError);
  });
});

describe('renderDefault', () => {
  it('passes allowlisted expressions through unquoted', () => {
    expect(renderDefault('postgresql', 'now()')).toBe('now()');
    expect(renderDefault('postgresql', 'CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
    expect(renderDefault('postgresql', 'gen_random_uuid()')).toBe('gen_random_uuid()');
    expect(renderDefault('mysql', 'uuid()')).toBe('UUID()');
  });

  it('quotes everything else, including expression-shaped input', () => {
    expect(renderDefault('postgresql', 'hello')).toBe("'hello'");
    expect(renderDefault('postgresql', "it's")).toBe("'it''s'");
    // not on the allowlist -> becomes a literal, not an executed function
    expect(renderDefault('postgresql', 'pg_sleep(10)')).toBe("'pg_sleep(10)'");
    expect(renderDefault('mysql', "x' , (SELECT 1))--")).toBe("'x\\' , (SELECT 1))--'");
  });
});

describe('renderColumnDefinition', () => {
  it('builds a nullable column', () => {
    expect(renderColumnDefinition('postgresql', col({ name: 'title', type: 'text' }))).toBe(
      '"title" text'
    );
  });

  it('marks NOT NULL for non-nullable and primary key columns', () => {
    expect(
      renderColumnDefinition('postgresql', col({ name: 'title', type: 'text', nullable: false }))
    ).toBe('"title" text NOT NULL');
    expect(
      renderColumnDefinition('mysql', col({ name: 'id', type: 'int', primaryKey: true }))
    ).toBe('`id` int NOT NULL');
  });

  it('adds AUTO_INCREMENT on mysql but never on postgres', () => {
    expect(
      renderColumnDefinition(
        'mysql',
        col({ name: 'id', type: 'int', primaryKey: true, autoIncrement: true })
      )
    ).toBe('`id` int NOT NULL AUTO_INCREMENT');
    // serial already implies NOT NULL and its own default
    expect(
      renderColumnDefinition(
        'postgresql',
        col({ name: 'id', type: 'integer', primaryKey: true, autoIncrement: true })
      )
    ).toBe('"id" serial');
  });

  it('renders defaults and UNIQUE', () => {
    expect(
      renderColumnDefinition(
        'postgresql',
        col({ name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()' })
      )
    ).toBe('"created_at" timestamptz NOT NULL DEFAULT now()');
    expect(
      renderColumnDefinition('postgresql', col({ name: 'email', type: 'text', unique: true }))
    ).toBe('"email" text UNIQUE');
  });

  it('rejects an unsafe column name', () => {
    expect(() =>
      renderColumnDefinition('postgresql', col({ name: 'a" , b text); --', type: 'text' }))
    ).toThrow(StudioValidationError);
  });
});

describe('validateColumns', () => {
  it('requires at least one column', () => {
    expect(() => validateColumns('postgresql', [])).toThrow(StudioValidationError);
    expect(() => validateColumns('postgresql', undefined)).toThrow(StudioValidationError);
  });

  it('rejects duplicate names regardless of case', () => {
    expect(() =>
      validateColumns('postgresql', [
        col({ name: 'id', type: 'integer' }),
        col({ name: 'ID', type: 'text' }),
      ])
    ).toThrow(StudioValidationError);
  });

  it('rejects more columns than the cap', () => {
    const many = Array.from({ length: 101 }, (_, i) => col({ name: `c${i}`, type: 'text' }));
    expect(() => validateColumns('postgresql', many)).toThrow(StudioValidationError);
  });

  it('keeps mysql auto-increment tied to the primary key', () => {
    expect(() =>
      validateColumns('mysql', [col({ name: 'id', type: 'int', autoIncrement: true })])
    ).toThrow(StudioValidationError);
    expect(
      validateColumns('mysql', [
        col({ name: 'id', type: 'int', autoIncrement: true, primaryKey: true }),
      ])
    ).toHaveLength(1);
  });
});

describe('renderTableBody', () => {
  it('appends a composite primary key clause', () => {
    const body = renderTableBody('postgresql', [
      col({ name: 'org_id', type: 'uuid', primaryKey: true }),
      col({ name: 'user_id', type: 'uuid', primaryKey: true }),
      col({ name: 'role', type: 'text', nullable: false, defaultValue: 'member' }),
    ]);

    expect(body).toBe(
      [
        '"org_id" uuid NOT NULL',
        '  "user_id" uuid NOT NULL',
        "  \"role\" text NOT NULL DEFAULT 'member'",
        '  PRIMARY KEY ("org_id", "user_id")',
      ].join(',\n')
    );
  });

  it('omits the primary key clause when no column claims one', () => {
    expect(renderTableBody('mysql', [col({ name: 'note', type: 'text' })])).toBe('`note` text');
  });
});
