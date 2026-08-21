/**
 * The studio's MongoDB and Redis engine layer — the scripts it sends, the command that carries
 * them, and the parsing of what comes back. Pure, like `studio-sql.ts`, so it can be exercised
 * against real containers.
 *
 * Neither client offers bind parameters either, so each engine gets its own injection defence:
 *
 *   MongoDB — the script is JavaScript, and every piece of user input enters it as a JSON string
 *   literal produced by `JSON.stringify`, then parsed inside mongosh with `EJSON.parse`. User
 *   input is therefore never code; it is data the script parses.
 *
 *   Redis — the script is a fixed Lua program with no interpolation at all. Every user value is
 *   hex-encoded into ARGV and decoded inside Lua, so the bytes that reach the shell and the
 *   redis-cli line are always `[0-9a-f]*`. Binary-safe in both directions.
 */
import { shellQuote } from './sql-escape';
import { StudioValidationError } from './studio-errors';

// ============ Limits ============

export const NOSQL_DEFAULT_PAGE_SIZE = 25;
export const NOSQL_MAX_PAGE_SIZE = 100;
export const MONGO_COUNT_CAP = 10_000;
export const REDIS_SCAN_COUNT = 200;
export const REDIS_VALUE_PREVIEW_ITEMS = 100;
export const NOSQL_MAX_OUTPUT_BYTES = 8_000_000;
export const NOSQL_COMMAND_TIMEOUT_SECONDS = 30;
export const MAX_DOCUMENT_BYTES = 1_000_000;

// ============ Shared ============

export interface NoSqlCommandOptions {
  containerName: string;
  username: string;
  databaseName: string;
  password: string;
  script: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
}

function pipeline(command: string, options: NoSqlCommandOptions): string {
  const payload = Buffer.from(options.script, 'utf8').toString('base64');
  const timeout = options.timeoutSeconds ?? NOSQL_COMMAND_TIMEOUT_SECONDS;
  const maxBytes = options.maxOutputBytes ?? NOSQL_MAX_OUTPUT_BYTES;
  const guarded = timeout > 0 ? `timeout ${timeout} ${command}` : command;

  return `printf '%s' ${shellQuote(payload)} | base64 -d | ${guarded} | head -c ${maxBytes}`;
}

/** Embed a value as a JSON string literal — the only way user input enters a mongo script. */
function jsLiteral(value: unknown): string {
  return JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value ?? null));
}

export function toHex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

export function fromHex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]*$/i.test(value)) return '';
  return Buffer.from(value, 'hex').toString('utf8');
}

/** Every engine script answers with this envelope, so a failure is never mistaken for data. */
export interface NoSqlEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function parseEnvelope<T>(stdout: string): NoSqlEnvelope<T> {
  const text = stdout.trim();
  if (!text) return { ok: false, error: 'empty response' };

  const asEnvelope = (candidate: string): NoSqlEnvelope<T> | null => {
    try {
      const parsed = JSON.parse(candidate) as NoSqlEnvelope<T>;
      return typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean'
        ? parsed
        : null;
    } catch {
      return null;
    }
  };

  // The whole output is normally the envelope. Only when a client prepends chatter do we fall
  // back to the last line — never to a substring search, because the payload itself may contain
  // an `ok` field and slicing on that produces invalid JSON.
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const candidates = [text, lines[lines.length - 1] ?? ''];

  for (const candidate of candidates) {
    const parsed = asEnvelope(candidate.trim());
    if (parsed) return parsed;
  }

  return { ok: false, error: text.slice(0, 2000) };
}

// ============ MongoDB ============

export interface MongoCollection {
  name: string;
  type: string;
  count: number;
}

export interface MongoDocumentsPage {
  total: number;
  totalCapped: boolean;
  documents: Record<string, unknown>[];
}

export function buildMongoCommand(options: NoSqlCommandOptions): string {
  const client = [
    'docker exec -i',
    shellQuote(options.containerName),
    // `--file /dev/stdin` runs the script and exits; without it mongosh opens a REPL and
    // decorates the output with a prompt.
    'mongosh --quiet --norc --file /dev/stdin',
    `--username ${shellQuote(options.username)}`,
    `--password ${shellQuote(options.password)}`,
    '--authenticationDatabase admin',
    shellQuote(options.databaseName),
  ].join(' ');

  return pipeline(client, options);
}

/** Wrap a body so both success and failure come back as the same envelope. */
function mongoScript(body: string): string {
  return `try {
  const __data = (() => { ${body} })();
  print(JSON.stringify({ ok: true, data: JSON.parse(EJSON.stringify(__data)) }));
} catch (error) {
  print(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
}`;
}

export const mongoScripts = {
  collections(): string {
    return mongoScript(`
    const infos = db.getCollectionInfos();
    return infos.map((info) => ({
      name: info.name,
      type: info.type || 'collection',
      count: info.type === 'view' ? 0 : db.getCollection(info.name).estimatedDocumentCount(),
    }));`);
  },

  documents(options: {
    collection: string;
    filter: string;
    sort: string;
    limit: number;
    skip: number;
  }): string {
    return mongoScript(`
    const collection = db.getCollection(${jsLiteral(options.collection)});
    const filter = EJSON.parse(${jsLiteral(options.filter || '{}')});
    const sort = EJSON.parse(${jsLiteral(options.sort || '{}')});
    const documents = collection.find(filter).sort(sort).skip(${options.skip}).limit(${options.limit}).toArray();
    const total = collection.countDocuments(filter, { limit: ${MONGO_COUNT_CAP + 1} });
    return { total, totalCapped: total > ${MONGO_COUNT_CAP}, documents };`);
  },

  insertDocument(collection: string, document: string): string {
    return mongoScript(`
    const result = db.getCollection(${jsLiteral(collection)}).insertOne(EJSON.parse(${jsLiteral(document)}));
    return { insertedId: result.insertedId };`);
  },

  replaceDocument(collection: string, id: string, document: string): string {
    return mongoScript(`
    const replacement = EJSON.parse(${jsLiteral(document)});
    delete replacement._id;
    const result = db.getCollection(${jsLiteral(collection)}).replaceOne(
      { _id: EJSON.parse(${jsLiteral(id)}) },
      replacement
    );
    return { matched: result.matchedCount, modified: result.modifiedCount };`);
  },

  deleteDocuments(collection: string, ids: string): string {
    return mongoScript(`
    const identifiers = EJSON.parse(${jsLiteral(ids)});
    const result = db.getCollection(${jsLiteral(collection)}).deleteMany({ _id: { $in: identifiers } });
    return { deleted: result.deletedCount };`);
  },

  createCollection(name: string): string {
    return mongoScript(`
    db.createCollection(${jsLiteral(name)});
    return { created: true };`);
  },

  dropCollection(name: string): string {
    return mongoScript(`
    db.getCollection(${jsLiteral(name)}).drop();
    return { dropped: true };`);
  },
};

/** A document must be a JSON object before it is allowed anywhere near the engine. */
export function assertJsonObject(raw: unknown, key: 'studioInvalidValue' = 'studioInvalidValue'): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new StudioValidationError(key);
  if (raw.length > MAX_DOCUMENT_BYTES) throw new StudioValidationError(key);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StudioValidationError(key);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StudioValidationError(key);
  }

  return JSON.stringify(parsed);
}

/** Filters and sorts may be empty, but must be JSON objects when present. */
export function normalizeJsonObject(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '{}';
  return assertJsonObject(raw, 'studioInvalidValue');
}

// ============ Redis ============

export type RedisKeyType = 'string' | 'list' | 'set' | 'zset' | 'hash' | 'stream' | 'none';

export interface RedisKeySummary {
  name: string;
  type: RedisKeyType;
  ttl: number;
}

export interface RedisScanPage {
  cursor: string;
  keys: RedisKeySummary[];
}

export interface RedisKeyValue {
  type: RedisKeyType;
  ttl: number;
  size: number;
  truncated: boolean;
  value?: string;
  items?: string[];
  entries?: { field: string; value: string }[];
}

export function buildRedisCommand(
  options: NoSqlCommandOptions & { args: string[] }
): string {
  const client = [
    'docker exec -i',
    `-e REDISCLI_AUTH=${shellQuote(options.password)}`,
    shellQuote(options.containerName),
    'redis-cli --eval /dev/stdin ,',
    // Every argument is hex, so there is nothing here the shell could interpret.
    ...options.args.map((arg) => shellQuote(arg)),
  ].join(' ');

  return pipeline(client, options);
}

/** Shared Lua preamble: hex in, hex out, so binary keys and values survive the round trip. */
const REDIS_HELPERS = `
local function unhex(s)
  if s == nil or s == '' then return '' end
  return (s:gsub('%x%x', function(cc) return string.char(tonumber(cc, 16)) end))
end
local function hex(s)
  if s == nil then return '' end
  return (s:gsub('.', function(c) return string.format('%02x', string.byte(c)) end))
end
local function envelope(data)
  return cjson.encode({ ok = true, data = data })
end
`;

export const redisScripts = {
  /** One SCAN page, with each key's type and TTL. */
  scan(): string {
    return `${REDIS_HELPERS}
local cursor = ARGV[1]
local pattern = unhex(ARGV[2])
if pattern == '' then pattern = '*' end
local count = tonumber(unhex(ARGV[3])) or ${REDIS_SCAN_COUNT}

local reply = redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', count)
local keys = {}
for i, name in ipairs(reply[2]) do
  keys[i] = {
    name = hex(name),
    type = redis.call('TYPE', name)['ok'],
    ttl = redis.call('TTL', name),
  }
end

local data = { cursor = reply[1], keys = keys }
if #keys == 0 then data.keys = {} end
return envelope(data)`;
  },

  /** One key's value, previewed to a bounded number of items. */
  value(): string {
    return `${REDIS_HELPERS}
local key = unhex(ARGV[1])
local limit = tonumber(unhex(ARGV[2])) or ${REDIS_VALUE_PREVIEW_ITEMS}
local kind = redis.call('TYPE', key)['ok']
local data = { type = kind, ttl = redis.call('TTL', key), size = 0, truncated = false }

if kind == 'string' then
  local value = redis.call('GET', key)
  data.size = string.len(value or '')
  data.value = hex(value)
elseif kind == 'list' then
  data.size = redis.call('LLEN', key)
  local items = redis.call('LRANGE', key, 0, limit - 1)
  local out = {}
  for i, item in ipairs(items) do out[i] = hex(item) end
  data.items = out
  data.truncated = data.size > limit
elseif kind == 'set' then
  data.size = redis.call('SCARD', key)
  local reply = redis.call('SSCAN', key, 0, 'COUNT', limit)
  local out = {}
  for i, item in ipairs(reply[2]) do out[i] = hex(item) end
  data.items = out
  data.truncated = data.size > #out
elseif kind == 'zset' then
  data.size = redis.call('ZCARD', key)
  local reply = redis.call('ZRANGE', key, 0, limit - 1, 'WITHSCORES')
  local entries = {}
  local index = 1
  while index < #reply do
    entries[#entries + 1] = { field = hex(reply[index]), value = hex(reply[index + 1]) }
    index = index + 2
  end
  data.entries = entries
  data.truncated = data.size > #entries
elseif kind == 'hash' then
  data.size = redis.call('HLEN', key)
  local reply = redis.call('HSCAN', key, 0, 'COUNT', limit)
  local entries = {}
  local index = 1
  while index < #reply[2] do
    entries[#entries + 1] = { field = hex(reply[2][index]), value = hex(reply[2][index + 1]) }
    index = index + 2
  end
  data.entries = entries
  data.truncated = data.size > #entries
end

if data.items == nil then data.items = {} end
if data.entries == nil then data.entries = {} end
return envelope(data)`;
  },

  del(): string {
    return `${REDIS_HELPERS}
local deleted = 0
for i = 1, #ARGV do
  deleted = deleted + redis.call('DEL', unhex(ARGV[i]))
end
return envelope({ deleted = deleted })`;
  },

  expire(): string {
    return `${REDIS_HELPERS}
local key = unhex(ARGV[1])
local seconds = tonumber(unhex(ARGV[2]))
local applied
if seconds == nil or seconds < 0 then
  applied = redis.call('PERSIST', key)
else
  applied = redis.call('EXPIRE', key, seconds)
end
return envelope({ applied = applied == 1, ttl = redis.call('TTL', key) })`;
  },

  setString(): string {
    return `${REDIS_HELPERS}
local key = unhex(ARGV[1])
local value = unhex(ARGV[2])
redis.call('SET', key, value)
return envelope({ applied = true, ttl = redis.call('TTL', key) })`;
  },

  overview(): string {
    return `${REDIS_HELPERS}
return envelope({ keyCount = redis.call('DBSIZE') })`;
  },
};

/** redis-cli prints Lua errors on stdout; treat anything that is not our envelope as failure. */
export function parseRedisEnvelope<T>(stdout: string, stderr: string): NoSqlEnvelope<T> {
  const text = stdout.trim();
  if (!text) {
    return { ok: false, error: stderr.trim().slice(0, 2000) || 'empty response' };
  }
  if (!text.startsWith('{')) {
    return { ok: false, error: text.slice(0, 2000) };
  }
  return parseEnvelope<T>(text);
}

export function decodeRedisKeys(raw: unknown): RedisKeySummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const key = entry as { name?: string; type?: string; ttl?: number };
    return {
      name: fromHex(key.name),
      type: (key.type ?? 'none') as RedisKeyType,
      ttl: Number(key.ttl ?? -1),
    };
  });
}

export function decodeRedisValue(raw: unknown): RedisKeyValue {
  const value = (raw ?? {}) as {
    type?: string;
    ttl?: number;
    size?: number;
    truncated?: boolean;
    value?: string;
    items?: unknown;
    entries?: unknown;
  };

  const items = Array.isArray(value.items) ? value.items.map((item) => fromHex(item)) : [];
  const entries = Array.isArray(value.entries)
    ? (value.entries as { field?: string; value?: string }[]).map((entry) => ({
        field: fromHex(entry.field),
        value: fromHex(entry.value),
      }))
    : [];

  return {
    type: (value.type ?? 'none') as RedisKeyType,
    ttl: Number(value.ttl ?? -1),
    size: Number(value.size ?? 0),
    truncated: Boolean(value.truncated),
    value: value.value === undefined ? undefined : fromHex(value.value),
    items,
    entries,
  };
}
