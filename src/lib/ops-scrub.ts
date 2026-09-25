import { redactUrlCredentials } from './utils';

/**
 * Makes an error message safe to leave the platform. The ops signals endpoint hands deploy and
 * server errors to an external agent (and from there to a language model); an error that echoed
 * an environment variable or a clone URL would otherwise carry a customer's secret with it.
 *
 * Deliberately over-eager: a redacted word in a diagnosis costs nothing, a leaked token does.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // Provider tokens with a recognisable shape.
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, '[token]'],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}\b/g, '[token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[token]'],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[token]'],
  // KEY=value / key: value where the name says it is secret.
  [
    /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|DSN|DATABASE_URL)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    '$1=[redacted]',
  ],
  // PEM blocks.
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, '[private key]'],
  // E-mail addresses: customer-written text (cancellation comments) goes out too.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // Long opaque strings (hex or base64) — keys, hashes of keys, session ids.
  [/\b[A-Fa-f0-9]{40,}\b/g, '[hex]'],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, '[opaque]'],
];

export function scrubSecrets(text: string | null | undefined, maxLength = 300): string | null {
  if (!text) return null;
  let out = redactUrlCredentials(text);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
