/**
 * NoSQL studio integration tests — the generated scripts run against real MongoDB and Redis.
 *
 * Same contract as the SQL suite: only the SSH hop is replaced. These cover the two things unit
 * tests cannot — whether mongosh and redis-cli accept what we build, and whether user input that
 * looks like code stays data.
 *
 * Opt-in:
 *   PUSHIFY_STUDIO_IT=1 npx vitest run src/lib/studio-nosql.integration.test.ts
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMongoCommand,
  buildRedisCommand,
  decodeRedisKeys,
  decodeRedisValue,
  mongoScripts,
  parseEnvelope,
  parseRedisEnvelope,
  redisScripts,
  toHex,
  type MongoCollection,
  type MongoDocumentsPage,
} from './studio-nosql';

const execAsync = promisify(exec);
const ENABLED = process.env.PUSHIFY_STUDIO_IT === '1';

const MONGO = {
  container: 'pushify-studio-it-mongo',
  image: 'mongo:7',
  username: 'studio_user',
  password: 'studio_pass',
  databaseName: 'studio_db',
};

const REDIS = {
  container: 'pushify-studio-it-redis',
  image: 'redis:7-alpine',
  username: '',
  password: 'studio_pass',
  databaseName: '0',
};

async function sh(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(error), code: e.code ?? 1 };
  }
}

async function waitFor(command: string, label: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const ready = await sh(command);
    if (ready.code === 0) return;
    if (Date.now() > deadline) throw new Error(`${label} never became ready`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function runMongo<T>(script: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const command = buildMongoCommand({
    containerName: MONGO.container,
    username: MONGO.username,
    password: MONGO.password,
    databaseName: MONGO.databaseName,
    script,
    // macOS has no coreutils `timeout`; the wrapper itself is covered by the unit suite.
    timeoutSeconds: 0,
  });

  const result = await sh(command);
  return parseEnvelope<T>(result.stdout);
}

async function runRedis<T>(
  script: string,
  args: string[]
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const command = buildRedisCommand({
    containerName: REDIS.container,
    username: REDIS.username,
    password: REDIS.password,
    databaseName: REDIS.databaseName,
    script,
    args,
    timeoutSeconds: 0,
  });

  const result = await sh(command);
  return parseRedisEnvelope<T>(result.stdout, result.stderr);
}

describe.runIf(ENABLED)('nosql studio against real databases', () => {
  beforeAll(async () => {
    await sh(`docker rm -f ${MONGO.container} ${REDIS.container}`);

    await sh(
      `docker run -d --name ${MONGO.container} -e MONGO_INITDB_ROOT_USERNAME=${MONGO.username} -e MONGO_INITDB_ROOT_PASSWORD=${MONGO.password} -e MONGO_INITDB_DATABASE=${MONGO.databaseName} ${MONGO.image}`
    );
    await sh(
      `docker run -d --name ${REDIS.container} ${REDIS.image} redis-server --requirepass ${REDIS.password}`
    );

    await waitFor(
      `docker exec ${MONGO.container} mongosh --quiet --username ${MONGO.username} --password ${MONGO.password} --authenticationDatabase admin --eval "db.adminCommand('ping')"`,
      MONGO.image
    );
    await waitFor(
      `docker exec -e REDISCLI_AUTH=${REDIS.password} ${REDIS.container} redis-cli PING`,
      REDIS.image
    );

    // Readiness means "answers a script sent the way the studio sends one".
    const deadline = Date.now() + 120_000;
    for (;;) {
      const probe = await runMongo<unknown>(mongoScripts.collections());
      if (probe.ok) break;
      if (Date.now() > deadline) throw new Error(`${MONGO.image} never accepted a script`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }, 400_000);

  afterAll(async () => {
    await sh(`docker rm -f ${MONGO.container} ${REDIS.container}`);
  }, 60_000);

  describe('mongodb', () => {
    it('creates a collection and lists it', async () => {
      expect((await runMongo(mongoScripts.createCollection('posts'))).ok).toBe(true);

      const collections = await runMongo<MongoCollection[]>(mongoScripts.collections());
      expect(collections.ok).toBe(true);
      expect(collections.data!.map((c) => c.name)).toContain('posts');
    }, 60_000);

    it('inserts, reads back and counts documents', async () => {
      for (const title of ['first', 'second', 'third']) {
        const inserted = await runMongo<{ insertedId: unknown }>(
          mongoScripts.insertDocument('posts', JSON.stringify({ title, views: 1 }))
        );
        expect(inserted.ok).toBe(true);
      }

      const page = await runMongo<MongoDocumentsPage>(
        mongoScripts.documents({
          collection: 'posts',
          filter: '{}',
          sort: '{"title":1}',
          limit: 2,
          skip: 0,
        })
      );

      expect(page.ok).toBe(true);
      expect(page.data!.total).toBe(3);
      expect(page.data!.documents).toHaveLength(2);
      expect(page.data!.documents[0].title).toBe('first');
      // _id comes back as extended JSON, which is what the editor round-trips.
      expect(page.data!.documents[0]._id).toHaveProperty('$oid');
    }, 60_000);

    it('filters with the user-supplied query document', async () => {
      const page = await runMongo<MongoDocumentsPage>(
        mongoScripts.documents({
          collection: 'posts',
          filter: '{"title":"second"}',
          sort: '{}',
          limit: 10,
          skip: 0,
        })
      );

      expect(page.data!.total).toBe(1);
      expect(page.data!.documents[0].title).toBe('second');
    }, 60_000);

    it('treats javascript-looking input as data, not code', async () => {
      const hostile = 'a"); db.posts.drop(); print("';
      const inserted = await runMongo<{ insertedId: unknown }>(
        mongoScripts.insertDocument('posts', JSON.stringify({ title: hostile }))
      );
      expect(inserted.ok).toBe(true);

      const page = await runMongo<MongoDocumentsPage>(
        mongoScripts.documents({
          collection: 'posts',
          filter: JSON.stringify({ title: hostile }),
          sort: '{}',
          limit: 10,
          skip: 0,
        })
      );

      // The collection still exists and the value round-tripped verbatim.
      expect(page.ok).toBe(true);
      expect(page.data!.documents[0].title).toBe(hostile);
    }, 60_000);

    it('round-trips values that break naive escaping', async () => {
      const hostile = {
        quotes: `O'Brien "quoted"`,
        backslash: 'back\\slash',
        newline: 'line1\nline2',
        unicode: 'ıçğüşö 日本語 🎉',
      };

      await runMongo(mongoScripts.insertDocument('posts', JSON.stringify({ ...hostile, tag: 'hostile' })));

      const page = await runMongo<MongoDocumentsPage>(
        mongoScripts.documents({
          collection: 'posts',
          filter: '{"tag":"hostile"}',
          sort: '{}',
          limit: 1,
          skip: 0,
        })
      );

      expect(page.data!.documents[0]).toMatchObject(hostile);
    }, 60_000);

    it('replaces and deletes a document by its id', async () => {
      const page = await runMongo<MongoDocumentsPage>(
        mongoScripts.documents({
          collection: 'posts',
          filter: '{"title":"third"}',
          sort: '{}',
          limit: 1,
          skip: 0,
        })
      );
      const id = JSON.stringify(page.data!.documents[0]._id);

      const replaced = await runMongo<{ matched: number; modified: number }>(
        mongoScripts.replaceDocument('posts', id, JSON.stringify({ title: 'third', views: 99 }))
      );
      expect(replaced.data).toEqual({ matched: 1, modified: 1 });

      const deleted = await runMongo<{ deleted: number }>(
        mongoScripts.deleteDocuments('posts', `[${id}]`)
      );
      expect(deleted.data!.deleted).toBe(1);
    }, 60_000);

    it('reports a failure as an envelope instead of throwing', async () => {
      const result = await runMongo(
        mongoScripts.documents({
          collection: 'posts',
          filter: '{"$nope": 1}',
          sort: '{}',
          limit: 1,
          skip: 0,
        })
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }, 60_000);

    it('drops a collection', async () => {
      expect((await runMongo(mongoScripts.dropCollection('posts'))).ok).toBe(true);

      const collections = await runMongo<MongoCollection[]>(mongoScripts.collections());
      expect(collections.data!.map((c) => c.name)).not.toContain('posts');
    }, 60_000);
  });

  describe('redis', () => {
    it('scans keys with their type and ttl', async () => {
      await sh(
        `docker exec -e REDISCLI_AUTH=${REDIS.password} ${REDIS.container} redis-cli MSET user:1 alice user:2 bob`
      );
      await sh(
        `docker exec -e REDISCLI_AUTH=${REDIS.password} ${REDIS.container} redis-cli RPUSH queue a b c`
      );
      await sh(
        `docker exec -e REDISCLI_AUTH=${REDIS.password} ${REDIS.container} redis-cli HSET profile name alice age 30`
      );

      const page = await runRedis<{ cursor: string; keys: unknown }>(redisScripts.scan(), [
        '0',
        toHex('*'),
        toHex('100'),
      ]);

      expect(page.ok).toBe(true);
      const keys = decodeRedisKeys(page.data!.keys);
      const byName = new Map(keys.map((key) => [key.name, key]));

      expect(byName.get('user:1')?.type).toBe('string');
      expect(byName.get('queue')?.type).toBe('list');
      expect(byName.get('profile')?.type).toBe('hash');
      expect(byName.get('user:1')?.ttl).toBe(-1);
    });

    it('honours the scan pattern', async () => {
      const page = await runRedis<{ cursor: string; keys: unknown }>(redisScripts.scan(), [
        '0',
        toHex('user:*'),
        toHex('100'),
      ]);

      const names = decodeRedisKeys(page.data!.keys).map((key) => key.name);
      expect(names.sort()).toEqual(['user:1', 'user:2']);
    });

    it('reads each value type', async () => {
      const string = decodeRedisValue(
        (await runRedis(redisScripts.value(), [toHex('user:1'), toHex('100')])).data
      );
      expect(string.type).toBe('string');
      expect(string.value).toBe('alice');

      const list = decodeRedisValue(
        (await runRedis(redisScripts.value(), [toHex('queue'), toHex('100')])).data
      );
      expect(list.type).toBe('list');
      expect(list.items).toEqual(['a', 'b', 'c']);
      expect(list.size).toBe(3);

      const hash = decodeRedisValue(
        (await runRedis(redisScripts.value(), [toHex('profile'), toHex('100')])).data
      );
      expect(hash.type).toBe('hash');
      expect(hash.entries?.find((entry) => entry.field === 'name')?.value).toBe('alice');
    });

    it('keeps keys and values binary-safe through the hex round trip', async () => {
      const key = 'weird key: "quoted" \\ and ıçğüşö 🎉';
      const value = 'line1\nline2 with \'quotes\' and \\backslash';

      expect((await runRedis(redisScripts.setString(), [toHex(key), toHex(value)])).ok).toBe(true);

      const read = decodeRedisValue(
        (await runRedis(redisScripts.value(), [toHex(key), toHex('100')])).data
      );
      expect(read.value).toBe(value);

      const page = await runRedis<{ keys: unknown }>(redisScripts.scan(), [
        '0',
        toHex('weird*'),
        toHex('100'),
      ]);
      expect(decodeRedisKeys(page.data!.keys).map((k) => k.name)).toContain(key);

      expect(
        (await runRedis<{ deleted: number }>(redisScripts.del(), [toHex(key)])).data!.deleted
      ).toBe(1);
    });

    it('sets and clears an expiry', async () => {
      const applied = await runRedis<{ applied: boolean; ttl: number }>(redisScripts.expire(), [
        toHex('user:1'),
        toHex('120'),
      ]);
      expect(applied.data!.applied).toBe(true);
      expect(applied.data!.ttl).toBeGreaterThan(0);

      const cleared = await runRedis<{ applied: boolean; ttl: number }>(redisScripts.expire(), [
        toHex('user:1'),
        toHex('-1'),
      ]);
      expect(cleared.data!.ttl).toBe(-1);
    });

    it('deletes keys and reports the count', async () => {
      const deleted = await runRedis<{ deleted: number }>(redisScripts.del(), [
        toHex('user:1'),
        toHex('user:2'),
        toHex('missing-key'),
      ]);
      expect(deleted.data!.deleted).toBe(2);
    });

    it('reports the database size', async () => {
      const overview = await runRedis<{ keyCount: number }>(redisScripts.overview(), []);
      expect(overview.ok).toBe(true);
      expect(typeof overview.data!.keyCount).toBe('number');
    });

    it('reports a missing key rather than failing', async () => {
      const missing = decodeRedisValue(
        (await runRedis(redisScripts.value(), [toHex('definitely-not-here'), toHex('10')])).data
      );
      expect(missing.type).toBe('none');
    });
  });
});
