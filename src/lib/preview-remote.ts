/**
 * PR preview deployments on a remote server: the vhost name they are served under and the
 * teardown that runs when the PR closes. Pure string builders, so they are unit-testable;
 * the SSH plumbing lives in preview.service.ts.
 */

/** Hostname of a preview URL (`https://pr-42-shop.pushify.dev` → `pr-42-shop.pushify.dev`);
 *  null for the localhost placeholder used when PREVIEW_BASE_URL is unset. */
export function previewHostname(previewUrl: string | null | undefined): string | null {
  if (!previewUrl) return null;
  try {
    const host = new URL(previewUrl).hostname;
    if (!host || host === 'localhost' || host === '127.0.0.1') return null;
    return host;
  } catch {
    return null;
  }
}

/** `<slug>-pr-<n>` — the deploy slug a preview's container, image, port and vhost are keyed by. */
export function previewDeploySlug(slug: string, prNumber: number): string {
  return `${slug}-pr-${prNumber}`;
}

function assertSafe(slug: string, prNumber: number): void {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Invalid project slug for preview cleanup: ${slug}`);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error(`Invalid PR number for preview cleanup: ${prNumber}`);
}

/**
 * Remote shell that removes everything a PR preview left on the server: its containers (the
 * `pushify-<slug>-pr-N` family from the server deployer and the `pushify-preview-…` name the
 * local path uses), its image, and its nginx vhost — then reloads nginx. Never matches
 * PR 4 when cleaning PR 42, and never the production container.
 */
export function buildPreviewTeardownScript(slug: string, prNumber: number): string {
  assertSafe(slug, prNumber);
  const deploySlug = previewDeploySlug(slug, prNumber);
  const site = `pushify-${deploySlug}`;
  return [
    `ids=$(docker ps -aq --format '{{.Names}}' | grep -E '^pushify-${deploySlug}(-|$)|^pushify-preview-${deploySlug}$' || true)`,
    'if [ -n "$ids" ]; then docker rm -f $ids 2>/dev/null || true; fi',
    `{ docker images -q --filter=reference='pushify-${deploySlug}'; docker images -q --filter=reference='pushify/${deploySlug}'; } | sort -u | xargs -r docker rmi -f 2>/dev/null || true`,
    `rm -f /etc/nginx/sites-enabled/${site} /etc/nginx/sites-available/${site} /opt/pushify/nginx/${site}.conf /etc/nginx/conf.d/preview-${deploySlug}.conf 2>/dev/null || true`,
    'nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || true',
  ].join('; ');
}
