/**
 * Secret masking for deploy/build and runtime container logs.
 *
 * User builds routinely print environment values (`console.log(process.env)`, framework
 * error dumps, ORM connection errors) — without masking, secrets land in persisted logs
 * and live streams. Masking happens at WRITE/stream time via a per-project masker built
 * from the project's decrypted env values (plus ad-hoc secrets like git access tokens).
 */

const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|passwd|pass\b|api[_-]?key|private|credential|auth|dsn|database_url|connection[_-]?string|webhook)/i;

/** Values that would garble logs if masked (common words / tiny values) */
const TRIVIAL_VALUE_PATTERN =
  /^(true|false|null|undefined|yes|no|on|off|production|development|staging|test|localhost|utf-?8|\d{1,5})$/i;

const MASK = '••••••';
const MIN_SECRET_LENGTH = 4;
/** Non-sensitive-looking keys still get masked when the value is long (likely a credential) */
const LONG_VALUE_THRESHOLD = 16;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface LogMasker {
  mask(text: string): string;
  /** Register additional secrets discovered mid-flow (e.g. git access tokens). */
  addSecrets(values: Array<string | null | undefined>): void;
  /** Register env vars through the sensitive-key / long-value heuristic. */
  addEnvVars(envVars: Record<string, string>): void;
  /** Number of active secrets (for tests/diagnostics) */
  size(): number;
}

function collectEnvSecrets(envVars: Record<string, string>): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (!value || TRIVIAL_VALUE_PATTERN.test(value.trim())) continue;
    const sensitiveKey = SENSITIVE_KEY_PATTERN.test(key);
    if (!sensitiveKey && value.length < LONG_VALUE_THRESHOLD) continue;
    if (sensitiveKey && value.length < MIN_SECRET_LENGTH) continue;
    // Multi-line values (PEM keys): occurrences in logs are line-by-line.
    for (const line of value.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_SECRET_LENGTH && !TRIVIAL_VALUE_PATTERN.test(trimmed)) {
        secrets.push(trimmed);
      }
    }
  }
  return secrets;
}

export function createLogMasker(envVars: Record<string, string> = {}): LogMasker {
  const secrets = new Set<string>(collectEnvSecrets(envVars));
  let pattern: RegExp | null = null;
  let dirty = true;

  const rebuild = () => {
    if (secrets.size === 0) {
      pattern = null;
    } else {
      // Longest first so partial overlaps mask fully.
      const alternation = [...secrets]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
      pattern = new RegExp(alternation, 'g');
    }
    dirty = false;
  };

  return {
    mask(text: string): string {
      if (dirty) rebuild();
      if (!pattern || !text) return text;
      pattern.lastIndex = 0;
      return text.replace(pattern, MASK);
    },
    addSecrets(values) {
      for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed && trimmed.length >= MIN_SECRET_LENGTH && !TRIVIAL_VALUE_PATTERN.test(trimmed)) {
          if (!secrets.has(trimmed)) {
            secrets.add(trimmed);
            dirty = true;
          }
        }
      }
    },
    addEnvVars(envVars) {
      for (const secret of collectEnvSecrets(envVars)) {
        if (!secrets.has(secret)) {
          secrets.add(secret);
          dirty = true;
        }
      }
    },
    size() {
      return secrets.size;
    },
  };
}
