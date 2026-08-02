export const MAX_WORKERS_PER_PROJECT = 5;
export const MAX_WORKER_COMMAND_LENGTH = 1000;

/** Lowercase alphanumeric + hyphens, must start/end alphanumeric (container-name safe) */
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function validateWorkerName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Worker name is required';
  if (!WORKER_NAME_RE.test(name)) {
    return 'Worker name must be 1-40 lowercase letters, digits or hyphens (no leading/trailing hyphen)';
  }
  return null;
}

export function validateWorkerCommand(command: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return 'Worker command is required';
  if (command.length > MAX_WORKER_COMMAND_LENGTH) {
    return `Worker command is too long (max ${MAX_WORKER_COMMAND_LENGTH} chars)`;
  }
  // The command is single-quoted into `sh -c` on the host; newlines/control chars
  // would only obscure what runs — reject them outright.
  if (/[\r\n\0]/.test(command)) return 'Worker command must be a single line';
  return null;
}

/** pushify-<slug>-worker-<name> — outside the app/blue-green namespace, inside teardown's regex */
export function workerContainerName(slug: string, name: string): string {
  return `pushify-${slug}-worker-${name}`;
}
