import { describe, it, expect } from 'vitest';
import {
  buildConnectionString,
  buildDatabaseRunCommand,
  internalConnectionString,
  planLinkedDatabaseEnv,
  validateDatabaseVersion,
  validateEnvVarName,
  type LinkedDatabase,
} from './managed-database';

const link = (overrides: Partial<LinkedDatabase> = {}): LinkedDatabase => ({
  envVarName: 'DATABASE_URL',
  name: 'main',
  type: 'postgresql',
  serverId: 'srv-1',
  containerName: 'pushify-db-main',
  username: 'user_main',
  databaseName: 'main',
  externalAccess: false,
  password: 'p@ss/word',
  connectionString: 'postgresql://user_main:p%40ss%2Fword@203.0.113.7:6432/main',
  ...overrides,
});

describe('planLinkedDatabaseEnv', () => {
  it('uses the container address on the same server — the public one is unreachable from apps', () => {
    const { vars } = planLinkedDatabaseEnv([link()], 'srv-1', new Set());
    expect(vars.DATABASE_URL).toBe('postgresql://user_main:p%40ss%2Fword@pushify-db-main:5432/main');
  });

  it('falls back to the public address for a database on another server with external access', () => {
    const { vars } = planLinkedDatabaseEnv([link({ externalAccess: true })], 'srv-2', new Set());
    expect(vars.DATABASE_URL).toContain('@203.0.113.7:6432/');
  });

  it('sets nothing (and says why) for another server without external access', () => {
    const { vars, notes } = planLinkedDatabaseEnv([link()], 'srv-2', new Set());
    expect(vars).toEqual({});
    expect(notes[0]).toMatch(/another server without external access/);
  });

  it("never overrides a variable the project sets itself", () => {
    const { vars, notes } = planLinkedDatabaseEnv([link()], 'srv-1', new Set(['DATABASE_URL']));
    expect(vars).toEqual({});
    expect(notes[0]).toMatch(/keeping it/);
  });

  it('keeps the first of two links that want the same variable', () => {
    const { vars } = planLinkedDatabaseEnv(
      [link(), link({ name: 'other', containerName: 'pushify-db-other', databaseName: 'other' })],
      'srv-1',
      new Set()
    );
    expect(vars.DATABASE_URL).toContain('@pushify-db-main:5432/main');
  });
});

describe('connection strings', () => {
  it('redis uses the database port inside the network', () => {
    expect(
      internalConnectionString({ type: 'redis', containerName: 'pushify-db-cache', username: 'u', databaseName: 'cache' }, 'pw')
    ).toBe('redis://:pw@pushify-db-cache:6379');
  });

  it('mongodb authenticates against admin, where the image creates the user', () => {
    expect(buildConnectionString('mongodb', 'h', 27017, 'u', 'p', 'app')).toBe('mongodb://u:p@h:27017/app?authSource=admin');
  });
});

describe('buildDatabaseRunCommand', () => {
  const base = {
    type: 'postgresql' as const,
    version: '16',
    containerName: 'pushify-db-main',
    hostPort: 6432,
    externalAccess: false,
    databaseName: 'main',
    username: 'user_main',
    password: 'secret',
  };

  it('runs on the database network, loopback-only, hardened', () => {
    const cmd = buildDatabaseRunCommand(base);
    expect(cmd).toContain('--network pushify');
    expect(cmd).toContain('-p 127.0.0.1:6432:5432');
    expect(cmd).toContain('--security-opt no-new-privileges');
    expect(cmd).toContain("-v '/opt/pushify/databases/main:/var/lib/postgresql/data'");
    expect(cmd).toContain("'postgres:16'");
  });

  it('publishes on all interfaces only with external access', () => {
    expect(buildDatabaseRunCommand({ ...base, externalAccess: true })).toContain('-p 0.0.0.0:6432:5432');
  });

  it('puts the redis password on the command line, quoted', () => {
    expect(buildDatabaseRunCommand({ ...base, type: 'redis', version: '7' })).toMatch(/redis-server --requirepass 'secret'$/);
  });
});

describe('input validation', () => {
  it('accepts image tags and rejects shell', () => {
    expect(validateDatabaseVersion('16')).toBeNull();
    expect(validateDatabaseVersion('8.0')).toBeNull();
    expect(validateDatabaseVersion('7-alpine')).toBeNull();
    expect(validateDatabaseVersion('16; rm -rf /')).not.toBeNull();
    expect(validateDatabaseVersion('$(id)')).not.toBeNull();
  });

  it('accepts POSIX variable names only', () => {
    expect(validateEnvVarName('DATABASE_URL')).toBeNull();
    expect(validateEnvVarName('_x1')).toBeNull();
    expect(validateEnvVarName('1ABC')).not.toBeNull();
    expect(validateEnvVarName('A=B')).not.toBeNull();
    expect(validateEnvVarName('A B')).not.toBeNull();
  });
});
