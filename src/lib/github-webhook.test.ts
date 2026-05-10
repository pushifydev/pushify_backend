import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyGitHubSignature } from './github-webhook';

function sign(payload: string, secret: string): string {
  const hex = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `sha256=${hex}`;
}

describe('verifyGitHubSignature', () => {
  it('accepts a valid GitHub-style signature', () => {
    const secret = 'test-secret-key-for-hmac-signing-only';
    const body = '{"action":"opened"}';
    const sig = sign(body, secret);
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true);
  });

  it('rejects wrong secret', () => {
    const body = '{"ref":"refs/heads/main"}';
    const sig = sign(body, 'correct-secret');
    expect(verifyGitHubSignature(body, sig, 'wrong-secret')).toBe(false);
  });

  it('rejects malformed prefix', () => {
    const secret = 's';
    const body = '{}';
    expect(verifyGitHubSignature(body, 'md5=abc', secret)).toBe(false);
  });

  it('rejects length-mismatch without throwing', () => {
    const secret = 'secret';
    const body = '{}';
    expect(verifyGitHubSignature(body, 'sha256=tooshort', secret)).toBe(false);
  });
});
