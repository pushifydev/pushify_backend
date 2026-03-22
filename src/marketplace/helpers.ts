import { randomBytes } from 'crypto';

export function generatePassword(length = 24): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}

export function generateSecret(length = 64): string {
  return randomBytes(length).toString('hex').slice(0, length);
}
