import crypto from 'crypto';

/**
 * Single sign-on over OpenID Connect.
 *
 * SAML is what "enterprise SSO" is usually called, but every identity provider a customer is
 * likely to bring — Okta, Entra ID, Google Workspace, Auth0, Keycloak — speaks OIDC as well, and
 * OIDC can be verified with the JWT library already here rather than with hand-written XML
 * signature checking, which is where SAML implementations go wrong.
 *
 * This module is the part with no I/O: what to send the provider, and what an answer has to
 * satisfy before it is believed.
 */

export interface OidcConnection {
  /** The provider's issuer URL, exactly as it appears in `iss` */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Email domains that sign in through this connection, lower-case, no `@` */
  emailDomains: string[];
}

export interface OidcEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

/** Where a provider publishes its configuration. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/** An issuer we are willing to talk to: https, a host, no query or fragment. */
export function validateIssuer(issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'Issuer must be a URL, e.g. https://acme.okta.com';
  }
  if (url.protocol !== 'https:') return 'Issuer must use https';
  if (url.search || url.hash) return 'Issuer must not have a query string or fragment';
  if (!url.hostname.includes('.')) return 'Issuer must be a public host name';
  return null;
}

/** Domains are matched against the part after `@`, so that is all they may be. */
export function validateEmailDomain(domain: string): string | null {
  const value = domain.trim().toLowerCase();
  if (!value) return 'Domain is required';
  if (value.includes('@')) return 'Enter the domain only, without the @';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    return `"${domain}" is not a domain name`;
  }
  // A public mailbox domain would let anyone with a Gmail address into the organization
  if (PUBLIC_EMAIL_DOMAINS.has(value)) return `${value} is a public email provider and cannot be used for SSO`;
  return null;
}

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'yandex.com',
  'mail.ru',
  'hotmail.co.uk',
  'yahoo.co.uk',
]);

/** The domain part of an address, lower-case, or null when it is not an address. */
export function emailDomainOf(email: string): string | null {
  const at = email.trim().toLowerCase().lastIndexOf('@');
  if (at <= 0 || at === email.trim().length - 1) return null;
  return email.trim().toLowerCase().slice(at + 1);
}

/** Does this address belong to a connection? Sub-domains do not count — `@eu.acme.com` is not `acme.com`. */
export function connectionAcceptsEmail(connection: Pick<OidcConnection, 'emailDomains'>, email: string): boolean {
  const domain = emailDomainOf(email);
  return !!domain && connection.emailDomains.map((d) => d.toLowerCase()).includes(domain);
}

/** PKCE: a secret this side keeps, and the challenge the provider is given. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizationRequest {
  endpoints: Pick<OidcEndpoints, 'authorization_endpoint'>;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** Pre-fills the provider's form with the address the user typed */
  loginHint?: string;
}

/** Where to send the browser. PKCE is always used, even with a client secret. */
export function buildAuthorizationUrl(request: AuthorizationRequest): string {
  const url = new URL(request.endpoints.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: 'openid email profile',
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
  };
  if (request.loginHint) params.login_hint = request.loginHint;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  preferred_username?: unknown;
  [key: string]: unknown;
}

export interface VerifiedIdentity {
  subject: string;
  email: string;
  name: string | null;
}

/**
 * What an id token has to say before the person behind it is signed in. The signature is checked
 * by the caller against the provider's JWKS; these are the claims that decide *who* it is, and
 * getting any of them wrong is how an SSO login becomes an account takeover:
 *
 * - `iss` must be the configured issuer, or another provider's token would be accepted.
 * - `aud` must contain our client id, or a token minted for a different application would be.
 * - `nonce` must be the one from this login, or a token captured elsewhere could be replayed.
 * - the email must be verified *by the provider*, or a user who set an unverified address to
 *   someone else's could sign in as them.
 * - the email's domain must belong to the connection, or an Okta tenant could mint a token for
 *   any address at all and walk into the organization.
 */
export function verifyIdTokenClaims(
  claims: IdTokenClaims,
  expect: { issuer: string; clientId: string; nonce: string; emailDomains: string[] }
): { identity: VerifiedIdentity } | { error: string } {
  const issuer = typeof claims.iss === 'string' ? claims.iss.replace(/\/+$/, '') : '';
  if (issuer !== expect.issuer.replace(/\/+$/, '')) {
    return { error: 'The sign-in came from a different identity provider than the one configured' };
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? '')];
  if (!audiences.includes(expect.clientId)) {
    return { error: 'The sign-in was issued for a different application' };
  }

  if (typeof claims.nonce !== 'string' || claims.nonce !== expect.nonce) {
    return { error: 'The sign-in did not match this login attempt' };
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  if (!subject) return { error: 'The identity provider sent no user id' };

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) return { error: 'The identity provider sent no email address — the connection needs the email scope' };

  // Providers send this as a boolean or, less often, as the string "true"
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!verified) return { error: `${email} is not verified with the identity provider` };

  if (!connectionAcceptsEmail({ emailDomains: expect.emailDomains }, email)) {
    return { error: `${email} is not in a domain this connection signs in` };
  }

  const name =
    (typeof claims.name === 'string' && claims.name.trim()) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username.trim()) ||
    null;

  return { identity: { subject, email, name } };
}
