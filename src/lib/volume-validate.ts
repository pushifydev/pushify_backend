/**
 * Validation for user-defined persistent volumes. Volumes are Docker NAMED volumes
 * (host side is docker-managed), so only the in-container mount path needs guarding.
 * The name feeds a shell command — keep it strictly [a-z0-9-].
 */

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Paths that make no sense (or break the container) as a mount target */
const DENIED_PREFIXES = ['/proc', '/sys', '/dev'];
const DENIED_EXACT = ['/', '/bin', '/etc', '/lib', '/lib64', '/sbin', '/usr'];

export function validateVolumeName(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return 'Volume name must be 1-31 chars of lowercase letters, digits and dashes, starting with a letter or digit';
  }
  return null;
}

export function validateContainerPath(containerPath: string): string | null {
  if (!containerPath.startsWith('/')) {
    return 'Mount path must be absolute (start with /)';
  }
  if (containerPath.length > 255) {
    return 'Mount path too long (max 255 chars)';
  }
  if (containerPath.includes('..')) {
    return 'Mount path must not contain ..';
  }
  if (/[\s'"`$\\;|&<>]/.test(containerPath)) {
    return 'Mount path contains unsupported characters';
  }
  const normalized = containerPath.replace(/\/+$/, '') || '/';
  if (DENIED_EXACT.includes(normalized)) {
    return `Mounting over ${normalized} is not allowed`;
  }
  if (DENIED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return `Mounting under ${normalized.split('/').slice(0, 2).join('/')} is not allowed`;
  }
  return null;
}

/** Docker named volume for a project volume row */
export function volumeDockerName(projectSlug: string, name: string): string {
  return `pushify-vol-${projectSlug}-${name}`;
}

/** `-v` mount string: pushify-vol-<slug>-<name>:<containerPath> */
export function buildVolumeMount(projectSlug: string, name: string, containerPath: string): string {
  return `${volumeDockerName(projectSlug, name)}:${containerPath}`;
}
