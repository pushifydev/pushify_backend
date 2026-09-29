import { SSHClient, type SSHConnectionConfig } from '../utils/ssh';

/**
 * Removing Pushify's SSH key from a connected (BYOS) server when the server is deleted.
 *
 * Setup appends Pushify's public key to root's authorized_keys. Deleting the server in Pushify
 * should take that access away again; when the server cannot be reached the deletion still goes
 * through and the user gets a command to remove the key themselves.
 */

export const UNINSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/pushifydev/pushify_backend/master/scripts/server-uninstall.sh';

const KEY_REMOVAL_TIMEOUT_MS = 10_000;

export interface KeyRemovalResult {
  keyRemoved: boolean;
  /** Shell command the user can run as root on the server when `keyRemoved` is false. */
  manualCommand?: string;
  /** Why the automatic removal did not happen (for logs / the UI). */
  reason?: string;
}

/**
 * `<type> <base64>` — the part of an authorized_keys line that identifies the key. Only a real
 * key qualifies: it is matched with grep -F, so anything short could match other users' lines.
 */
export function keyBody(publicKey: string): string | null {
  const [type, blob] = publicKey.trim().split(/\s+/);
  if (!type || !blob || !/^(ssh|ecdsa|sk)-[a-z0-9@.-]+$/i.test(type) || !/^[A-Za-z0-9+/=]{40,}$/.test(blob)) return null;
  return `${type} ${blob}`;
}

/** The key's comment when it is one Pushify generated (`pushify-<org>-<timestamp>`). */
export function keyComment(publicKey: string): string | null {
  const comment = publicKey.trim().split(/\s+/)[2];
  return comment && /^pushify-[a-z0-9-]+$/i.test(comment) ? comment : null;
}

/**
 * Removes every authorized_keys line carrying this key and exits 0 only if none is left.
 * Rewrites the file in place (cat >) so its owner, mode and SELinux label stay as they were.
 */
export function buildKeyRemovalCommand(publicKey: string): string | null {
  const body = keyBody(publicKey);
  if (!body) return null;
  return [
    'f="$HOME/.ssh/authorized_keys"',
    '[ -f "$f" ] || exit 0',
    `grep -vF '${body}' "$f" > "$f.pushify-tmp"`,
    'cat "$f.pushify-tmp" > "$f"',
    'rm -f "$f.pushify-tmp"',
    `! grep -qF '${body}' "$f"`,
  ].join('; ');
}

/** What the user runs on the server (as root) when Pushify could not remove the key itself. */
export function buildManualKeyRemovalCommand(publicKey: string): string | null {
  const comment = keyComment(publicKey);
  if (comment) return `sed -i '/ ${comment}$/d' /root/.ssh/authorized_keys`;
  const body = keyBody(publicKey);
  if (!body) return null;
  return `grep -vF '${body}' /root/.ssh/authorized_keys > /tmp/ak && cat /tmp/ak > /root/.ssh/authorized_keys && rm -f /tmp/ak`;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface KeyRemovalTarget {
  host: string;
  publicKey: string;
  privateKey?: string;
  password?: string;
}

/**
 * Connect as root and remove the key. Never throws: a failure becomes `keyRemoved: false` with the
 * manual command, so deleting the server is never blocked by an unreachable machine.
 */
export async function removePushifyKey(
  target: KeyRemovalTarget,
  createClient: () => Pick<SSHClient, 'connect' | 'exec' | 'disconnect'> = () => new SSHClient(),
  timeoutMs: number = KEY_REMOVAL_TIMEOUT_MS,
): Promise<KeyRemovalResult> {
  const manualCommand = buildManualKeyRemovalCommand(target.publicKey) ?? undefined;
  const command = buildKeyRemovalCommand(target.publicKey);
  if (!command) return { keyRemoved: false, manualCommand, reason: 'unrecognised public key' };
  if (!target.privateKey && !target.password) {
    return { keyRemoved: false, manualCommand, reason: 'no stored credentials' };
  }

  const client = createClient();
  try {
    const config: SSHConnectionConfig = { host: target.host, port: 22, username: 'root' };
    if (target.privateKey) config.privateKey = target.privateKey;
    else config.password = target.password;
    await withTimeout(client.connect(config), timeoutMs, 'SSH connection');
    const result = await withTimeout(client.exec(command), timeoutMs, 'Key removal');
    if (result.code !== 0) {
      return { keyRemoved: false, manualCommand, reason: result.stderr.trim() || `exit code ${result.code}` };
    }
    return { keyRemoved: true };
  } catch (err) {
    return { keyRemoved: false, manualCommand, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    try { client.disconnect(); } catch { /* already closed */ }
  }
}
