import { describe, it, expect } from 'vitest';
import {
  catArgs,
  offsiteConfigured,
  pruneArgs,
  purgeArgs,
  rcatArgs,
  remoteDatabasePrefix,
  remoteObjectPath,
  safeSegment,
  validateRemote,
} from './offsite-backup';

const location = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  databaseId: '22222222-2222-4222-8222-222222222222',
  fileName: 'main-2026-09-23T00-00-00.sql.gz',
};

describe('safeSegment', () => {
  it('cannot climb out of the directory it is meant to be in', () => {
    expect(safeSegment('../../etc/passwd')).toBe('etc-passwd');
    expect(safeSegment('..')).toBe('unnamed');
    expect(safeSegment('/')).toBe('unnamed');
    expect(safeSegment('a/b')).toBe('a-b');
  });

  it('keeps an ordinary name as it is', () => {
    expect(safeSegment('main-2026-09-23.sql.gz')).toBe('main-2026-09-23.sql.gz');
    expect(safeSegment(location.databaseId)).toBe(location.databaseId);
  });

  it('never returns an empty segment, which would collapse the path', () => {
    expect(safeSegment('')).toBe('unnamed');
    expect(safeSegment('   ')).toBe('unnamed');
    expect(safeSegment('!!!')).toBe('unnamed');
  });
});

describe('remote paths', () => {
  it('files a backup under its organization and database', () => {
    expect(remoteObjectPath('backups:pushify/db', location)).toBe(
      `backups:pushify/db/${location.organizationId}/${location.databaseId}/${location.fileName}`
    );
  });

  it('ignores a trailing slash on the remote', () => {
    expect(remoteObjectPath('backups:pushify/db/', location)).toBe(
      remoteObjectPath('backups:pushify/db', location)
    );
  });

  it('uses ids, not names — a rename must not strand yesterday\'s backups', () => {
    const prefix = remoteDatabasePrefix('backups:db', location.organizationId, location.databaseId);
    expect(prefix).toBe(`backups:db/${location.organizationId}/${location.databaseId}`);
    expect(remoteObjectPath('backups:db', location).startsWith(prefix + '/')).toBe(true);
  });

  it('a hostile database name cannot write into another database\'s directory', () => {
    const escaped = remoteObjectPath('backups:db', { ...location, fileName: '../../other/take-this.sql' });
    expect(escaped).toBe(`backups:db/${location.organizationId}/${location.databaseId}/other-take-this.sql`);
    expect(escaped).not.toContain('..');
  });
});

describe('rclone commands', () => {
  it('streams stdin straight to the remote, so nothing lands on our disk', () => {
    expect(rcatArgs('backups:db/a/b/c.sql.gz')).toEqual([
      'rcat', '--retries', '3', '--low-level-retries', '5', 'backups:db/a/b/c.sql.gz',
    ]);
  });

  it('deletes only what is older than the retention, and tidies the directories', () => {
    expect(pruneArgs('backups:db/a/b', 30)).toEqual(['delete', '--min-age', '30d', '--rmdirs', 'backups:db/a/b']);
    // Never 0d, which would delete the backup that was just made
    expect(pruneArgs('backups:db/a/b', 0)).toEqual(['delete', '--min-age', '1d', '--rmdirs', 'backups:db/a/b']);
  });

  it('purges everything of a database, and reads one back', () => {
    expect(purgeArgs('backups:db/a/b')).toEqual(['purge', 'backups:db/a/b']);
    expect(catArgs('backups:db/a/b/c.sql.gz')).toEqual(['cat', 'backups:db/a/b/c.sql.gz']);
  });
});

describe('configuration', () => {
  it('is off until a remote is set', () => {
    expect(offsiteConfigured(undefined)).toBe(false);
    expect(offsiteConfigured('')).toBe(false);
    expect(offsiteConfigured('   ')).toBe(false);
    expect(offsiteConfigured('backups:db')).toBe(true);
  });

  it('refuses a bare path — the control plane\'s own disk is not off-site', () => {
    expect(validateRemote('backups:pushify/db')).toBeNull();
    expect(validateRemote('s3:')).toBeNull();
    expect(validateRemote('/var/backups')).toMatch(/rclone remote/);
    expect(validateRemote('./backups')).not.toBeNull();
    expect(validateRemote('')).toMatch(/required/);
  });
});
