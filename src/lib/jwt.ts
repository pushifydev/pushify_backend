import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env';

export interface TokenPayload extends JWTPayload {
  sub: string; // user id
  org?: string; // organization id
  type: 'access' | 'refresh' | 'twoFactor';
}

const secret = new TextEncoder().encode(env.JWT_SECRET);

// Parse duration string to seconds (e.g., "15m" -> 900, "7d" -> 604800)
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      throw new Error(`Invalid duration unit: ${unit}`);
  }
}

export async function generateAccessToken(userId: string, organizationId?: string): Promise<string> {
  const expiresIn = parseDuration(env.JWT_EXPIRES_IN);

  const token = await new SignJWT({
    sub: userId,
    org: organizationId,
    type: 'access',
  } satisfies TokenPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .setIssuer('pushify')
    .sign(secret);

  return token;
}

export async function generateRefreshToken(userId: string): Promise<string> {
  const expiresIn = parseDuration(env.REFRESH_TOKEN_EXPIRES_IN);

  const token = await new SignJWT({
    sub: userId,
    type: 'refresh',
  } satisfies TokenPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .setIssuer('pushify')
    .sign(secret);

  return token;
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: 'pushify',
    });

    return payload as TokenPayload;
  } catch {
    throw new Error('Invalid or expired token');
  }
}

export async function generateTokenPair(
  userId: string,
  organizationId?: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const [accessToken, refreshToken] = await Promise.all([
    generateAccessToken(userId, organizationId),
    generateRefreshToken(userId),
  ]);

  return { accessToken, refreshToken };
}

/**
 * Generate a short-lived token for 2FA verification
 * This token is issued after password verification but before 2FA is complete
 */
export async function generateTwoFactorToken(userId: string, organizationId?: string): Promise<string> {
  const token = await new SignJWT({
    sub: userId,
    org: organizationId,
    type: 'twoFactor',
  } satisfies TokenPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m') // 5 minutes to complete 2FA
    .setIssuer('pushify')
    .sign(secret);

  return token;
}

/**
 * Verify a 2FA token and return the payload
 */
export async function verifyTwoFactorToken(token: string): Promise<TokenPayload> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: 'pushify',
    });

    const tokenPayload = payload as TokenPayload;
    if (tokenPayload.type !== 'twoFactor') {
      throw new Error('Invalid token type');
    }

    return tokenPayload;
  } catch {
    throw new Error('Invalid or expired 2FA token');
  }
}
