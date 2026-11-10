import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env';
import { passkeyRepository } from '../repositories/passkey.repository';
import { userRepository } from '../repositories/user.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { generateTokenPair, generateTwoFactorToken } from '../lib/jwt';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';
import { recordAuthEvent } from './auth-event.service';
import { authService } from './auth.service';
import { webauthnChallengeStore } from '../lib/webauthn-challenge-store';
import {
  SUPPORTED_COSE_ALGORITHMS,
  WebAuthnError,
  fromBase64Url,
  generateChallenge,
  normalizeCredentialId,
  readClientDataChallenge,
  toBase64Url,
  userHandleFor,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationCredential,
  type RegistrationCredential,
} from '../lib/webauthn';
import type { Passkey } from '../db/schema/passkeys';

/**
 * Passkeys: register a WebAuthn credential on your own account, sign in with it, list and remove
 * them. A passkey replaces the password, nothing more:
 *  - enforced SSO still wins: an address under an enforced connection is refused, as the password
 *    and OAuth logins are (authService.assertSsoNotEnforced);
 *  - an account with TOTP still answers the second factor after the passkey (POST /auth/login/2fa),
 *    as after OAuth and SSO;
 *  - the organization 2FA policy is unchanged: it looks at TOTP only (lib/org-two-factor), so a
 *    passkey session of a member without TOTP is refused there like any other session.
 */

const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PASSKEYS_PER_USER = 20;
const AUTHENTICATION_SUBJECT = 'sign-in';
const KNOWN_TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

export interface WebAuthnRelyingParty {
  rpId: string;
  rpName: string;
  origins: string[];
}

export function relyingParty(): WebAuthnRelyingParty {
  const frontend = new URL(env.FRONTEND_URL);
  const origins = env.WEBAUTHN_ORIGINS?.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return {
    rpId: env.WEBAUTHN_RP_ID?.trim() || frontend.hostname,
    rpName: 'Pushify',
    origins: origins?.length ? origins : [frontend.origin],
  };
}

export interface PublicPasskey {
  id: string;
  name: string;
  transports: string[];
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

function toPublic(row: Passkey): PublicPasskey {
  return {
    id: row.id,
    name: row.name,
    transports: row.transports ?? [],
    backedUp: row.backedUp,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

/** What POST /auth/login answers: a session, or the second-factor step. */
export type PasskeyLoginResult =
  | { requiresTwoFactor: true; twoFactorToken: string }
  | {
      user: { id: string; email: string; name: string; avatarUrl: string | null; emailVerified: boolean; twoFactorEnabled: boolean };
      organization: { id: string; name: string; slug: string };
      accessToken: string;
      refreshToken: string;
    };

export const passkeyService = {
  /**
   * Step one of adding a passkey. Adding a way to sign in is a sensitive action: the password (or,
   * without one, a TOTP/backup code) is asked again, as for disabling 2FA — a stolen access token
   * alone must not be able to plant a lasting way in. An OAuth-only account with no 2FA has nothing
   * to confirm with; its session is the proof, as when it sets its first password.
   */
  async registrationOptions(
    userId: string,
    credentials: { password?: string; twoFactorCode?: string },
    locale: SupportedLocale = 'en'
  ) {
    const user = await userRepository.findById(userId);
    if (!user) throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });

    // A member of an enforced-SSO domain signs in through the provider only: no passkey either
    await authService.assertSsoNotEnforced(user.email);

    if (user.passwordHash || user.twoFactorEnabled) {
      const { twoFactorService } = await import('./twoFactor.service');
      await twoFactorService.verifyIdentityForSensitiveAction(userId, credentials, locale);
    }

    const existing = await passkeyRepository.findByUserId(userId);
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new HTTPException(400, { message: t(locale, 'passkey', 'limitReached') });
    }

    const rp = relyingParty();
    const challenge = generateChallenge();
    await webauthnChallengeStore().save('registration', challenge, userId, CEREMONY_TIMEOUT_MS);

    return {
      challenge,
      rp: { id: rp.rpId, name: rp.rpName },
      user: { id: userHandleFor(user.id), name: user.email, displayName: user.name },
      pubKeyCredParams: SUPPORTED_COSE_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
      timeout: CEREMONY_TIMEOUT_MS,
      attestation: 'none' as const,
      // The browser refuses to create a second passkey on an authenticator that already has one
      excludeCredentials: existing.map((p) => ({
        type: 'public-key' as const,
        id: p.credentialId,
        ...(p.transports?.length ? { transports: p.transports } : {}),
      })),
      authenticatorSelection: {
        residentKey: 'required' as const,
        requireResidentKey: true as const,
        userVerification: 'required' as const,
      },
    };
  },

  /** Step two of adding a passkey: check what the authenticator created and store it. */
  async verifyRegistration(
    userId: string,
    input: { credential: RegistrationCredential & { response: { transports?: string[] } }; name?: string },
    locale: SupportedLocale = 'en',
    context: RequestContext = {}
  ): Promise<PublicPasskey> {
    const { credential } = input;
    const challenge = readClientDataChallenge(credential.response.clientDataJSON);
    const issuedTo = challenge ? await webauthnChallengeStore().take('registration', challenge) : null;
    if (!challenge || issuedTo !== userId) {
      throw new HTTPException(400, { message: t(locale, 'passkey', 'challengeExpired') });
    }

    const rp = relyingParty();
    let verified;
    try {
      verified = verifyRegistrationResponse(credential, {
        challenge,
        origins: rp.origins,
        rpId: rp.rpId,
        requireUserVerification: true,
      });
    } catch (err) {
      if (!(err instanceof WebAuthnError)) throw err;
      logger.warn({ userId, reason: err.message }, 'Passkey registration refused');
      throw new HTTPException(400, { message: t(locale, 'passkey', 'verificationFailed') });
    }

    if (await passkeyRepository.findByCredentialId(verified.credentialId)) {
      throw new HTTPException(409, { message: t(locale, 'passkey', 'alreadyRegistered') });
    }
    if ((await passkeyRepository.countByUserId(userId)) >= MAX_PASSKEYS_PER_USER) {
      throw new HTTPException(400, { message: t(locale, 'passkey', 'limitReached') });
    }

    const row = await passkeyRepository.create({
      userId,
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      algorithm: verified.algorithm,
      signCount: verified.signCount,
      transports: (credential.response.transports ?? []).filter((tr) => KNOWN_TRANSPORTS.has(tr)),
      aaguid: verified.aaguid,
      backupEligible: verified.backupEligible,
      backedUp: verified.backedUp,
      name: input.name?.trim() || 'Passkey',
    });

    recordAuthEvent({ userId, event: 'passkey_added', method: 'passkey', ...context });
    logger.info({ userId, passkeyId: row.id }, 'Passkey registered');
    return toPublic(row);
  },

  /** Step one of signing in. No email: the authenticator offers the passkeys it holds for this site. */
  async authenticationOptions() {
    const rp = relyingParty();
    const challenge = generateChallenge();
    await webauthnChallengeStore().save('authentication', challenge, AUTHENTICATION_SUBJECT, CEREMONY_TIMEOUT_MS);
    return {
      challenge,
      rpId: rp.rpId,
      timeout: CEREMONY_TIMEOUT_MS,
      userVerification: 'required' as const,
      allowCredentials: [] as { type: 'public-key'; id: string }[],
    };
  },

  /**
   * Step two of signing in: the same result as a password login — tokens and a session, or the
   * second-factor token when the account has TOTP.
   */
  async verifyAuthentication(
    credential: AuthenticationCredential & { response: { userHandle?: string | null } },
    locale: SupportedLocale = 'en',
    context: RequestContext = {}
  ): Promise<PasskeyLoginResult> {
    const { ipAddress, userAgent } = context;
    const challenge = readClientDataChallenge(credential.response.clientDataJSON);
    const issued = challenge ? await webauthnChallengeStore().take('authentication', challenge) : null;
    if (!challenge || issued !== AUTHENTICATION_SUBJECT) {
      throw new HTTPException(400, { message: t(locale, 'passkey', 'challengeExpired') });
    }

    const invalid = () => new HTTPException(401, { message: t(locale, 'passkey', 'invalidCredential') });

    let credentialId: string;
    try {
      credentialId = normalizeCredentialId(credential.rawId);
    } catch {
      throw invalid();
    }
    const passkey = await passkeyRepository.findByCredentialId(credentialId);
    if (!passkey) throw invalid();
    const user = await userRepository.findById(passkey.userId);
    if (!user) throw invalid();

    const rp = relyingParty();
    let result;
    try {
      // Nobody was named before the ceremony, so the authenticator must say whose passkey it is
      const handle = credential.response.userHandle;
      if (!handle || toBase64Url(fromBase64Url(handle, 'userHandle')) !== userHandleFor(user.id)) {
        throw new WebAuthnError('User handle does not match the credential');
      }
      result = verifyAuthenticationResponse(
        credential,
        { challenge, origins: rp.origins, rpId: rp.rpId, requireUserVerification: true },
        { credentialId: passkey.credentialId, publicKey: passkey.publicKey, signCount: passkey.signCount }
      );
    } catch (err) {
      if (!(err instanceof WebAuthnError)) throw err;
      logger.warn({ userId: user.id, passkeyId: passkey.id, reason: err.message }, 'Passkey sign-in refused');
      recordAuthEvent({ userId: user.id, event: 'login_failed', method: 'passkey', ipAddress, userAgent });
      throw invalid();
    }

    await passkeyRepository.markUsed(passkey.id, result.signCount, result.backedUp);

    // Checked after the signature, so only the passkey's holder learns the account is under SSO
    try {
      await authService.assertSsoNotEnforced(user.email);
    } catch (err) {
      recordAuthEvent({ userId: user.id, event: 'login_failed', method: 'passkey', ipAddress, userAgent });
      throw err;
    }

    const membership = await organizationRepository.findUserFirstOrganization(user.id);
    if (!membership) throw new HTTPException(500, { message: t(locale, 'auth', 'noOrganization') });

    if (user.twoFactorEnabled) {
      const twoFactorToken = await generateTwoFactorToken(user.id, membership.organization.id);
      recordAuthEvent({ userId: user.id, event: 'two_factor_required', method: 'passkey', ipAddress, userAgent });
      return { requiresTwoFactor: true as const, twoFactorToken };
    }

    const tokens = await generateTokenPair(user.id, membership.organization.id);
    // Refuses banned accounts and accounts waiting to be deleted, as for every other sign-in
    await authService.createSession(user.id, tokens.refreshToken, ipAddress, userAgent, locale);
    recordAuthEvent({ userId: user.id, event: 'login', method: 'passkey', ipAddress, userAgent });
    logger.info({ userId: user.id, passkeyId: passkey.id }, 'User logged in with a passkey');

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
      },
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  },

  async list(userId: string): Promise<PublicPasskey[]> {
    return (await passkeyRepository.findByUserId(userId)).map(toPublic);
  },

  async remove(userId: string, passkeyId: string, locale: SupportedLocale = 'en', context: RequestContext = {}) {
    const deleted = await passkeyRepository.deleteForUser(passkeyId, userId);
    if (deleted === 0) throw new HTTPException(404, { message: t(locale, 'passkey', 'notFound') });
    recordAuthEvent({ userId, event: 'passkey_removed', method: 'passkey', ...context });
    logger.info({ userId, passkeyId }, 'Passkey removed');
    return { message: t(locale, 'passkey', 'removed') };
  },
};
