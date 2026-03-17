import { randomBytes } from 'crypto';

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
