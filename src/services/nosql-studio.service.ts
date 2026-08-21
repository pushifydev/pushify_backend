/**
 * Database Studio for MongoDB and Redis.
 *
 * Same shape as the SQL studio — auth and transport here, scripts and parsing in
 * `lib/studio-nosql.ts` — but the data models are different enough to deserve their own API:
 * Mongo browses collections and documents, Redis browses keys and their values.
 */
import { HTTPException } from 'hono/http-exception';
import { t, type SupportedLocale } from '../i18n';
import { StudioValidationError } from '../lib/studio-errors';
import {
  assertJsonObject,
  buildMongoCommand,
  buildRedisCommand,
  decodeRedisKeys,
  decodeRedisValue,
  mongoScripts,
  normalizeJsonObject,
  parseEnvelope,
  parseRedisEnvelope,
  redisScripts,
  toHex,
  MONGO_COUNT_CAP,
  NOSQL_DEFAULT_PAGE_SIZE,
  NOSQL_MAX_PAGE_SIZE,
  REDIS_SCAN_COUNT,
  REDIS_VALUE_PREVIEW_ITEMS,
  type MongoCollection,
  type MongoDocumentsPage,
  type RedisKeySummary,
  type RedisKeyValue,
} from '../lib/studio-nosql';
import { activityService } from './activity.service';
import {
  execOnServer,
  openStudioSession,
  withStudioSession,
  type StudioAccessLevel,
  type StudioSessionBase,
} from './studio-session.service';

export type { MongoCollection, RedisKeySummary, RedisKeyValue };

// ============ Inputs ============

export interface MongoDocumentsInput {
  collection: string;
  filter?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface MongoInsertInput {
  collection: string;
  document: string;
}

export interface MongoReplaceInput {
  collection: string;
  /** the document's `_id`, as extended JSON */
  id: string;
  document: string;
}

export interface MongoDeleteInput {
  collection: string;
  /** the `_id` values to remove, as an extended-JSON array */
  ids: string;
}

export interface RedisScanInput {
  cursor?: string;
  pattern?: string;
  count?: number;
}

export interface RedisKeyInput {
  key: string;
}

export interface RedisExpireInput extends RedisKeyInput {
  /** seconds, or null to clear the expiry */
  seconds: number | null;
}

export interface RedisSetStringInput extends RedisKeyInput {
  value: string;
}

// ============ Helpers ============

const MAX_KEYS_PER_REQUEST = 200;

/** Collection names are data in the scripts, but a control character has no business here. */
function assertName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    throw new StudioValidationError('studioInvalidIdentifier');
  }
   
  if (/[\u0000-\u001f]/.test(name)) {
    throw new StudioValidationError('studioInvalidIdentifier');
  }
  return name;
}

async function runMongo<T>(
  session: StudioSessionBase,
  script: string,
  locale: SupportedLocale
): Promise<T> {
  const result = await execOnServer(session, buildMongoCommand({ ...session, script }));
  const envelope = parseEnvelope<T>(result.stdout);

  if (!envelope.ok) {
    throw new HTTPException(400, {
      message: envelope.error || t(locale, 'databases', 'studioQueryFailed'),
    });
  }

  return envelope.data as T;
}

async function runRedis<T>(
  session: StudioSessionBase,
  script: string,
  args: string[],
  locale: SupportedLocale
): Promise<T> {
  const result = await execOnServer(
    session,
    buildRedisCommand({ ...session, script, args })
  );
  const envelope = parseRedisEnvelope<T>(result.stdout, result.stderr);

  if (!envelope.ok) {
    throw new HTTPException(400, {
      message: envelope.error || t(locale, 'databases', 'studioQueryFailed'),
    });
  }

  return envelope.data as T;
}

async function logChange(
  session: StudioSessionBase,
  organizationId: string,
  userId: string,
  action: 'database.data_modified' | 'database.schema_changed',
  description: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await activityService.log({
    organizationId,
    userId,
    action,
    description: `${description} in database "${session.databaseLabel}"`,
    metadata: { databaseId: session.databaseId, engine: session.type, ...metadata },
  });
}

function openMongo(
  databaseId: string,
  organizationId: string,
  userId: string,
  locale: SupportedLocale,
  required: StudioAccessLevel
) {
  return () => openStudioSession(databaseId, organizationId, userId, ['mongodb'], locale, required);
}

function openRedis(
  databaseId: string,
  organizationId: string,
  userId: string,
  locale: SupportedLocale,
  required: StudioAccessLevel
) {
  return () => openStudioSession(databaseId, organizationId, userId, ['redis'], locale, required);
}

// ============ Service ============

export const nosqlStudioService = {
  isMongo(type: string): boolean {
    return type === 'mongodb';
  },

  isRedis(type: string): boolean {
    return type === 'redis';
  },

  // ============ MongoDB ============

  async listCollections(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ): Promise<MongoCollection[]> {
    return withStudioSession(openMongo(databaseId, organizationId, userId, locale, 'read'), locale, async (session) => {
      const collections = await runMongo<MongoCollection[]>(
        session,
        mongoScripts.collections(),
        locale
      );

      return collections
        .map((collection) => ({
          name: collection.name,
          type: collection.type ?? 'collection',
          count: Number(collection.count ?? 0),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  },

  async getDocuments(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: MongoDocumentsInput,
    locale: SupportedLocale
  ): Promise<MongoDocumentsPage & { page: number; pageSize: number }> {
    return withStudioSession(openMongo(databaseId, organizationId, userId, locale, 'read'), locale, async (session) => {
      const collection = assertName(input.collection);
      const page = Math.max(1, Math.floor(Number(input.page) || 1));
      const pageSize = Math.min(
        NOSQL_MAX_PAGE_SIZE,
        Math.max(1, Math.floor(Number(input.pageSize) || NOSQL_DEFAULT_PAGE_SIZE))
      );

      const result = await runMongo<MongoDocumentsPage>(
        session,
        mongoScripts.documents({
          collection,
          filter: normalizeJsonObject(input.filter),
          sort: normalizeJsonObject(input.sort),
          limit: pageSize,
          skip: (page - 1) * pageSize,
        }),
        locale
      );

      return {
        documents: Array.isArray(result.documents) ? result.documents : [],
        total: Math.min(Number(result.total ?? 0), MONGO_COUNT_CAP),
        totalCapped: Boolean(result.totalCapped),
        page,
        pageSize,
      };
    });
  },

  async insertDocument(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: MongoInsertInput,
    locale: SupportedLocale
  ): Promise<{ insertedId: unknown }> {
    return withStudioSession(openMongo(databaseId, organizationId, userId, locale, 'write'), locale, async (session) => {
      const collection = assertName(input.collection);
      const document = assertJsonObject(input.document);

      const result = await runMongo<{ insertedId: unknown }>(
        session,
        mongoScripts.insertDocument(collection, document),
        locale
      );

      await logChange(session, organizationId, userId, 'database.data_modified', `insert into ${collection}`, {
        collection,
        operation: 'insert',
      });
      return result;
    });
  },

  async replaceDocument(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: MongoReplaceInput,
    locale: SupportedLocale
  ): Promise<{ matched: number; modified: number }> {
    return withStudioSession(openMongo(databaseId, organizationId, userId, locale, 'write'), locale, async (session) => {
      const collection = assertName(input.collection);
      const document = assertJsonObject(input.document);

      if (typeof input.id !== 'string' || input.id.trim().length === 0) {
        throw new StudioValidationError('studioPrimaryKeyRequired');
      }

      const result = await runMongo<{ matched: number; modified: number }>(
        session,
        mongoScripts.replaceDocument(collection, input.id, document),
        locale
      );

      await logChange(session, organizationId, userId, 'database.data_modified', `update in ${collection}`, {
        collection,
        operation: 'update',
        matched: result.matched,
      });
      return result;
    });
  },

  async deleteDocuments(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: MongoDeleteInput,
    locale: SupportedLocale
  ): Promise<{ deleted: number }> {
    return withStudioSession(openMongo(databaseId, organizationId, userId, locale, 'write'), locale, async (session) => {
      const collection = assertName(input.collection);

      if (typeof input.ids !== 'string' || input.ids.trim().length === 0) {
        throw new StudioValidationError('studioPrimaryKeyRequired');
      }

      const result = await runMongo<{ deleted: number }>(
        session,
        mongoScripts.deleteDocuments(collection, input.ids),
        locale
      );

      await logChange(session, organizationId, userId, 'database.data_modified', `delete from ${collection}`, {
        collection,
        operation: 'delete',
        deleted: result.deleted,
      });
      return result;
    });
  },

  async createCollection(
    databaseId: string,
    organizationId: string,
    userId: string,
    name: string,
    locale: SupportedLocale
  ): Promise<{ created: true }> {
    return withStudioSession(openMongo(databaseId, organizationId, userId, locale, 'write'), locale, async (session) => {
      const collection = assertName(name);
      const result = await runMongo<{ created: true }>(
        session,
        mongoScripts.createCollection(collection),
        locale
      );

      await logChange(session, organizationId, userId, 'database.schema_changed', `create collection ${collection}`, {
        collection,
        operation: 'create_collection',
      });
      return result;
    });
  },

  async dropCollection(
    databaseId: string,
    organizationId: string,
    userId: string,
    name: string,
    locale: SupportedLocale
  ): Promise<{ dropped: true }> {
    return withStudioSession(openMongo(databaseId, organizationId, userId, locale, 'write'), locale, async (session) => {
      const collection = assertName(name);
      const result = await runMongo<{ dropped: true }>(
        session,
        mongoScripts.dropCollection(collection),
        locale
      );

      await logChange(session, organizationId, userId, 'database.schema_changed', `drop collection ${collection}`, {
        collection,
        operation: 'drop_collection',
      });
      return result;
    });
  },

  // ============ Redis ============

  async scanKeys(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: RedisScanInput,
    locale: SupportedLocale
  ): Promise<{ cursor: string; keys: RedisKeySummary[]; keyCount: number }> {
    return withStudioSession(openRedis(databaseId, organizationId, userId, locale, 'read'), locale, async (session) => {
      const cursor = /^\d+$/.test(String(input.cursor ?? '0')) ? String(input.cursor ?? '0') : '0';
      const count = Math.min(
        NOSQL_MAX_PAGE_SIZE * 4,
        Math.max(10, Math.floor(Number(input.count) || REDIS_SCAN_COUNT))
      );

      const page = await runRedis<{ cursor: string; keys: unknown }>(
        session,
        redisScripts.scan(),
        [cursor, toHex(String(input.pattern ?? '*')), toHex(String(count))],
        locale
      );

      const overview = await runRedis<{ keyCount: number }>(
        session,
        redisScripts.overview(),
        [],
        locale
      );

      return {
        cursor: String(page.cursor ?? '0'),
        keys: decodeRedisKeys(page.keys),
        keyCount: Number(overview.keyCount ?? 0),
      };
    });
  },

  async getKey(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: RedisKeyInput,
    locale: SupportedLocale
  ): Promise<RedisKeyValue & { name: string }> {
    return withStudioSession(openRedis(databaseId, organizationId, userId, locale, 'read'), locale, async (session) => {
      const key = assertName(input.key);
      const value = await runRedis<unknown>(
        session,
        redisScripts.value(),
        [toHex(key), toHex(String(REDIS_VALUE_PREVIEW_ITEMS))],
        locale
      );

      return { name: key, ...decodeRedisValue(value) };
    });
  },

  async deleteKeys(
    databaseId: string,
    organizationId: string,
    userId: string,
    keys: string[],
    locale: SupportedLocale
  ): Promise<{ deleted: number }> {
    return withStudioSession(openRedis(databaseId, organizationId, userId, locale, 'write'), locale, async (session) => {
      const names = Array.isArray(keys) ? keys.map(assertName) : [];
      if (names.length === 0) throw new StudioValidationError('studioInvalidIdentifier');
      if (names.length > MAX_KEYS_PER_REQUEST) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'studioTooManyRows') });
      }

      const result = await runRedis<{ deleted: number }>(
        session,
        redisScripts.del(),
        names.map(toHex),
        locale
      );

      await logChange(session, organizationId, userId, 'database.data_modified', `delete ${names.length} key(s)`, {
        operation: 'delete',
        deleted: result.deleted,
      });
      return { deleted: Number(result.deleted ?? 0) };
    });
  },

  async setExpiry(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: RedisExpireInput,
    locale: SupportedLocale
  ): Promise<{ applied: boolean; ttl: number }> {
    return withStudioSession(openRedis(databaseId, organizationId, userId, locale, 'write'), locale, async (session) => {
      const key = assertName(input.key);
      const seconds =
        input.seconds === null || input.seconds === undefined ? -1 : Math.floor(Number(input.seconds));

      if (!Number.isFinite(seconds)) throw new StudioValidationError('studioInvalidValue');

      const result = await runRedis<{ applied: boolean; ttl: number }>(
        session,
        redisScripts.expire(),
        [toHex(key), toHex(String(seconds))],
        locale
      );

      await logChange(session, organizationId, userId, 'database.data_modified', `set ttl on ${key}`, {
        operation: 'expire',
        key,
        seconds,
      });
      return { applied: Boolean(result.applied), ttl: Number(result.ttl ?? -1) };
    });
  },

  async setStringValue(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: RedisSetStringInput,
    locale: SupportedLocale
  ): Promise<{ ttl: number }> {
    return withStudioSession(openRedis(databaseId, organizationId, userId, locale, 'write'), locale, async (session) => {
      const key = assertName(input.key);
      if (typeof input.value !== 'string') throw new StudioValidationError('studioInvalidValue');

      const result = await runRedis<{ ttl: number }>(
        session,
        redisScripts.setString(),
        [toHex(key), toHex(input.value)],
        locale
      );

      await logChange(session, organizationId, userId, 'database.data_modified', `set ${key}`, {
        operation: 'set',
        key,
      });
      return { ttl: Number(result.ttl ?? -1) };
    });
  },
};
