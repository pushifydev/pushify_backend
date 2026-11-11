import { randomUUID } from 'crypto';
import type { SSHClient } from '../utils/ssh';
import { shSingleQuote } from '../workers/shell';
import { parseDockerSizeToBytes } from './server-disk-cleanup';
import {
  acquireServerDiskCleanupLock,
  releaseServerDiskCleanupLock,
  waitForServerDiskCleanup,
} from './server-disk-cleanup-lock';
import { logger } from './logger';

/**
 * One-off cleanup a deploy runs when the disk guard trips, before the deploy is refused.
 *
 * The hourly cleanup (server-disk-cleanup.ts) only runs on managed servers above 80% and only
 * prunes build cache older than 72h; the deploy-time image cleanup only trims the project being
 * deployed. Neither ran at the moment a deploy found the disk full, so the guard refused deploys
 * that a cleanup would have let through.
 *
 * What this removes — only what Pushify can always rebuild:
 *   - all unused BuildKit build cache (`docker builder prune -af`),
 *   - dangling (untagged) images (`docker image prune -f`, no `-a`),
 *   - Pushify app containers in the `dead` state (they can never start again). Stopped containers
 *     are kept: a sleeping or stopped app is a stopped container. Databases (`pushify-db-*`) and
 *     compose-managed containers are never touched, and `docker rm` runs without `-v`,
 *   - per `pushify-*` image repository, images older than the newest ROLLBACK_IMAGES_KEPT —
 *     never the `latest` image, never an image a container (running or stopped) uses, and `docker
 *     rmi` runs without `-f` so Docker refuses anything still in use.
 * Never volumes: no `--volumes`, no `volume prune`, no `system prune`.
 */

/** Images kept per project image repository for rollback (on top of `latest` and in-use ones). */
export const ROLLBACK_IMAGES_KEPT = 5;

export const DEPLOY_CLEANUP_MARKER = 'PUSHIFY_DEPLOY_CLEANUP';

/** Lists every image (full IDs) and the image ID of every container, running or stopped. */
export const IMAGE_INVENTORY_COMMAND = [
  "docker images --no-trunc --format 'IMG|{{.Repository}}|{{.Tag}}|{{.ID}}|{{.CreatedAt}}' 2>/dev/null",
  "docker ps -aq --no-trunc 2>/dev/null | xargs -r docker inspect --format 'USE|{{.Image}}' 2>/dev/null",
  'true',
].join('\n');

export interface InventoryImage {
  repository: string;
  tag: string;
  id: string;
  createdAt: string;
}

export function parseImageInventory(stdout: string): { images: InventoryImage[]; inUse: Set<string> } {
  const images: InventoryImage[] = [];
  const inUse = new Set<string>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('|');
    if (parts[0] === 'IMG' && parts.length >= 5) {
      const [, repository, tag, id, createdAt] = parts;
      if (repository && tag && id) images.push({ repository, tag, id, createdAt: createdAt ?? '' });
    } else if (parts[0] === 'USE' && parts[1]) {
      inUse.add(parts[1]);
    }
  }
  return { images, inUse };
}

/** `docker images` CreatedAt (`2026-11-10 16:36:00 +0000 UTC`) to epoch ms; null when unreadable. */
export function parseDockerCreatedAt(raw: string): number | null {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isFinite(ms) ? ms : null;
}

/** What `docker rmi` gets: a Pushify repository and a plain tag, nothing a shell could read. */
const REMOVABLE_REF = /^pushify-[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * `repo:tag` references of old Pushify project images. Per repository the images (grouped by ID:
 * a deploy tags one image as `<commit>`, `deploy-<id>` and `latest`) are ordered newest first and
 * the newest `keep` survive, as do the `latest` image and every image a container uses. An image
 * whose age cannot be read counts as new: unknown never means removable.
 */
export function selectOldProjectImages(
  images: InventoryImage[],
  inUse: Set<string>,
  keep: number = ROLLBACK_IMAGES_KEPT
): string[] {
  const repos = new Map<string, Map<string, { created: number | null; tags: string[] }>>();
  for (const img of images) {
    if (!img.repository.startsWith('pushify-') || img.tag === '<none>') continue;
    const byId = repos.get(img.repository) ?? new Map<string, { created: number | null; tags: string[] }>();
    repos.set(img.repository, byId);
    const entry = byId.get(img.id) ?? { created: parseDockerCreatedAt(img.createdAt), tags: [] };
    entry.tags.push(img.tag);
    byId.set(img.id, entry);
  }

  const refs: string[] = [];
  for (const [repository, byId] of repos) {
    // Unknown age: kept, and outside the window so it cannot push a known image out of it
    const newestFirst = [...byId.entries()]
      .filter(([, entry]) => entry.created !== null)
      .sort(([, a], [, b]) => (b.created as number) - (a.created as number));
    newestFirst.forEach(([id, entry], index) => {
      if (index < keep || inUse.has(id) || entry.tags.includes('latest')) return;
      for (const tag of entry.tags) {
        const ref = `${repository}:${tag}`;
        if (REMOVABLE_REF.test(ref)) refs.push(ref);
      }
    });
  }
  return refs;
}

/**
 * Shell run over SSH. Prints `DF|<type>|<size>` lines (docker system df after the cleanup) and
 * one summary line:
 *   PUSHIFY_DEPLOY_CLEANUP before=<used bytes> after=<used bytes> containers=<count> images=<count>
 */
export function buildDeployDiskCleanupScript(oldImageRefs: string[]): string {
  const lines = [
    'used() { df -P -B1 / 2>/dev/null | tail -1 | awk \'{print $3}\'; }',
    'BEFORE=$(used)',
    'CTR=0',
    'IMG=0',
    // Dead containers only (they can never start again); never databases or compose stacks.
    'for id in $(docker ps -aq --no-trunc --filter status=dead 2>/dev/null); do',
    '  info=$(docker inspect --format \'{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}\' "$id" 2>/dev/null) || continue',
    '  name=${info%%|*}; compose=${info#*|}',
    '  case "$name" in /pushify-db-*) continue ;; /pushify-*) ;; *) continue ;; esac',
    '  [ -n "$compose" ] && [ "$compose" != "<no value>" ] && continue',
    '  docker rm "$id" >/dev/null 2>&1 && CTR=$((CTR + 1))',
    'done',
  ];
  if (oldImageRefs.length > 0) {
    // No -f: Docker refuses an image a container (running or stopped) still uses.
    lines.push(
      `for ref in ${oldImageRefs.map(shSingleQuote).join(' ')}; do`,
      '  docker rmi "$ref" >/dev/null 2>&1 && IMG=$((IMG + 1))',
      'done'
    );
  }
  lines.push(
    'docker image prune -f >/dev/null 2>&1 || true',
    'docker builder prune -af >/dev/null 2>&1 || true',
    'AFTER=$(used)',
    "docker system df --format 'DF|{{.Type}}|{{.Size}}' 2>/dev/null",
    `echo "${DEPLOY_CLEANUP_MARKER} before=\${BEFORE:-0} after=\${AFTER:-0} containers=\${CTR} images=\${IMG}"`
  );
  return lines.join('\n');
}

export interface DockerUsageEntry {
  type: string;
  size: string;
  bytes: number;
}

export interface DeployDiskCleanupResult {
  /** False when the cleanup did not run here (summary line missing, SSH error, lock taken) */
  ran: boolean;
  /** Another cleanup held the server's lock; this deploy waited for it instead */
  waitedForOther: boolean;
  freedBytes: number;
  removedContainers: number;
  removedImages: number;
  /** `docker system df` after the cleanup, largest first */
  usage: DockerUsageEntry[];
}

const NOT_RAN: DeployDiskCleanupResult = {
  ran: false,
  waitedForOther: false,
  freedBytes: 0,
  removedContainers: 0,
  removedImages: 0,
  usage: [],
};

export function parseDeployDiskCleanupOutput(stdout: string): DeployDiskCleanupResult {
  const lines = stdout.split('\n').map((l) => l.trim());
  const summary = lines.find((l) => l.startsWith(DEPLOY_CLEANUP_MARKER));
  if (!summary) return { ...NOT_RAN, usage: [] };
  const fields: Record<string, string> = {};
  for (const part of summary.slice(DEPLOY_CLEANUP_MARKER.length).trim().split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const num = (v: string | undefined) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const usage = lines
    .filter((l) => l.startsWith('DF|'))
    .map((l) => {
      const [, type = '', size = ''] = l.split('|');
      return { type, size, bytes: parseDockerSizeToBytes(size) };
    })
    .filter((u) => u.type)
    .sort((a, b) => b.bytes - a.bytes);
  return {
    ran: true,
    waitedForOther: false,
    freedBytes: Math.max(0, num(fields.before) - num(fields.after)),
    removedContainers: num(fields.containers),
    removedImages: num(fields.images),
    usage,
  };
}

/** Bytes as GB with one decimal, the unit the disk check reports free space in. */
export function formatGb(bytes: number): string {
  return String(Math.round((bytes / 1024 ** 3) * 10) / 10);
}

/** Largest items on disk, e.g. `Local Volumes 20GB, Images 6.1GB, Build Cache 0B`. */
export function formatDockerUsage(usage: DockerUsageEntry[], top = 3): string {
  return usage
    .slice(0, top)
    .map((u) => `${u.type} ${u.size}`)
    .join(', ');
}

/** The cleanup's part of the error a deploy is refused with. */
export function describeCleanupForError(result: DeployDiskCleanupResult): string {
  if (result.waitedForOther) return 'An automatic cleanup already ran on this server just now.';
  if (!result.ran) return 'The automatic cleanup could not run.';
  const usage = formatDockerUsage(result.usage);
  return (
    `Automatic cleanup freed ${formatGb(result.freedBytes)} GB` +
    (usage ? `; largest on disk: ${usage}.` : '.')
  );
}

/** Inventory, choose and remove. Never throws: a failed cleanup must not mask the disk reason. */
export async function runDeployDiskCleanup(
  ssh: SSHClient,
  keep: number = ROLLBACK_IMAGES_KEPT
): Promise<DeployDiskCleanupResult> {
  try {
    const inventory = await ssh.exec(IMAGE_INVENTORY_COMMAND);
    const { images, inUse } = parseImageInventory(inventory.stdout ?? '');
    const refs = selectOldProjectImages(images, inUse, keep);
    const result = await ssh.exec(buildDeployDiskCleanupScript(refs));
    return parseDeployDiskCleanupOutput(result.stdout ?? '');
  } catch (err) {
    logger.warn({ err }, 'Deploy disk cleanup failed');
    return { ...NOT_RAN, usage: [] };
  }
}

/**
 * The disk guard tripped: run the cleanup once, under the server's cleanup lock, and say in the
 * deploy log what it freed. When another cleanup holds the lock, wait for it instead of pruning
 * the same host twice.
 */
export async function reclaimDiskBeforeDeploy(
  ssh: SSHClient,
  serverId: string,
  onProgress: (msg: string) => void
): Promise<DeployDiskCleanupResult> {
  const token = randomUUID();
  if (!(await acquireServerDiskCleanupLock(serverId, token))) {
    onProgress('⏳ Another disk cleanup is running on this server — waiting for it to finish...');
    await waitForServerDiskCleanup(serverId);
    return { ...NOT_RAN, usage: [], waitedForOther: true };
  }
  try {
    onProgress('🧹 Disk is too full to deploy — cleaning build cache, dangling and old images (volumes and databases are never touched)...');
    const result = await runDeployDiskCleanup(ssh);
    if (result.ran) {
      const removed = [
        result.removedImages > 0 ? `${result.removedImages} old image tag(s)` : null,
        result.removedContainers > 0 ? `${result.removedContainers} dead container(s)` : null,
      ].filter(Boolean);
      onProgress(
        `🧹 Disk cleanup freed ${formatGb(result.freedBytes)} GB` + (removed.length ? ` (removed ${removed.join(', ')})` : '')
      );
    } else {
      onProgress('⚠️ Disk cleanup could not run on this server');
    }
    logger.info(
      {
        serverId,
        ran: result.ran,
        freedBytes: result.freedBytes,
        removedImages: result.removedImages,
        removedContainers: result.removedContainers,
      },
      'Deploy disk cleanup finished'
    );
    return result;
  } finally {
    await releaseServerDiskCleanupLock(serverId, token);
  }
}
