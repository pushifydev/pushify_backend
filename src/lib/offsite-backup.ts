/**
 * Customer database backups, kept somewhere other than the server the database runs on.
 *
 * A dump written to `/opt/pushify/backups` on the database's own server is a copy of the data
 * next to the data: it survives `DROP TABLE`, and nothing else. Lose the disk, the server or the
 * provider account and the backups go with it — which is the one case people actually keep
 * backups for.
 *
 * So after each dump the file is streamed off the server, through the control plane, to whatever
 * `DB_BACKUP_RCLONE_REMOTE` names (S3, R2, B2, a Hetzner Storage Box over sftp, an rclone crypt
 * remote over any of those). The credentials stay on the control plane: writing the operator's
 * storage credentials onto every customer server would mean one compromised server could read —
 * or delete — every other customer's backups.
 *
 * This module is the part with no I/O: where a backup belongs, and what to run.
 */

/** A path segment that cannot climb out of, or rename, the place it is meant to be. */
export function safeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/\.+$/, '');
  return cleaned || 'unnamed';
}

export interface BackupLocation {
  organizationId: string;
  databaseId: string;
  fileName: string;
}

/**
 * Where a backup lives on the remote: organization, then database, then the dump.
 *
 * By id rather than by name, because names are the customer's and change; a rename must not
 * strand yesterday's backups under a directory nothing looks in any more.
 */
export function remoteObjectPath(remote: string, location: BackupLocation): string {
  const base = remote.replace(/\/+$/, '');
  return [
    base,
    safeSegment(location.organizationId),
    safeSegment(location.databaseId),
    safeSegment(location.fileName),
  ].join('/');
}

/** Everything belonging to one database, for removing it with the database. */
export function remoteDatabasePrefix(remote: string, organizationId: string, databaseId: string): string {
  return [remote.replace(/\/+$/, ''), safeSegment(organizationId), safeSegment(databaseId)].join('/');
}

/**
 * `rclone rcat` writes what it reads on stdin to that path, creating directories as it goes —
 * so the dump never touches the control plane's disk on the way through.
 */
export function rcatArgs(remotePath: string): string[] {
  return ['rcat', '--retries', '3', '--low-level-retries', '5', remotePath];
}

/** Remote copies past their retention. `--min-age` is rclone's "older than". */
export function pruneArgs(prefix: string, keepDays: number): string[] {
  return ['delete', '--min-age', `${Math.max(1, Math.round(keepDays))}d`, '--rmdirs', prefix];
}

/** Everything under a prefix — used when a database is deleted. */
export function purgeArgs(prefix: string): string[] {
  return ['purge', prefix];
}

/** Read one backup back, to stdout, for a restore after the server is gone. */
export function catArgs(remotePath: string): string[] {
  return ['cat', remotePath];
}

/** Is a copy of this backup expected off-site? */
export function offsiteConfigured(remote: string | undefined | null): remote is string {
  return typeof remote === 'string' && remote.trim().length > 0;
}

/**
 * An rclone remote has to name one: `name:` or `name:path`. A bare path would write to the
 * control plane's own disk, which is not off-site at all.
 */
export function validateRemote(remote: string): string | null {
  const value = remote.trim();
  if (!value) return 'A remote is required';
  if (!/^[A-Za-z0-9_.-]+:/.test(value)) {
    return 'The remote must name an rclone remote, e.g. "backups:pushify/databases"';
  }
  if (/[\n\r]/.test(value)) return 'The remote must be a single line';
  return null;
}
