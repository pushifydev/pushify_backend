/**
 * References to an external secret manager inside environment variable values.
 *
 * A value may hold `{{infisical.KEY}}` — on its own (`STRIPE_KEY={{infisical.STRIPE_KEY}}`) or
 * inside a longer string (`DATABASE_URL=postgres://app:{{infisical.DB_PASSWORD}}@db/app`). The
 * reference is what Pushify stores; the real value is fetched at deploy time, handed to the
 * container and never written back to the database.
 *
 * Only Infisical is supported for now. Doppler and Vault are meant to plug in as further
 * providers with the same syntax (`{{doppler.KEY}}`, `{{vault.KEY}}`).
 */

export type SecretProvider = 'infisical';

export const SUPPORTED_SECRET_PROVIDERS: readonly SecretProvider[] = ['infisical'];

/** Secret names as Infisical accepts them: letters, digits, `_`, `-` and `.`. */
const KEY = '[A-Za-z0-9_][A-Za-z0-9_.-]*';
const REFERENCE_PATTERN = new RegExp(`\\{\\{\\s*(infisical)\\.(${KEY})\\s*\\}\\}`, 'g');

export interface SecretReference {
  /** The environment variable whose value holds the reference */
  envKey: string;
  provider: SecretProvider;
  /** The secret's name in the provider */
  secretKey: string;
}

/** Every reference in a set of env values, in order of appearance. */
export function findSecretReferences(envVars: Record<string, string>): SecretReference[] {
  const found: SecretReference[] = [];
  for (const [envKey, value] of Object.entries(envVars)) {
    if (!value || !value.includes('{{')) continue;
    for (const match of value.matchAll(REFERENCE_PATTERN)) {
      found.push({ envKey, provider: match[1] as SecretProvider, secretKey: match[2] });
    }
  }
  return found;
}

export function hasSecretReferences(envVars: Record<string, string>): boolean {
  return findSecretReferences(envVars).length > 0;
}

/** Thrown when a deploy cannot resolve a reference; the message is safe to show and log. */
export class SecretReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretReferenceError';
  }
}

/**
 * Loads the secrets of one provider for this deploy, keyed by name. Called at most once per
 * provider, and only when a value references it.
 */
export type SecretLoader = (provider: SecretProvider) => Promise<Record<string, string>>;

export interface ResolvedEnv {
  /** The env with every reference replaced by its value */
  envVars: Record<string, string>;
  /** The values that came from the secret manager, to be masked in logs */
  resolvedValues: string[];
  /** Variables that held at least one reference */
  resolvedKeys: string[];
}

/**
 * Replace every reference in `envVars` with its value. Fails — naming the variable and the
 * missing secret, never a value — when a provider is not connected, cannot be reached, or does
 * not have the secret: a container started with a literal `{{infisical.X}}` would fail later
 * and far less clearly.
 */
export async function resolveSecretReferences(
  envVars: Record<string, string>,
  load: SecretLoader
): Promise<ResolvedEnv> {
  const references = findSecretReferences(envVars);
  if (references.length === 0) {
    return { envVars: { ...envVars }, resolvedValues: [], resolvedKeys: [] };
  }

  const loaded = new Map<SecretProvider, Record<string, string>>();
  for (const provider of new Set(references.map((r) => r.provider))) {
    const users = [...new Set(references.filter((r) => r.provider === provider).map((r) => r.envKey))];
    try {
      loaded.set(provider, await load(provider));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SecretReferenceError(
        `Could not load secrets from ${providerLabel(provider)} for ${users.join(', ')}: ${reason}`
      );
    }
  }

  const missing = references.filter(
    (r) => !Object.prototype.hasOwnProperty.call(loaded.get(r.provider) ?? {}, r.secretKey)
  );
  if (missing.length > 0) {
    const list = missing.map((r) => `${r.envKey} → {{${r.provider}.${r.secretKey}}}`).join(', ');
    throw new SecretReferenceError(
      `Secret not found in ${providerLabel(missing[0].provider)}: ${list}. ` +
        'Check the secret name, environment and path of the connection.'
    );
  }

  const out: Record<string, string> = { ...envVars };
  const resolvedValues = new Set<string>();
  const resolvedKeys = new Set<string>();
  for (const { envKey } of references) {
    if (resolvedKeys.has(envKey)) continue;
    resolvedKeys.add(envKey);
    out[envKey] = envVars[envKey].replace(REFERENCE_PATTERN, (_m, provider: SecretProvider, key: string) => {
      const value = loaded.get(provider)![key];
      if (value) resolvedValues.add(value);
      return value;
    });
  }

  return { envVars: out, resolvedValues: [...resolvedValues], resolvedKeys: [...resolvedKeys] };
}

function providerLabel(provider: SecretProvider): string {
  return provider === 'infisical' ? 'Infisical' : provider;
}
