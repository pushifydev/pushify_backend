import { randomBytes } from 'crypto';

export function generatePassword(length = 24): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}

export function generateSecret(length = 64): string {
  return randomBytes(length).toString('hex').slice(0, length);
}

/** Cal.com requires CALENDSO_ENCRYPTION_KEY to be exactly 32 characters */
export function generateCalcomEncryptionKey(): string {
  return randomBytes(16).toString('hex');
}

/** Host part for Cal.com ALLOWED_HOSTNAMES (no protocol), e.g. 91.99.153.113:5001 */
export function getHostFromPublicUrl(publicUrl: string): string {
  try {
    return new URL(publicUrl).host;
  } catch {
    return publicUrl.replace(/^https?:\/\//, '').split('/')[0];
  }
}

/**
 * Cal.com parses ALLOWED_HOSTNAMES as JSON.parse(`[${process.env.ALLOWED_HOSTNAMES}]`).
 * The env value must include JSON string quotes, e.g. "91.99.153.113:5000"
 * (plain 91.99.153.113:5000 breaks JSON.parse and yields ALLOWED_HOSTNAMES: []).
 */
export function formatCalcomAllowedHostnames(publicUrl: string): string {
  const host = getHostFromPublicUrl(publicUrl);
  return `"${host}"`;
}

/** Host:port for baking into compose YAML (no protocol). */
export function getCalcomAllowedHostPlaceholder(publicUrl: string): string {
  return getHostFromPublicUrl(publicUrl);
}

/** Host without port — for Docker extra_hosts (IP or domain only) */
export function getCalcomExtraHost(publicUrl: string): string {
  const host = getHostFromPublicUrl(publicUrl);
  return host.split(':')[0];
}

const STRIPE_PLACEHOLDER = 'sk_test_pushify_selfhost_placeholder';

/** Cal.com crashes onboarding without Stripe env vars even when payments are unused */
export function applyCalcomEnvDefaults(
  env: Record<string, string>,
  options?: { publicUrl?: string }
): Record<string, string> {
  const out = { ...env };
  if (!out.CALENDSO_ENCRYPTION_KEY || out.CALENDSO_ENCRYPTION_KEY.length !== 32) {
    out.CALENDSO_ENCRYPTION_KEY = generateCalcomEncryptionKey();
  }
  if (!out.JWT_SECRET) out.JWT_SECRET = generateSecret(32);
  if (!out.NEXTAUTH_SECRET) out.NEXTAUTH_SECRET = generateSecret(32);
  out.STRIPE_PRIVATE_KEY = out.STRIPE_PRIVATE_KEY || STRIPE_PLACEHOLDER;
  out.STRIPE_API_KEY = out.STRIPE_API_KEY || STRIPE_PLACEHOLDER;
  out.STRIPE_WEBHOOK_SECRET = out.STRIPE_WEBHOOK_SECRET || 'whsec_pushify_selfhost_placeholder';
  out.REDIS_URL = out.REDIS_URL || 'redis://redis:6379';
  out.CALCOM_TELEMETRY_DISABLED = out.CALCOM_TELEMETRY_DISABLED || '1';
  out.AUTH_TRUST_HOST = out.AUTH_TRUST_HOST || 'true';
  out.ORGANIZATIONS_ENABLED = out.ORGANIZATIONS_ENABLED || 'false';

  out.DATABASE_HOST = out.DATABASE_HOST || 'database:5432';
  out.NODE_ENV = out.NODE_ENV || 'production';
  out.WEBAPP_URL = out.WEBAPP_URL || out.NEXT_PUBLIC_WEBAPP_URL || options?.publicUrl || '';

  if (options?.publicUrl) {
    out.NEXT_PUBLIC_WEBAPP_URL = out.NEXT_PUBLIC_WEBAPP_URL || options.publicUrl;
    out.NEXTAUTH_URL = out.NEXTAUTH_URL || out.NEXT_PUBLIC_WEBAPP_URL;
    out.WEBAPP_URL = out.WEBAPP_URL || out.NEXT_PUBLIC_WEBAPP_URL;
    // Baked into compose YAML at deploy — do not rely on .env substitution (quotes break dotenv)
    out.CALCOM_EXTRA_HOST = out.CALCOM_EXTRA_HOST || getCalcomExtraHost(options.publicUrl);
  }

  return out;
}

/**
 * Compose only injects vars listed under a service's `environment:` — a bare .env
 * entry never reaches a container. Builds a docker-compose.override.yml that forwards
 * user env vars to services by key prefix (template.envPassthrough); values stay in
 * .env and are referenced via ${VAR} so no YAML quoting/escaping is needed.
 * Returns null when nothing matches (caller should remove any stale override file).
 */
export function buildComposeEnvOverride(
  envVars: Record<string, string>,
  passthrough: Record<string, string[]> | undefined
): { yaml: string; forwarded: Record<string, string[]> } | null {
  if (!passthrough) return null;
  const forwarded: Record<string, string[]> = {};
  const sections: string[] = [];
  for (const [service, prefixes] of Object.entries(passthrough)) {
    const keys = Object.keys(envVars)
      .filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .filter((k) => prefixes.some((p) => k.startsWith(p)))
      .sort();
    if (keys.length === 0) continue;
    forwarded[service] = keys;
    sections.push(
      `  ${service}:\n    environment:\n${keys.map((k) => `      ${k}: \${${k}}`).join('\n')}`
    );
  }
  if (sections.length === 0) return null;
  return { yaml: `services:\n${sections.join('\n')}\n`, forwarded };
}
