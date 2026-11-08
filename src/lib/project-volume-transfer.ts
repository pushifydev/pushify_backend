import type { SSHClient } from '../utils/ssh';

/**
 * Copying a project's persistent volumes to the server it moves to (lib/project-transfer.ts).
 *
 * The deployer builds the image on the target first, then calls `copyVolumesToTarget` right
 * before the new container starts there: the containers that use the volumes are stopped on the
 * source, each volume is streamed as a tar archive source → Pushify → target over SSH, and the
 * copy is checked against the source (file count, bytes, checksum of every file, path, mode and
 * owner). The source's volumes are only ever read — never changed or removed. When anything fails,
 * `restartOnSource` starts again exactly the containers that were stopped.
 */

const VOLUME_NAME = /^pushify-vol-[a-z0-9-]+$/;
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function safeVolume(name: string): string {
  if (!VOLUME_NAME.test(name)) throw new Error(`Unsafe volume name: ${name}`);
  return name;
}

function safeContainers(names: string[]): string[] {
  const bad = names.find((n) => !CONTAINER_NAME.test(n));
  if (bad) throw new Error(`Unsafe container name: ${bad}`);
  return names;
}

/** `m` = the volume's directory on the host; fails (and stops the `&&` chain) when it has none */
const mountpoint = (name: string) => `m=$(docker volume inspect -f '{{.Mountpoint}}' ${safeVolume(name)}) && [ -d "$m" ]`;

/** `<volume> <bytes>` per volume, `<volume> -` for one that does not exist on the server */
export function volumeSizesCommand(names: string[]): string {
  return names
    .map(
      (name) =>
        `if m=$(docker volume inspect -f '{{.Mountpoint}}' ${safeVolume(name)} 2>/dev/null); ` +
        `then echo "${name} $(du -sb "$m" 2>/dev/null | cut -f1)"; else echo "${name} -"; fi`
    )
    .join('; ');
}

export interface VolumeSize {
  /** False when the volume was never created on the server (nothing to copy) */
  exists: boolean;
  bytes: number;
}

/** Sizes by volume name; null for a volume the output says nothing usable about */
export function parseVolumeSizes(stdout: string, names: string[]): Map<string, VolumeSize | null> {
  const seen = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [name, value] = line.trim().split(/\s+/);
    if (name) seen.set(name, value ?? '');
  }
  return new Map(
    names.map((name): [string, VolumeSize | null] => {
      const value = seen.get(name);
      if (value === '-') return [name, { exists: false, bytes: 0 }];
      if (value && /^\d+$/.test(value)) return [name, { exists: true, bytes: Number(value) }];
      return [name, null];
    })
  );
}

/** Bytes free on the filesystem that holds Docker's data, where the volumes are written */
export const DOCKER_FREE_BYTES_COMMAND =
  `d=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null); ` + `df -PB1 "\${d:-/var/lib/docker}" 2>/dev/null | awk 'NR==2 {print $4}'`;

export function parseFreeBytes(stdout: string): number | null {
  const value = stdout.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

export interface VolumeDigest {
  files: number;
  bytes: number;
  sha256: string;
}

/**
 * `<files> <bytes> <sha256>` of a volume's content. The checksum covers every file's content and
 * the type, mode, owner and path of every entry (symlink targets included), so a copy matches
 * only when it is the same tree. The volume's root itself is left out: Docker creates it.
 */
export function volumeDigestCommand(name: string): string {
  return (
    `${mountpoint(name)} && cd "$m" && ` +
    `files=$(find . -type f | wc -l) && ` +
    `bytes=$(find . -type f -printf '%s\\n' | awk '{s+=$1} END {printf "%.0f", s}') && ` +
    `sum=$({ find . -mindepth 1 -printf '%y %m %U:%G %p\\n' | LC_ALL=C sort; ` +
    `find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; ` +
    `find . -type l -printf '%p -> %l\\n' | LC_ALL=C sort; } | sha256sum | cut -d' ' -f1) && ` +
    `echo "$files $bytes $sum"`
  );
}

export function parseVolumeDigest(stdout: string): VolumeDigest | null {
  const [files, bytes, sha256] = stdout.trim().split(/\s+/);
  if (!/^\d+$/.test(files ?? '') || !/^\d+$/.test(bytes ?? '') || !/^[0-9a-f]{64}$/.test(sha256 ?? '')) return null;
  return { files: Number(files), bytes: Number(bytes), sha256 };
}

/**
 * Create the volume on the target, or empty the copy an earlier move left there (it is this
 * project's: the name carries the slug and the target is a server of the same organization).
 * Only a local volume's own `_data` directory is ever emptied.
 */
export function prepareTargetVolumeCommand(name: string): string {
  const volume = safeVolume(name);
  return (
    `docker volume create ${volume} >/dev/null && ${mountpoint(volume)} && ` +
    `case "$m" in */volumes/${volume}/_data) find "$m" -mindepth 1 -delete ;; ` +
    `*) echo "unexpected volume directory: $m" >&2; exit 1 ;; esac`
  );
}

export const tarCreateCommand = (name: string) => `${mountpoint(name)} && tar --numeric-owner -C "$m" -cpf - .`;
export const tarExtractCommand = (name: string) => `${mountpoint(name)} && tar --numeric-owner -C "$m" -xpf -`;

/** Names of the running containers that mount any of the volumes; fails when `docker ps` does */
export function containersUsingVolumesCommand(names: string[]): string {
  return `for v in ${names.map(safeVolume).join(' ')}; do docker ps --filter volume=$v --format '{{.Names}}' || exit 1; done | sort -u`;
}

function lines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Sizes of the volumes on the source and the free space on the target; null where not measured */
export async function measureVolumes(
  source: SSHClient | null,
  target: SSHClient | null,
  names: string[]
): Promise<{ sizes: Map<string, VolumeSize | null>; targetFreeBytes: number | null }> {
  const [sizes, targetFreeBytes] = await Promise.all([
    source
      ? source
          .exec(volumeSizesCommand(names))
          .then((r) => parseVolumeSizes(r.stdout, names))
          .catch(() => new Map(names.map((n) => [n, null] as const)))
      : new Map(names.map((n) => [n, null] as const)),
    target
      ? target
          .exec(DOCKER_FREE_BYTES_COMMAND)
          .then((r) => (r.code === 0 ? parseFreeBytes(r.stdout) : null))
          .catch(() => null)
      : null,
  ]);
  return { sizes, targetFreeBytes };
}

async function digest(ssh: SSHClient, name: string, where: string): Promise<VolumeDigest> {
  const result = await ssh.exec(volumeDigestCommand(name));
  const parsed = result.code === 0 ? parseVolumeDigest(result.stdout) : null;
  if (!parsed) throw new Error(`Could not read volume "${name}" on the ${where} server to check the copy: ${result.stderr.trim().slice(-300)}`);
  return parsed;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface VolumeCopyOptions {
  names: string[];
  /** Free bytes the target must have on top of the volumes (lib/project-transfer.ts) */
  requiredFreeBytes: (totalBytes: number) => number;
  onLog: (message: string) => void;
  /** Called with every container stopped on the source, before it is stopped */
  onStopping: (containers: string[]) => void;
}

/**
 * Stop what uses the volumes on the source, copy each volume to the target and check the copy.
 * Throws on any problem; the caller restarts the stopped containers (`restartOnSource`).
 */
export async function copyVolumesToTarget(source: SSHClient, target: SSHClient, options: VolumeCopyOptions): Promise<void> {
  const { names, onLog } = options;

  // Measured again here, not trusted from the dry run: the data may have grown since.
  const { sizes, targetFreeBytes } = await measureVolumes(source, target, names);
  const unknown = names.filter((n) => !sizes.get(n));
  if (unknown.length > 0) throw new Error(`Could not measure volume(s) ${unknown.join(', ')} on the current server`);
  const total = names.reduce((sum, n) => sum + (sizes.get(n)?.bytes ?? 0), 0);
  const required = options.requiredFreeBytes(total);
  if (targetFreeBytes === null || targetFreeBytes < required) {
    throw new Error(
      `Not enough free disk on the target server for the volumes: ${targetFreeBytes === null ? 'unknown' : formatMb(targetFreeBytes)} free, ${formatMb(required)} needed`
    );
  }

  const using = await source.exec(containersUsingVolumesCommand(names));
  if (using.code !== 0) throw new Error(`Could not list the containers using the volumes: ${using.stderr.trim().slice(-300)}`);
  const running = safeContainers(lines(using.stdout));
  if (running.length > 0) {
    onLog(`⏸️ Stopping ${running.join(', ')} on the current server so the volumes do not change while they are copied`);
    options.onStopping(running);
    await source.exec(`docker stop ${running.join(' ')}`);
  }
  const still = await source.exec(containersUsingVolumesCommand(names));
  if (still.code !== 0 || lines(still.stdout).length > 0) {
    throw new Error(`Containers still use the volumes on the current server: ${lines(still.stdout).join(', ') || still.stderr.trim()}`);
  }

  for (const name of names) {
    const prepared = await target.exec(prepareTargetVolumeCommand(name));
    if (prepared.code !== 0) throw new Error(`Could not prepare volume "${name}" on the target server: ${prepared.stderr.trim().slice(-300)}`);

    if (!sizes.get(name)?.exists) {
      onLog(`📦 Volume ${name} was never created on the current server — it starts empty on the target`);
      continue;
    }

    onLog(`📦 Copying volume ${name} (${formatMb(sizes.get(name)!.bytes)})...`);
    const piped = await source.execPipeTo(tarCreateCommand(name), target, tarExtractCommand(name));
    if (piped.code !== 0 || piped.targetCode !== 0) {
      throw new Error(
        `Copying volume "${name}" failed (current server exit ${piped.code}, target exit ${piped.targetCode}): ` +
          `${(piped.targetStderr || piped.stderr).trim().slice(-300)}`
      );
    }

    const [from, to] = await Promise.all([digest(source, name, 'current'), digest(target, name, 'target')]);
    if (from.files !== to.files || from.bytes !== to.bytes || from.sha256 !== to.sha256) {
      throw new Error(
        `The copy of volume "${name}" does not match the current server ` +
          `(${from.files} files, ${from.bytes} bytes there; ${to.files} files, ${to.bytes} bytes on the target)`
      );
    }
    onLog(`✅ Volume ${name} copied and verified: ${to.files} files, ${formatMb(to.bytes)}, sha256 ${to.sha256.slice(0, 12)}`);
  }
}

/** Start again the containers `copyVolumesToTarget` stopped. True when it worked. */
export async function restartOnSource(source: SSHClient, containers: string[]): Promise<boolean> {
  if (containers.length === 0) return true;
  const result = await source.exec(`docker start ${safeContainers(containers).join(' ')}`);
  return result.code === 0;
}
