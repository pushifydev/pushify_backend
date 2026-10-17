import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from 'hono';

/**
 * Where an audited action came from.
 *  - ui:      a signed-in user (dashboard / CLI session token)
 *  - api:     a request authenticated with a Pushify API key (pk_live_...)
 *  - webhook: a git provider webhook (push, merge request, ...)
 *  - system:  background work with no caller (deploy worker, schedulers)
 */
export const AUDIT_SOURCES = ['ui', 'api', 'webhook', 'system'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

/**
 * One field's change. Sensitive values are never written: only `{ changed: true }` is kept so the
 * reader knows the value moved without learning what it was or what it became.
 */
export type AuditFieldChange = { from: unknown; to: unknown } | { changed: true };
export type AuditChanges = Record<string, AuditFieldChange>;

export const REDACTED = '[redacted]';

/** Field names whose values must never land in the audit log. */
const SENSITIVE_KEY = /(secret|token|passw|pwd|api[-_]?key|private[-_]?key|credential|auth|cookie|signature)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** The source of the current request: API key callers are `api`, everyone else signed in is `ui`. */
export function auditSource(c: Context): AuditSource {
  return c.get('isApiKeyAuth') ? 'api' : 'ui';
}

/** The API key a request authenticated with, as recorded on audit entries (never the secret). */
export interface AuditApiKey {
  id: string;
  name: string;
}

const auditApiKeyStore = new AsyncLocalStorage<AuditApiKey>();

/**
 * Run `fn` (the rest of the request) with the authenticating API key attached, so every audit entry
 * written during it can name the key without each call site having to pass it along.
 */
export function runWithAuditApiKey<T>(apiKey: AuditApiKey, fn: () => T): T {
  return auditApiKeyStore.run({ id: apiKey.id, name: apiKey.name }, fn);
}

/** The API key of the current request, if it was authenticated with one. */
export function currentAuditApiKey(): AuditApiKey | undefined {
  return auditApiKeyStore.getStore();
}

/** Drop `user:password@` from URLs so credentials embedded in e.g. a git remote are not recorded. */
function stripUrlCredentials(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, `$1${REDACTED}@`);
}

/** Values that cannot carry a secret: empty, or a flag such as `isSecret: true`. */
function isHarmless(v: unknown): boolean {
  return v === null || v === undefined || v === '' || typeof v === 'boolean';
}

/** Deep copy of a value safe to persist: sensitive keys are replaced, URL credentials removed. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return stripUrlCredentials(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) && !isHarmless(v) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export interface DiffOptions {
  /** Only compare these fields (default: every key present in `after`). */
  fields?: string[];
  /** Extra fields whose values are secret regardless of their name. */
  secretFields?: string[];
}

/**
 * Field-level before/after diff for the audit log. Unchanged fields are left out. Secret fields
 * (by name, or listed in `secretFields`) are recorded as `{ changed: true }` only; every other value
 * is passed through `redactValue` so nested secrets and URL credentials never reach the log.
 */
export function diffChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: DiffOptions = {}
): AuditChanges {
  const b = before ?? {};
  const a = after ?? {};
  const secret = new Set(options.secretFields ?? []);
  const fields = options.fields ?? Object.keys(a);
  const changes: AuditChanges = {};

  for (const field of fields) {
    const from = b[field];
    const to = a[field];
    if (sameValue(from, to)) continue;
    if (secret.has(field) || (isSensitiveKey(field) && !(isHarmless(from) && isHarmless(to)))) {
      changes[field] = { changed: true };
    } else {
      changes[field] = { from: redactValue(from ?? null), to: redactValue(to ?? null) };
    }
  }
  return changes;
}

/**
 * Last line of defence applied when an entry is written, whatever the caller built: secret-named
 * fields keep only `{ changed: true }`, other values are redacted. Returns null for an empty diff.
 */
export function sanitizeChanges(changes: AuditChanges | null | undefined): AuditChanges | null {
  if (!changes) return null;
  const out: AuditChanges = {};
  for (const [field, change] of Object.entries(changes)) {
    if (!change || typeof change !== 'object' || !('from' in change)) {
      out[field] = { changed: true };
      continue;
    }
    if (isSensitiveKey(field) && !(isHarmless(change.from) && isHarmless(change.to))) {
      out[field] = { changed: true };
    } else {
      out[field] = { from: redactValue(change.from ?? null), to: redactValue(change.to ?? null) };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
