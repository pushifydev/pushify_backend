import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { db } from '../db';
import { ssoConnections } from '../db/schema/sso';
import { users } from '../db/schema/users';
import { organizationRepository } from '../repositories/organization.repository';
import { userRepository } from '../repositories/user.repository';
import { encrypt, decrypt } from '../lib/encryption';
import {
  buildAuthorizationUrl,
  connectionAcceptsEmail,
  createPkcePair,
  discoveryUrl,
  emailDomainOf,
  validateEmailDomain,
  validateIssuer,
  verifyIdTokenClaims,
  type OidcEndpoints,
} from '../lib/oidc';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';
import { generateTokenPair, generateTwoFactorToken } from '../lib/jwt';
import { recordAuthEvent } from './auth-event.service';
import { authService } from './auth.service';
import crypto from 'crypto';

/**
 * Sign-in through the organization's own identity provider (OpenID Connect).
 *
 * The organization decides which email domains it owns; a person typing such an address is sent
 * to the provider instead of being asked for a password, and comes back as a member of that
 * organization. With `enforced` on, a password is no longer accepted for those addresses at all —
 * which is the point of buying SSO: when someone leaves, disabling them at the provider is enough.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

type ConnectionRow = typeof ssoConnections.$inferSelect;

export interface PublicSsoConnection {
  id: string;
  issuer: string;
  clientId: string;
  emailDomains: string[];
  enforced: boolean;
  defaultRole: string;
  lastUsedAt: Date | null;
  /** What to enter as the redirect URI at the provider */
  redirectUri: string;
}

/** The provider's configuration, kept briefly so a login is not two round trips every time. */
const discoveryCache = new Map<string, { endpoints: OidcEndpoints; jwks: ReturnType<typeof createRemoteJWKSet>; at: number }>();

export function ssoRedirectUri(): string {
  // Where the provider sends the browser back. It must match what the customer entered at the
  // provider exactly, so it is shown to them with the connection.
  const base = env.API_BASE_URL || `${env.FRONTEND_URL.replace(/\/+$/, '')}`;
  return `${base.replace(/\/+$/, '')}/api/v1/sso/callback`;
}

function toPublic(row: ConnectionRow): PublicSsoConnection {
  return {
    id: row.id,
    issuer: row.issuer,
    clientId: row.clientId,
    emailDomains: row.emailDomains ?? [],
    enforced: row.enforced,
    defaultRole: row.defaultRole,
    lastUsedAt: row.lastUsedAt,
    redirectUri: ssoRedirectUri(),
  };
}

async function loadProvider(issuer: string) {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached;

  const response = await fetch(discoveryUrl(issuer), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new HTTPException(400, { message: `The identity provider did not answer at ${discoveryUrl(issuer)}` });
  }
  const endpoints = (await response.json()) as OidcEndpoints;
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'issuer'] as const) {
    if (typeof endpoints[key] !== 'string') {
      throw new HTTPException(400, { message: `The provider's configuration is missing ${key}` });
    }
  }
  // The document must belong to the issuer it was fetched for, or a redirect could swap providers
  if (endpoints.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
    throw new HTTPException(400, { message: "The provider's configuration is for a different issuer" });
  }

  const entry = { endpoints, jwks: createRemoteJWKSet(new URL(endpoints.jwks_uri)), at: Date.now() };
  discoveryCache.set(issuer, entry);
  return entry;
}

/** The login this callback belongs to, sealed so the browser cannot rewrite it. */
interface LoginState {
  connectionId: string;
  nonce: string;
  verifier: string;
  issuedAt: number;
}

function sealState(state: LoginState): string {
  return Buffer.from(encrypt(JSON.stringify(state)), 'utf8').toString('base64url');
}

function openState(value: string): LoginState | null {
  try {
    const state = JSON.parse(decrypt(Buffer.from(value, 'base64url').toString('utf8'))) as LoginState;
    if (Date.now() - state.issuedAt > STATE_TTL_MS) return null;
    return state;
  } catch {
    return null;
  }
}

async function assertCanManage(organizationId: string, userId: string, locale: SupportedLocale) {
  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  if (membership.role !== 'owner') {
    // Only an owner: a connection decides who gets into the organization
    throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
  }
  return membership;
}

export const ssoService = {
  async get(organizationId: string, userId: string, locale: SupportedLocale = 'en'): Promise<PublicSsoConnection | null> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    const [row] = await db.select().from(ssoConnections).where(eq(ssoConnections.organizationId, organizationId));
    return row ? toPublic(row) : null;
  },

  async save(
    organizationId: string,
    userId: string,
    input: {
      issuer?: string;
      clientId?: string;
      clientSecret?: string;
      emailDomains?: string[];
      enforced?: boolean;
      defaultRole?: string;
    },
    locale: SupportedLocale = 'en'
  ): Promise<PublicSsoConnection> {
    await assertCanManage(organizationId, userId, locale);

    const issuer = (input.issuer ?? '').trim().replace(/\/+$/, '');
    const issuerError = validateIssuer(issuer);
    if (issuerError) throw new HTTPException(400, { message: issuerError });

    const clientId = (input.clientId ?? '').trim();
    if (!clientId) throw new HTTPException(400, { message: 'Client ID is required' });

    const domains = (input.emailDomains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
    if (domains.length === 0) throw new HTTPException(400, { message: 'At least one email domain is required' });
    for (const domain of domains) {
      const problem = validateEmailDomain(domain);
      if (problem) throw new HTTPException(400, { message: problem });
    }

    const defaultRole = input.defaultRole ?? 'member';
    if (!['member', 'admin'].includes(defaultRole)) {
      throw new HTTPException(400, { message: 'Default role must be member or admin' });
    }

    const [existing] = await db.select().from(ssoConnections).where(eq(ssoConnections.organizationId, organizationId));
    if (!existing && !input.clientSecret) {
      throw new HTTPException(400, { message: 'Client secret is required' });
    }

    // A domain another organization already signs in would make sign-in ambiguous
    const others = await db.select().from(ssoConnections);
    for (const other of others) {
      if (other.organizationId === organizationId) continue;
      const clash = domains.find((domain) => (other.emailDomains ?? []).includes(domain));
      if (clash) throw new HTTPException(400, { message: `${clash} is already used for SSO by another organization` });
    }

    // The provider has to exist and answer before this is stored, or the first person to try
    // signing in is the one who finds out it does not
    await loadProvider(issuer);

    const values = {
      organizationId,
      issuer,
      clientId,
      emailDomains: domains,
      enforced: input.enforced ?? existing?.enforced ?? false,
      defaultRole,
      updatedAt: new Date(),
      ...(input.clientSecret ? { clientSecretEncrypted: encrypt(input.clientSecret) } : {}),
    };

    const [row] = existing
      ? await db.update(ssoConnections).set(values).where(eq(ssoConnections.id, existing.id)).returning()
      : await db
          .insert(ssoConnections)
          .values({ ...values, clientSecretEncrypted: encrypt(input.clientSecret!) })
          .returning();

    logger.info({ organizationId, issuer }, 'SSO connection saved');
    return toPublic(row);
  },

  async remove(organizationId: string, userId: string, locale: SupportedLocale = 'en') {
    await assertCanManage(organizationId, userId, locale);
    await db.delete(ssoConnections).where(eq(ssoConnections.organizationId, organizationId));
    return { success: true };
  },

  /** The connection that signs in this address, if any. Used by the login form and by the gate. */
  async connectionForEmail(email: string): Promise<ConnectionRow | null> {
    const domain = emailDomainOf(email);
    if (!domain) return null;
    const rows = await db.select().from(ssoConnections);
    return rows.find((row) => (row.emailDomains ?? []).includes(domain)) ?? null;
  },

  /** Does this address have to use SSO? Checked by the password login. */
  async isPasswordLoginBlocked(email: string): Promise<boolean> {
    const connection = await this.connectionForEmail(email);
    return !!connection?.enforced;
  },

  /** Step one: where to send the browser. */
  async start(email: string): Promise<{ url: string }> {
    const connection = await this.connectionForEmail(email);
    if (!connection) {
      throw new HTTPException(404, { message: 'No single sign-on is set up for that email domain' });
    }
    const { endpoints } = await loadProvider(connection.issuer);
    const { verifier, challenge } = createPkcePair();
    const nonce = crypto.randomBytes(16).toString('base64url');

    return {
      url: buildAuthorizationUrl({
        endpoints,
        clientId: connection.clientId,
        redirectUri: ssoRedirectUri(),
        state: sealState({ connectionId: connection.id, nonce, verifier, issuedAt: Date.now() }),
        nonce,
        codeChallenge: challenge,
        loginHint: email,
      }),
    };
  },

  /**
   * Step two: the provider sent the browser back with a code. Exchange it, check the token says
   * what it must, and sign the person in as a member of the organization.
   */
  async complete(
    code: string,
    rawState: string,
    context: { ipAddress?: string; userAgent?: string; locale?: SupportedLocale } = {}
  ) {
    const state = openState(rawState);
    if (!state) throw new HTTPException(400, { message: 'This sign-in link has expired — start again' });

    const [connection] = await db.select().from(ssoConnections).where(eq(ssoConnections.id, state.connectionId));
    if (!connection) throw new HTTPException(400, { message: 'That single sign-on connection no longer exists' });

    const { endpoints, jwks } = await loadProvider(connection.issuer);

    const tokenResponse = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ssoRedirectUri(),
        client_id: connection.clientId,
        client_secret: decrypt(connection.clientSecretEncrypted),
        code_verifier: state.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenBody = (await tokenResponse.json().catch(() => null)) as { id_token?: string; error_description?: string; error?: string } | null;
    if (!tokenResponse.ok || !tokenBody?.id_token) {
      const reason = tokenBody?.error_description || tokenBody?.error || `HTTP ${tokenResponse.status}`;
      logger.warn({ issuer: connection.issuer, reason }, 'SSO token exchange failed');
      throw new HTTPException(400, { message: `The identity provider refused the sign-in: ${reason}` });
    }

    // The signature, and then the claims. Both, in that order — decoding without verifying is
    // how a forged token gets in.
    let claims: Record<string, unknown>;
    try {
      const verified = await jwtVerify(tokenBody.id_token, jwks, {
        issuer: endpoints.issuer,
        audience: connection.clientId,
      });
      claims = verified.payload as Record<string, unknown>;
    } catch (err) {
      logger.warn({ err, issuer: connection.issuer }, 'SSO id token failed verification');
      throw new HTTPException(400, { message: 'The sign-in could not be verified' });
    }

    const checked = verifyIdTokenClaims(claims, {
      issuer: connection.issuer,
      clientId: connection.clientId,
      nonce: state.nonce,
      emailDomains: connection.emailDomains ?? [],
    });
    if ('error' in checked) throw new HTTPException(400, { message: checked.error });
    const identity = checked.identity;

    return await this.signIn(connection, identity.email, identity.name, context);
  },

  /** The account behind a verified identity — created on first sign-in, joined to the organization. */
  async signIn(
    connection: ConnectionRow,
    email: string,
    name: string | null,
    context: { ipAddress?: string; userAgent?: string; locale?: SupportedLocale } = {}
  ) {
    let user = await userRepository.findByEmail(email);
    let isNewUser = false;

    const reload = async (id: string) => {
      const found = await userRepository.findById(id);
      if (!found) throw new HTTPException(500, { message: 'The account could not be read back after sign-in' });
      return found;
    };

    if (!user) {
      const created = await userRepository.create({
        email,
        passwordHash: null,
        name: name || email.split('@')[0],
      });
      // The provider vouched for the address, so there is nothing left to verify
      await db.update(users).set({ emailVerified: true, emailVerifiedAt: new Date() }).where(eq(users.id, created.id));
      user = await reload(created.id);
      isNewUser = true;
    } else if (!user.emailVerified) {
      await db.update(users).set({ emailVerified: true, emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
      user = await reload(user.id);
    }

    // Join the organization the provider belongs to, if not already a member
    const membership = await organizationRepository.findMember(connection.organizationId, user.id);
    if (!membership) {
      await organizationRepository.addMember({
        organizationId: connection.organizationId,
        userId: user.id,
        role: connection.defaultRole as 'member' | 'admin',
      });
      logger.info({ userId: user.id, organizationId: connection.organizationId }, 'SSO added a member');
    }

    await db
      .update(ssoConnections)
      .set({ lastUsedAt: new Date() })
      .where(eq(ssoConnections.id, connection.id))
      .catch(() => undefined);

    // 2FA still applies. SSO says which person this is; a second factor the organization asked
    // for is not something the provider can waive.
    if (user.twoFactorEnabled) {
      const twoFactorToken = await generateTwoFactorToken(user.id, connection.organizationId);
      recordAuthEvent({ userId: user.id, event: 'two_factor_required', method: 'sso', ipAddress: context.ipAddress, userAgent: context.userAgent });
      return { requiresTwoFactor: true as const, twoFactorToken };
    }

    const tokens = await generateTokenPair(user.id, connection.organizationId);
    await authService.createSession(user.id, tokens.refreshToken, context.ipAddress, context.userAgent);
    recordAuthEvent({
      userId: user.id,
      event: isNewUser ? 'register' : 'login',
      method: 'sso',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return {
      requiresTwoFactor: false as const,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
      organizationId: connection.organizationId,
    };
  },
};
