/**
 * Normalize project root directory for Docker/build paths.
 * Treats "/", "./", "", and "." as repo root.
 */
export function normalizeRootDirectory(root?: string | null): string {
  if (root == null) return '.';
  const trimmed = root.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '.' || trimmed === './' || trimmed === '/') {
    return '.';
  }
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Docker WORKDIR when build context is already the app root (workDir). */
export function dockerAppWorkdir(): string {
  return '/app';
}
