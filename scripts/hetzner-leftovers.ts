/**
 * What is left in Pushify's Hetzner account after servers were deleted: snapshots whose server no
 * longer exists (they keep billing and can only be restored onto that server), and `pushify-*` SSH
 * keys that no server in our database uses any more.
 *
 *   npm run hetzner:leftovers            # report only
 *   npm run hetzner:leftovers -- --delete  # delete what the report lists
 *
 * Run on the API host: it compares against the PRODUCTION database (DATABASE_URL in .env) — run
 * against another database, every key would look unused. Servers that exist at Hetzner but not in
 * our database are reported and never touched.
 */
import { isNotNull } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { servers } from '../src/db/schema';
import { env } from '../src/config/env';

const API = 'https://api.hetzner.cloud/v1';
const doDelete = process.argv.includes('--delete');

async function hetzner<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.HETZNER_API_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok && res.status !== 204) throw new Error(`Hetzner ${init.method ?? 'GET'} ${path}: ${res.status}`);
  return (res.status === 204 ? {} : await res.json()) as T;
}

async function all<T>(path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await hetzner<Record<string, unknown> & { meta?: { pagination?: { next_page: number | null } } }>(
      `${path}${sep}per_page=50&page=${page}`,
    );
    out.push(...((res[key] as T[]) ?? []));
    if (!res.meta?.pagination?.next_page) break;
  }
  return out;
}

async function main() {
  if (!env.HETZNER_API_TOKEN) throw new Error('HETZNER_API_TOKEN is not set');

  const liveServers = await all<{ id: number; name: string }>('/servers', 'servers');
  const liveIds = new Set(liveServers.map((s) => String(s.id)));
  const snapshots = await all<{ id: number; description: string; image_size: number | null; created: string; created_from: { id: number; name: string } | null }>(
    '/images?type=snapshot',
    'images',
  );
  const keys = await all<{ id: number; name: string; created: string }>('/ssh_keys', 'ssh_keys');

  const ours = await db
    .select({ providerId: servers.providerId, sshKeyId: servers.sshKeyId })
    .from(servers)
    .where(isNotNull(servers.providerId));
  const knownServerIds = new Set(ours.map((s) => String(s.providerId)));
  const usedKeyIds = new Set(ours.map((s) => s.sshKeyId).filter((k): k is string => !!k));

  const orphanSnapshots = snapshots.filter((s) => s.created_from && !liveIds.has(String(s.created_from.id)));
  const orphanKeys = keys.filter((k) => k.name.startsWith('pushify-') && !usedKeyIds.has(String(k.id)));
  const unknownServers = liveServers.filter((s) => !knownServerIds.has(String(s.id)));

  const gb = orphanSnapshots.reduce((sum, s) => sum + (s.image_size ?? 0), 0);
  console.log(`Snapshots of deleted servers: ${orphanSnapshots.length} (${gb.toFixed(2)} GB)`);
  for (const s of orphanSnapshots) {
    console.log(`  ${s.id}  ${(s.image_size ?? 0).toFixed(2)} GB  ${s.created.slice(0, 10)}  from ${s.created_from!.name} (${s.created_from!.id})  ${s.description}`);
  }
  console.log(`pushify-* SSH keys no server uses: ${orphanKeys.length}`);
  for (const k of orphanKeys) console.log(`  ${k.id}  ${k.name}  ${k.created.slice(0, 10)}`);
  if (unknownServers.length) {
    console.log(`Servers at Hetzner that are not in the database (not touched): ${unknownServers.length}`);
    for (const s of unknownServers) console.log(`  ${s.id}  ${s.name}`);
  }

  if (!doDelete) {
    console.log('\nReport only. Run with --delete to remove the snapshots and keys listed above.');
    return;
  }
  for (const s of orphanSnapshots) {
    await hetzner(`/images/${s.id}`, { method: 'DELETE' });
    console.log(`deleted snapshot ${s.id}`);
  }
  for (const k of orphanKeys) {
    await hetzner(`/ssh_keys/${k.id}`, { method: 'DELETE' });
    console.log(`deleted SSH key ${k.id} ${k.name}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
