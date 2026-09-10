import { randomBytes } from 'crypto';

/**
 * Normalize a client IP for storage in our varchar(45) ip columns.
 * `x-forwarded-for` may be a comma-separated proxy chain ("client, proxy1, ...");
 * keep only the first (client) IP and hard-cap to 45 chars (max IPv6 length) so a
 * long header never overflows the column and 500s the request.
 */
export function normalizeClientIp(ip?: string | null): string | undefined {
  if (!ip) return undefined;
  const first = ip.split(',')[0]?.trim();
  return first ? first.slice(0, 45) : undefined;
}

// Generate URL-friendly slug from string
export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove non-word chars
    .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

// Generate unique slug with random suffix
export function generateUniqueSlug(text: string): string {
  const base = generateSlug(text);
  const suffix = randomBytes(3).toString('hex'); // 6 char random suffix
  return `${base}-${suffix}`;
}

// Generate random token (for email verification, etc.)
export function generateRandomToken(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

// Hash token for storage (simple SHA256)
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}


/**
 * Filename safe to put inside `Content-Disposition: attachment; filename="…"`.
 * Strips quotes, control chars and path separators so a crafted database name can't
 * inject header fields or escape the quoted value.
 */
export function safeAttachmentName(name: string, fallback = 'download'): string {
  const cleaned = name
    .replace(/[\r\n"\\/]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  return cleaned || fallback;
}
