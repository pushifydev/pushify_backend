import type { DatabaseType } from '../db/schema/databases';

/**
 * Restore-verification for database backups.
 *
 * A backup nobody has restored is a hope, not a backup. This builds a bash script
 * that — on the database's own server — boots a throwaway container from the SAME
 * image as the live database, restores the dump into it, counts what came back,
 * and removes the container again (trap on EXIT, so cleanup survives failures).
 * The live database is never touched. The last line of stdout is a JSON marker
 * the service parses.
 */

export const VERIFY_MARKER = 'PUSHIFY_VERIFY';
/** Upper bound for the whole run (readiness + restore + counts) on the server. */
export const VERIFY_TIMEOUT_SECONDS = 15 * 60;
/** Dumps above this are skipped — a restore that big competes with production for disk/CPU. */
export const MAX_VERIFY_SIZE_MB = 2048;
/** Re-verify the latest backup this often. */
export const VERIFY_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

export type VerificationStatus = 'verifying' | 'verified' | 'failed' | 'skipped';

export interface BackupVerification {
  status: VerificationStatus;
  checkedAt: string;
  durationMs?: number;
  /** Tables / collections / keyspaces restored. */
  tables?: number;
  /** Rows / documents / keys counted after restore. */
  rows?: number;
  unit?: 'rows' | 'documents' | 'keys';
  error?: string;
}

export function verifyUnitFor(type: DatabaseType): BackupVerification['unit'] {
  if (type === 'mongodb') return 'documents';
  if (type === 'redis') return 'keys';
  return 'rows';
}

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export interface VerifyScriptInput {
  type: DatabaseType;
  /** Live database container — only inspected for its image name. */
  containerName: string;
  filePath: string;
  username: string;
  password: string;
  databaseName: string;
  /** Unique throwaway container name, e.g. pushify-verify-<backupId>. */
  verifyContainerName: string;
}

/** Engine-specific body: boot, wait, restore, count. Sets TABLES, ROWS, RC. */
function engineBody(type: DatabaseType): string {
  switch (type) {
    case 'postgresql':
      return `
docker run -d --name "$V" --memory=512m --cpus=1 --network none \\
  -e POSTGRES_USER="$U" -e POSTGRES_PASSWORD="$P" -e POSTGRES_DB="$DB" "$IMG" >/dev/null
for i in $(seq 1 60); do docker exec "$V" pg_isready -U "$U" -d "$DB" >/dev/null 2>&1 && READY=1 && break; sleep 1; done
[ "\${READY:-0}" = 1 ] || fail "container did not become ready"
docker cp "$F" "$V":/tmp/restore.sql.gz
docker exec "$V" bash -c 'gunzip -c /tmp/restore.sql.gz | psql -q -U "'"$U"'" -d "'"$DB"'"' >/dev/null 2>&1; RC=$?
TABLES=$(docker exec "$V" psql -tA -U "$U" -d "$DB" -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')" 2>/dev/null)
ROWS=$(docker exec "$V" psql -tA -U "$U" -d "$DB" -c "select coalesce(sum(n_live_tup),0)::bigint from pg_stat_user_tables" 2>/dev/null)
`;
    case 'mysql':
      return `
USERENV=()
if [ "$U" != root ]; then USERENV=(-e MYSQL_USER="$U" -e MYSQL_PASSWORD="$P"); fi
docker run -d --name "$V" --memory=768m --cpus=1 --network none \\
  -e MYSQL_ROOT_PASSWORD="$P" -e MYSQL_DATABASE="$DB" \${USERENV[@]+"\${USERENV[@]}"} "$IMG" >/dev/null
for i in $(seq 1 90); do docker exec "$V" mysqladmin ping -uroot -p"$P" --silent >/dev/null 2>&1 && READY=1 && break; sleep 1; done
[ "\${READY:-0}" = 1 ] || fail "container did not become ready"
docker cp "$F" "$V":/tmp/restore.sql.gz
docker exec -e MYSQL_PWD="$P" "$V" bash -c 'gunzip -c /tmp/restore.sql.gz | mysql -uroot "'"$DB"'"' >/dev/null 2>&1; RC=$?
TABLES=$(docker exec -e MYSQL_PWD="$P" "$V" mysql -uroot -N -e "select count(*) from information_schema.tables where table_schema='$DB'" 2>/dev/null)
ROWS=$(docker exec -e MYSQL_PWD="$P" "$V" mysql -uroot -N -e "select coalesce(sum(table_rows),0) from information_schema.tables where table_schema='$DB'" 2>/dev/null)
`;
    case 'mongodb':
      return `
docker run -d --name "$V" --memory=512m --cpus=1 --network none \\
  -e MONGO_INITDB_ROOT_USERNAME="$U" -e MONGO_INITDB_ROOT_PASSWORD="$P" "$IMG" >/dev/null
MSH=mongosh; docker exec "$V" sh -c 'command -v mongosh' >/dev/null 2>&1 || MSH=mongo
for i in $(seq 1 60); do docker exec "$V" $MSH --quiet -u "$U" -p "$P" --authenticationDatabase admin --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && READY=1 && break; sleep 1; done
[ "\${READY:-0}" = 1 ] || fail "container did not become ready"
docker cp "$F" "$V":/tmp/restore.archive
docker exec "$V" mongorestore --username "$U" --password "$P" --authenticationDatabase admin --nsInclude "$DB.*" --archive=/tmp/restore.archive --gzip >/dev/null 2>&1; RC=$?
TABLES=$(docker exec "$V" $MSH --quiet -u "$U" -p "$P" --authenticationDatabase admin "$DB" --eval 'db.getCollectionNames().length' 2>/dev/null)
ROWS=$(docker exec "$V" $MSH --quiet -u "$U" -p "$P" --authenticationDatabase admin "$DB" --eval 'db.getCollectionNames().reduce((a,c)=>a+db.getCollection(c).estimatedDocumentCount(),0)' 2>/dev/null)
`;
    case 'redis':
      return `
docker create --name "$V" --memory=256m --cpus=1 --network none "$IMG" redis-server --requirepass "$P" >/dev/null
docker cp "$F" "$V":/data/dump.rdb
docker start "$V" >/dev/null; RC=$?
for i in $(seq 1 30); do [ "$(docker exec "$V" redis-cli -a "$P" --no-auth-warning ping 2>/dev/null)" = PONG ] && READY=1 && break; sleep 1; done
[ "\${READY:-0}" = 1 ] || fail "container did not become ready"
TABLES=1
ROWS=$(docker exec "$V" redis-cli -a "$P" --no-auth-warning DBSIZE 2>/dev/null | tr -dc '0-9')
`;
  }
}

export function buildVerifyScript(input: VerifyScriptInput): string {
  const body = engineBody(input.type);
  return `CN=${shellEscape(input.containerName)}
F=${shellEscape(input.filePath)}
DB=${shellEscape(input.databaseName)}
U=${shellEscape(input.username)}
P=${shellEscape(input.password)}
V=${shellEscape(input.verifyContainerName)}
fail() { echo "${VERIFY_MARKER} {\\"ok\\":false,\\"error\\":\\"$1\\"}"; exit 0; }
cleanup() { docker rm -f "$V" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker rm -f "$V" >/dev/null 2>&1 || true
[ -f "$F" ] || fail "backup file missing on server"
IMG=$(docker inspect --format '{{.Config.Image}}' "$CN" 2>/dev/null) || fail "source container not found"
[ -n "$IMG" ] || fail "source image unknown"
RC=1
${body.trim()}
TABLES=$(echo "\${TABLES:-0}" | tr -dc '0-9'); TABLES=\${TABLES:-0}
ROWS=$(echo "\${ROWS:-0}" | tr -dc '0-9'); ROWS=\${ROWS:-0}
if [ "$RC" = 0 ] || [ "$TABLES" -gt 0 ]; then
  echo "${VERIFY_MARKER} {\\"ok\\":true,\\"tables\\":$TABLES,\\"rows\\":$ROWS}"
else
  fail "restore command failed and nothing came back"
fi
`;
}

/** Wrap the script for a single ssh.exec — quoted heredoc so nothing expands twice. */
export function wrapForSsh(script: string, timeoutSeconds = VERIFY_TIMEOUT_SECONDS): string {
  return `timeout ${timeoutSeconds} bash -s <<'PUSHIFY_VERIFY_EOF'\n${script}\nPUSHIFY_VERIFY_EOF`;
}

export interface VerifyOutcome {
  ok: boolean;
  tables?: number;
  rows?: number;
  error?: string;
}

/** Find the marker line; anything else on stdout is engine noise. */
export function parseVerifyOutput(stdout: string, exitCode?: number): VerifyOutcome {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(VERIFY_MARKER));
  if (!line) {
    if (exitCode === 124) return { ok: false, error: `timed out after ${VERIFY_TIMEOUT_SECONDS}s` };
    return { ok: false, error: 'no verification result from server' };
  }
  try {
    const parsed = JSON.parse(line.slice(VERIFY_MARKER.length).trim()) as VerifyOutcome;
    return {
      ok: !!parsed.ok,
      tables: Number.isFinite(parsed.tables) ? Number(parsed.tables) : undefined,
      rows: Number.isFinite(parsed.rows) ? Number(parsed.rows) : undefined,
      error: parsed.error,
    };
  } catch {
    return { ok: false, error: 'unreadable verification result' };
  }
}
