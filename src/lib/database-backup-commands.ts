import type { DatabaseType } from '../db/schema/databases';

/**
 * Shell commands (run as root on the database's server) that dump a managed database into
 * `backupPath` and restore one from `filePath`. Every value is single-quoted.
 */

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export function buildDumpCommand(
  containerName: string,
  type: DatabaseType,
  username: string,
  password: string,
  databaseName: string,
  fileName: string,
  backupPath: string
): string {
  const eCont = shellEscape(containerName);
  const eUser = shellEscape(username);
  const ePass = shellEscape(password);
  const eDb = shellEscape(databaseName);
  const eFile = shellEscape(fileName);
  const ePath = shellEscape(backupPath);

  switch (type) {
    case 'postgresql':
      // pipefail: a failed pg_dump must not leave a "successful" empty archive.
      // --clean --if-exists: the dump replaces what's there on restore instead of colliding with it.
      return `docker exec ${eCont} bash -c "set -o pipefail; pg_dump --clean --if-exists -U ${eUser} -d ${eDb} | gzip > /tmp/${eFile}" && docker cp ${eCont}:/tmp/${eFile} ${ePath}/; rc=$?; docker exec ${eCont} rm -f /tmp/${eFile}; exit $rc`;

    case 'mysql':
      // --no-tablespaces: the app user has no PROCESS privilege; --single-transaction: consistent, no locks.
      return `docker exec -e MYSQL_PWD=${ePass} ${eCont} bash -c "set -o pipefail; mysqldump --single-transaction --no-tablespaces -u ${eUser} ${eDb} | gzip > /tmp/${eFile}" && docker cp ${eCont}:/tmp/${eFile} ${ePath}/; rc=$?; docker exec ${eCont} rm -f /tmp/${eFile}; exit $rc`;

    case 'mongodb':
      return `docker exec ${eCont} mongodump --username ${eUser} --password ${ePass} --authenticationDatabase admin --db ${eDb} --archive=/tmp/${eFile} --gzip && docker cp ${eCont}:/tmp/${eFile} ${ePath}/; rc=$?; docker exec ${eCont} rm -f /tmp/${eFile}; exit $rc`;

    case 'redis':
      // SAVE, not BGSAVE + sleep: the copy must not race an unfinished snapshot.
      return `docker exec -e REDISCLI_AUTH=${ePass} ${eCont} redis-cli SAVE | grep -q OK && docker cp ${eCont}:/data/dump.rdb ${ePath}/${eFile}`;
  }
}

export function buildRestoreCommand(
  containerName: string,
  type: DatabaseType,
  username: string,
  password: string,
  databaseName: string,
  filePath: string
): string {
  const fileName = filePath.split('/').pop()!;

  const eCont = shellEscape(containerName);
  const eUser = shellEscape(username);
  const ePass = shellEscape(password);
  const eDb = shellEscape(databaseName);
  const eFile = shellEscape(fileName);
  const ePath = shellEscape(filePath);

  switch (type) {
    case 'postgresql':
      // One transaction, stop on the first error: a restore either lands whole or leaves the
      // database as it was. The public schema is reset first so older dumps (no --clean) don't
      // collide with the tables they are meant to replace; USAGE for PUBLIC is what a fresh
      // database's public schema has (the read-only user relies on it).
      return `docker cp ${ePath} ${eCont}:/tmp/${eFile} && docker exec ${eCont} bash -c "set -o pipefail; { echo 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;'; gunzip -c /tmp/${eFile}; } | psql -q -v ON_ERROR_STOP=1 --single-transaction -U ${eUser} -d ${eDb} >/dev/null"; rc=$?; docker exec ${eCont} rm -f /tmp/${eFile}; exit $rc`;

    case 'mysql':
      return `docker cp ${ePath} ${eCont}:/tmp/${eFile} && docker exec -e MYSQL_PWD=${ePass} ${eCont} bash -c "set -o pipefail; gunzip -c /tmp/${eFile} | mysql -u ${eUser} ${eDb}"; rc=$?; docker exec ${eCont} rm -f /tmp/${eFile}; exit $rc`;

    case 'mongodb':
      return `docker cp ${ePath} ${eCont}:/tmp/${eFile} && docker exec ${eCont} mongorestore --username ${eUser} --password ${ePass} --authenticationDatabase admin --nsInclude=${eDb}.'*' --archive=/tmp/${eFile} --gzip --drop; rc=$?; docker exec ${eCont} rm -f /tmp/${eFile}; exit $rc`;

    case 'redis':
      // SHUTDOWN NOSAVE let the restart policy bring Redis straight back on the old data. A plain
      // stop (it saves), then overwrite the snapshot while the container is down, then start.
      return `docker stop ${eCont} >/dev/null && docker cp ${ePath} ${eCont}:/data/dump.rdb && docker start ${eCont} >/dev/null`;
  }
}
