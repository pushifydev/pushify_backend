import crypto from 'crypto';

/**
 * Verify GitHub webhook HMAC (X-Hub-Signature-256).
 * Uses length check before timingSafeEqual to avoid throwing on mismatch.
 */
export function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) {
    return false;
  }

  const expectedHex = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  const expectedSignature = `sha256=${expectedHex}`;

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expectedSignature, 'utf8');

  if (sigBuf.length !== expBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuf, expBuf);
}
