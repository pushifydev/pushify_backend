import crypto from 'crypto';

/**
 * GitLab sends the shared secret in X-Gitlab-Token (not HMAC like GitHub).
 */
export function verifyGitLabWebhookToken(
  headerToken: string | undefined,
  expectedSecret: string,
): boolean {
  if (!headerToken || !expectedSecret) {
    return false;
  }

  const a = Buffer.from(headerToken);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}
