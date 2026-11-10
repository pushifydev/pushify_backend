/**
 * When a compose stack deploy pulls the images of its services.
 *
 * - `always` (the default, and what every compose deploy did before this setting existed): every
 *   deploy runs `docker compose pull`, so a moving tag such as `:latest` is brought up to date even
 *   when the build is skipped (lib/compose-build-cache.ts). A pulled image with a new ID then makes
 *   the build cache build again.
 * - `missing`: only images that are not on the server yet are pulled; a tag already there is
 *   started as it is, so a deploy never picks up a newer image behind the same tag by surprise.
 *
 * Set per project (`projects.compose_pull_policy`) or in pushify.yaml (`pullPolicy`, which wins).
 */

export const COMPOSE_PULL_POLICIES = ['always', 'missing'] as const;
export type ComposePullPolicy = (typeof COMPOSE_PULL_POLICIES)[number];
export const DEFAULT_COMPOSE_PULL_POLICY: ComposePullPolicy = 'always';

/** Anything that is not a known policy (an old row, a typo) behaves like the default. */
export function normalizeComposePullPolicy(value: unknown): ComposePullPolicy {
  return (COMPOSE_PULL_POLICIES as readonly unknown[]).includes(value)
    ? (value as ComposePullPolicy)
    : DEFAULT_COMPOSE_PULL_POLICY;
}

/** Arguments to `docker compose` for the pull step of a deploy. */
export function composePullArgs(policy: ComposePullPolicy): string {
  return policy === 'missing' ? 'pull --policy missing --ignore-pull-failures' : 'pull --ignore-pull-failures';
}

export interface PulledImage {
  image: string;
  /** `new`: it was not on the server before; `updated`: the tag now points at another image */
  change: 'new' | 'updated';
}

/**
 * The images the pull step brought to the server, from image name → ID (null = not on the server)
 * read before and after it. An image whose ID did not change was already up to date (or could not
 * be pulled, like the image of a service that is only built).
 */
export function pulledImages(
  before: Record<string, string | null>,
  after: Record<string, string | null>
): PulledImage[] {
  const pulled: PulledImage[] = [];
  for (const image of Object.keys(after).sort()) {
    const now = after[image];
    if (!now || now === before[image]) continue;
    pulled.push({ image, change: before[image] ? 'updated' : 'new' });
  }
  return pulled;
}
