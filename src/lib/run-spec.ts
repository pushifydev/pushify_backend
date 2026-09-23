import { encrypt, decrypt } from './encryption';

/**
 * How a deployment's container was actually started, so another identical one can be started
 * later — which is what autoscaling does between deploys.
 *
 * Rebuilding these arguments from project settings after the fact would drift: a variable added
 * since the deploy, a volume removed, a different network on a runner, and the new replica
 * quietly differs from the containers it is meant to join. The deploy records what it used.
 *
 * Stored encrypted because `envVars` holds the project's secrets.
 */
export interface ContainerRunSpec {
  imageName: string;
  /** `pushify-<slug>` — replicas are this plus the slot and an index */
  containerName: string;
  containerPort: number;
  /** blue | green: a new replica has to join the slot the live containers are in */
  slot: string;
  bindAddress?: string;
  envVars?: Record<string, string>;
  volumes?: string[];
  networkMode?: string;
  framework?: string;
  buildpackId?: string;
}

export function encodeRunSpec(spec: ContainerRunSpec): string {
  return encrypt(JSON.stringify(spec));
}

/** Null rather than throwing: a spec that cannot be read means "do not scale", not "fail". */
export function decodeRunSpec(stored: string | null | undefined): ContainerRunSpec | null {
  if (!stored) return null;
  try {
    const spec = JSON.parse(decrypt(stored)) as ContainerRunSpec;
    if (!spec.imageName || !spec.containerName || !spec.containerPort) return null;
    return spec;
  } catch {
    return null;
  }
}

/** The name a replica gets. Index 1 is the primary container, so extras start at 2. */
export function replicaName(containerName: string, slot: string, index: number): string {
  return index <= 1 ? `${containerName}-${slot}` : `${containerName}-${slot}-${index}`;
}

/**
 * The index inside a container's name, or null when it is not one of this project's replicas.
 * `pushify-shop-blue` is 1, `pushify-shop-blue-3` is 3.
 */
export function replicaIndex(name: string, containerName: string, slot: string): number | null {
  const base = `${containerName}-${slot}`;
  if (name === base) return 1;
  if (!name.startsWith(`${base}-`)) return null;
  const suffix = name.slice(base.length + 1);
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
}
