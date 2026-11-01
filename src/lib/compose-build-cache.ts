import { createHmac } from 'crypto';
import { parse as parseYaml } from 'yaml';
import type { DeploymentBuildMetadata } from '../db/schema/deployments';

/**
 * Whether a compose redeploy has to run `docker compose build` again.
 *
 * Every compose deploy used to rebuild every image of the stack, even when only a runtime
 * variable or the replica count had changed. The build is now skipped only when everything it
 * reads is known to be the same as for the previous deploy of the same stack, that deploy
 * succeeded, and the images it ran are still on the server. Anything unknown means build.
 *
 * Not covered: files in a build context that are not part of the commit. The checkout is cloned
 * fresh every deploy, so for the same commit those are only the files Pushify writes beside the
 * compose file. A per-file build context hash is a separate change.
 */

/** The deploy of the same stack just before this one, as recorded on its deployment row. */
export interface ComposeBuildBaseline {
  status: string;
  commitHash: string | null;
  buildMetadata: DeploymentBuildMetadata | null;
}

export type ComposeBuildDecision = { build: true; reason: string } | { build: false };

/** Deployment statuses that mean the deploy finished and its stack ran */
const SUCCEEDED = new Set(['running', 'stopped']);

export function decideComposeBuild(input: {
  /** The deploy was requested as a forced build (redeploy with forceBuild) */
  forceBuild: boolean;
  /** The commit this deploy checked out */
  commitHash: string | null;
  /** composeBuildInputsHash() for this deploy; null when it could not be worked out */
  inputsHash: string | null;
  /** Image name → ID of the stack's images on the server now; null when one is missing */
  images: Record<string, string> | null;
  previous: ComposeBuildBaseline | null;
}): ComposeBuildDecision {
  const { previous } = input;
  if (input.forceBuild) return { build: true, reason: 'a forced build was requested' };
  if (!previous) return { build: true, reason: 'no previous deploy of this stack' };
  if (!SUCCEEDED.has(previous.status)) return { build: true, reason: 'the previous deploy did not succeed' };
  if (!input.commitHash || input.commitHash !== previous.commitHash) return { build: true, reason: 'a new commit' };

  const before = previous.buildMetadata;
  if (!before?.composeInputsHash || !before.composeImages) {
    return { build: true, reason: 'the previous deploy recorded no build inputs' };
  }
  if (!input.inputsHash || input.inputsHash !== before.composeInputsHash) {
    return { build: true, reason: 'the compose file or build settings changed' };
  }
  if (!input.images || Object.keys(input.images).length === 0) {
    return { build: true, reason: 'an image of the stack is not on the server' };
  }
  if (!sameImages(input.images, before.composeImages)) {
    return { build: true, reason: 'the images on the server are not the ones the previous deploy ran' };
  }
  return { build: false };
}

function sameImages(now: Record<string, string>, before: Record<string, string>): boolean {
  const names = Object.keys(now);
  return names.length === Object.keys(before).length && names.every((name) => before[name] === now[name]);
}

/**
 * A hash of what `docker compose build` reads: the commit checked out, the compose file as
 * committed, and each building service's resolved `build:` section (context, dockerfile, args,
 * target…) from `docker compose config` — after interpolation, so a variable used in a build arg
 * counts and a runtime-only variable does not.
 *
 * Keyed (HMAC) because build args can carry secrets and the hash is stored on the deployment row.
 * Null when it cannot be worked out, which makes the deploy build.
 */
export function composeBuildInputsHash(
  input: { head: string; composeYaml: string; resolvedConfig: string },
  key: string
): string | null {
  const head = input.head.trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(head)) return null;

  let resolved: unknown;
  try {
    resolved = parseYaml(input.resolvedConfig);
  } catch {
    return null;
  }
  const services = (resolved as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return null;

  const builds: unknown[] = [];
  for (const name of Object.keys(services).sort()) {
    const service = (services as Record<string, Record<string, unknown> | null>)[name];
    if (!service || service.build === undefined || service.build === null) continue;
    // Build secrets are named here, but their values come from files or variables not hashed
    if (typeof service.build === 'object' && (service.build as { secrets?: unknown }).secrets) return null;
    builds.push({ name, build: service.build, image: service.image ?? null, platform: service.platform ?? null });
  }

  return createHmac('sha256', key)
    .update(JSON.stringify(canonical({ v: 1, head, composeYaml: input.composeYaml, builds })))
    .digest('hex');
}

/** The same value with object keys sorted, so equal configs stringify the same */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}
