import { describe, it, expect } from 'vitest';
import {
  buildAuthorizationUrl,
  connectionAcceptsEmail,
  createPkcePair,
  discoveryUrl,
  emailDomainOf,
  validateEmailDomain,
  validateIssuer,
  verifyIdTokenClaims,
} from './oidc';
import crypto from 'crypto';

const expected = {
  issuer: 'https://acme.okta.com',
  clientId: 'client-123',
  nonce: 'nonce-abc',
  emailDomains: ['acme.com'],
};

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'https://acme.okta.com',
  aud: 'client-123',
  sub: 'okta|42',
  nonce: 'nonce-abc',
  email: 'Dana@Acme.com',
  email_verified: true,
  name: 'Dana Scully',
  ...overrides,
});

const identityOf = (result: ReturnType<typeof verifyIdTokenClaims>) => {
  if ('error' in result) throw new Error(result.error);
  return result.identity;
};
const errorOf = (result: ReturnType<typeof verifyIdTokenClaims>) => ('error' in result ? result.error : null);

describe('discovery and issuer', () => {
  it('finds the configuration document, with or without a trailing slash', () => {
    expect(discoveryUrl('https://acme.okta.com')).toBe('https://acme.okta.com/.well-known/openid-configuration');
    expect(discoveryUrl('https://acme.okta.com/')).toBe('https://acme.okta.com/.well-known/openid-configuration');
  });

  it('accepts an https issuer and refuses the rest', () => {
    expect(validateIssuer('https://acme.okta.com')).toBeNull();
    expect(validateIssuer('https://login.microsoftonline.com/tenant/v2.0')).toBeNull();
    expect(validateIssuer('http://acme.okta.com')).toMatch(/https/);
    expect(validateIssuer('https://localhost')).toMatch(/public host/);
    expect(validateIssuer('https://acme.okta.com?x=1')).toMatch(/query string/);
    expect(validateIssuer('not a url')).toMatch(/must be a URL/);
  });
});

describe('email domains', () => {
  it('takes the part after the last @', () => {
    expect(emailDomainOf('Dana@Acme.com')).toBe('acme.com');
    expect(emailDomainOf('  dana@acme.com  ')).toBe('acme.com');
    expect(emailDomainOf('not-an-email')).toBeNull();
    expect(emailDomainOf('@acme.com')).toBeNull();
    expect(emailDomainOf('dana@')).toBeNull();
  });

  it('refuses a public mailbox provider — anyone has one of those', () => {
    expect(validateEmailDomain('acme.com')).toBeNull();
    expect(validateEmailDomain('eu.acme.co.uk')).toBeNull();
    expect(validateEmailDomain('gmail.com')).toMatch(/public email provider/);
    expect(validateEmailDomain('outlook.com')).not.toBeNull();
    expect(validateEmailDomain('@acme.com')).toMatch(/without the @/);
    expect(validateEmailDomain('acme')).toMatch(/not a domain/);
  });

  it('matches the exact domain only, never a sub-domain', () => {
    const connection = { emailDomains: ['acme.com'] };
    expect(connectionAcceptsEmail(connection, 'dana@acme.com')).toBe(true);
    expect(connectionAcceptsEmail(connection, 'DANA@ACME.COM')).toBe(true);
    expect(connectionAcceptsEmail(connection, 'dana@eu.acme.com')).toBe(false);
    expect(connectionAcceptsEmail(connection, 'dana@acme.com.evil.test')).toBe(false);
    expect(connectionAcceptsEmail(connection, 'dana@notacme.com')).toBe(false);
  });
});

describe('PKCE', () => {
  it('sends the hash and keeps the secret', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toBe(verifier);
    expect(createPkcePair().verifier).not.toBe(verifier);
  });
});

describe('buildAuthorizationUrl', () => {
  const url = () =>
    new URL(
      buildAuthorizationUrl({
        endpoints: { authorization_endpoint: 'https://acme.okta.com/oauth2/v1/authorize?vendor=1' },
        clientId: 'client-123',
        redirectUri: 'https://app.pushify.dev/api/v1/sso/callback',
        state: 'state-xyz',
        nonce: 'nonce-abc',
        codeChallenge: 'challenge',
        loginHint: 'dana@acme.com',
      })
    );

  it('asks for a code, with PKCE and the claims we need', () => {
    const params = url().searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('client-123');
    expect(params.get('redirect_uri')).toBe('https://app.pushify.dev/api/v1/sso/callback');
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('code_challenge')).toBe('challenge');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('state')).toBe('state-xyz');
    expect(params.get('nonce')).toBe('nonce-abc');
    expect(params.get('login_hint')).toBe('dana@acme.com');
  });

  it("keeps a query string the provider's endpoint already had", () => {
    expect(url().searchParams.get('vendor')).toBe('1');
  });
});

describe('verifyIdTokenClaims', () => {
  it('accepts a good token and normalises the address', () => {
    expect(identityOf(verifyIdTokenClaims(claims(), expected))).toEqual({
      subject: 'okta|42',
      email: 'dana@acme.com',
      name: 'Dana Scully',
    });
  });

  it('refuses a token from another provider', () => {
    expect(errorOf(verifyIdTokenClaims(claims({ iss: 'https://evil.okta.com' }), expected))).toMatch(
      /different identity provider/
    );
  });

  it('ignores a trailing slash on the issuer', () => {
    expect(errorOf(verifyIdTokenClaims(claims({ iss: 'https://acme.okta.com/' }), expected))).toBeNull();
  });

  it('refuses a token minted for another application', () => {
    expect(errorOf(verifyIdTokenClaims(claims({ aud: 'someone-else' }), expected))).toMatch(/different application/);
    // An array audience is valid as long as it contains ours
    expect(errorOf(verifyIdTokenClaims(claims({ aud: ['other', 'client-123'] }), expected))).toBeNull();
  });

  it('refuses a token replayed from another login', () => {
    expect(errorOf(verifyIdTokenClaims(claims({ nonce: 'someone-elses-nonce' }), expected))).toMatch(
      /did not match this login/
    );
    expect(errorOf(verifyIdTokenClaims(claims({ nonce: undefined }), expected))).not.toBeNull();
  });

  it('refuses an address the provider has not verified', () => {
    expect(errorOf(verifyIdTokenClaims(claims({ email_verified: false }), expected))).toMatch(/not verified/);
    expect(errorOf(verifyIdTokenClaims(claims({ email_verified: undefined }), expected))).not.toBeNull();
    // Some providers send it as a string
    expect(errorOf(verifyIdTokenClaims(claims({ email_verified: 'true' }), expected))).toBeNull();
  });

  it('refuses an address outside the connection, whatever the provider claims', () => {
    expect(errorOf(verifyIdTokenClaims(claims({ email: 'dana@other.com' }), expected))).toMatch(
      /not in a domain this connection signs in/
    );
    expect(errorOf(verifyIdTokenClaims(claims({ email: 'dana@sub.acme.com' }), expected))).not.toBeNull();
  });

  it('refuses a token with no subject or no email', () => {
    expect(errorOf(verifyIdTokenClaims(claims({ sub: undefined }), expected))).toMatch(/no user id/);
    expect(errorOf(verifyIdTokenClaims(claims({ email: undefined }), expected))).toMatch(/no email address/);
  });

  it('falls back to the username, then to nothing, for a display name', () => {
    expect(identityOf(verifyIdTokenClaims(claims({ name: undefined, preferred_username: 'dana' }), expected)).name).toBe('dana');
    expect(identityOf(verifyIdTokenClaims(claims({ name: undefined }), expected)).name).toBeNull();
  });
});
