import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'pushify';
const PURPOSE = 'onboarding-unsubscribe';

/** Long-lived signed token embedded in lifecycle emails' unsubscribe links. */
export async function createUnsubscribeToken(userId: string): Promise<string> {
  return new SignJWT({ purpose: PURPOSE })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('180d')
    .sign(secret);
}

/** Returns the userId when the token is a valid unsubscribe token, else null. */
export async function verifyUnsubscribeToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (payload.purpose !== PURPOSE || typeof payload.sub !== 'string') return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function buildUnsubscribeUrl(userId: string): Promise<string> {
  const token = await createUnsubscribeToken(userId);
  const base = env.API_BASE_URL || 'http://localhost:4000';
  return `${base}/api/v1/auth/unsubscribe-onboarding?token=${encodeURIComponent(token)}`;
}
