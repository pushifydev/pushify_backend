import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * An organization's SSO connection may only sign in addresses in domains it has proven it owns
 * (a TXT record at `_pushify-verify.<domain>`). Typing a domain into the form is not proof, and
 * neither is the provider's `email_verified` — the provider is one the same customer chose.
 *
 * The attack this guards against: someone configures their own OIDC server for `acme.com`, it
 * returns `email_verified: true` for victim@acme.com, and they are signed in as the victim.
 */

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  txt: new Map<string, string[][]>(),
  claims: {} as Record<string, unknown>,
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: (column: { name: string }, value: unknown) => ({ column: column.name, value }) };
});

vi.mock('../db', async () => {
  const { ssoConnections } = await import('../db/schema/sso');
  const field = (column: string) => (column === 'organization_id' ? 'organizationId' : column);
  const matches = (cond: { column: string; value: unknown }) => (row: Record<string, unknown>) =>
    row[field(cond.column)] === cond.value;
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          const all = table === ssoConnections ? state.rows : [];
          return Object.assign(Promise.resolve([...all]), {
            where: async (cond: { column: string; value: unknown }) => all.filter(matches(cond)),
          });
        },
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: { column: string; value: unknown }) => {
            const updated =
              table === ssoConnections
                ? state.rows.filter(matches(cond)).map((row) => Object.assign(row, values))
                : [];
            return Object.assign(Promise.resolve(updated), { returning: async () => updated });
          },
        }),
      }),
    },
  };
});

vi.mock('dns', () => ({
  promises: {
    resolveTxt: vi.fn(async (name: string) => {
      const records = state.txt.get(name);
      if (!records) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
      return records;
    }),
  },
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async () => ({ payload: state.claims }),
}));

const signedIn = vi.hoisted(() => ({ generateTokenPair: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r' })) }));
vi.mock('../lib/jwt', () => ({
  generateTokenPair: signedIn.generateTokenPair,
  generateTwoFactorToken: vi.fn(async () => '2fa'),
}));

vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: {
    findMember: vi.fn(async () => ({ role: 'owner' })),
    addMember: vi.fn(async () => undefined),
  },
}));

vi.mock('../repositories/user.repository', () => ({
  userRepository: {
    findByEmail: vi.fn(async (email: string) => ({
      id: `user-${email}`,
      email,
      name: email,
      emailVerified: true,
      twoFactorEnabled: false,
    })),
    findById: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('./auth.service', () => ({ authService: { createSession: vi.fn(async () => undefined) } }));
vi.mock('./auth-event.service', () => ({ recordAuthEvent: vi.fn() }));

import { ssoService } from './sso.service';
import { encrypt } from '../lib/encryption';

const ISSUER = 'https://idp.attacker.example';

function connection(domainVerifications: Record<string, { token: string; verifiedAt: string | null }>) {
  return {
    id: 'conn-1',
    organizationId: 'org-1',
    issuer: ISSUER,
    clientId: 'client-1',
    clientSecretEncrypted: encrypt('secret'),
    emailDomains: Object.keys(domainVerifications),
    domainVerifications,
    enforced: true,
    defaultRole: 'member',
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof HTTPException ? { status: err.status, message: err.message } : { status: 0, message: String(err) };
  }
};

beforeEach(() => {
  state.rows = [];
  state.txt = new Map();
  state.claims = {};
  signedIn.generateTokenPair.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
          })
        );
      }
      return new Response(JSON.stringify({ id_token: 'signed.by.attacker' }));
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function addConnection(domainVerifications: Record<string, { token: string; verifiedAt: string | null }>) {
  const row = connection(domainVerifications);
  state.rows.push(row);
  return row;
}

/** Start a login, then come back from the provider with `email`. */
async function signInThroughProvider(startEmail: string, email: string) {
  const { url } = await ssoService.start(startEmail);
  const params = new URL(url).searchParams;
  state.claims = {
    iss: ISSUER,
    aud: 'client-1',
    sub: 'attacker|1',
    nonce: params.get('nonce'),
    email,
    email_verified: true,
  };
  return ssoService.complete('code', params.get('state')!);
}

describe('a pending (unverified) domain', () => {
  it('does not route the login form to the provider, and is not enforced', async () => {
    addConnection({ 'acme.com': { token: 'tok', verifiedAt: null } });
    expect(await ssoService.connectionForEmail('victim@acme.com')).toBeNull();
    expect(await ssoService.isPasswordLoginBlocked('victim@acme.com')).toBe(false);
    expect((await refusal(() => ssoService.start('victim@acme.com')))?.status).toBe(404);
  });

  it("refuses a provider's token for an address in it, even with email_verified — no account takeover", async () => {
    // The attacker proved a domain of their own, and claimed acme.com without proving it
    addConnection({
      'attacker.example': { token: 'a', verifiedAt: '2026-01-01T00:00:00.000Z' },
      'acme.com': { token: 'b', verifiedAt: null },
    });

    const result = await refusal(() => signInThroughProvider('me@attacker.example', 'victim@acme.com'));
    expect(result?.status).toBe(400);
    expect(result?.message).toMatch(/not in a domain this connection signs in/);
    expect(signedIn.generateTokenPair).not.toHaveBeenCalled();
  });

  it('does not keep the real owner from claiming the domain', async () => {
    addConnection({ 'acme.com': { token: 'squatter', verifiedAt: null } });
    state.rows[0].organizationId = 'org-squatter';
    state.rows[0].id = 'conn-squatter';
    const owner = addConnection({ 'acme.com': { token: 'owner', verifiedAt: null } });
    state.txt.set('_pushify-verify.acme.com', [['pushify-verify=owner']]);

    const result = await ssoService.verifyDomain('org-1', 'user-1', 'acme.com');
    expect(result.domains[0]).toMatchObject({ domain: 'acme.com', status: 'verified' });
    expect(owner.domainVerifications['acme.com'].verifiedAt).not.toBeNull();
  });
});

describe('a verified domain', () => {
  it('signs the person in', async () => {
    addConnection({ 'acme.com': { token: 'tok', verifiedAt: '2026-01-01T00:00:00.000Z' } });
    expect(await ssoService.isPasswordLoginBlocked('dana@acme.com')).toBe(true);

    const result = await signInThroughProvider('dana@acme.com', 'dana@acme.com');
    expect(result).toMatchObject({ requiresTwoFactor: false, organizationId: 'org-1' });
    expect(signedIn.generateTokenPair).toHaveBeenCalledOnce();
  });
});

describe('verifyDomain', () => {
  it('refuses until the TXT record carries the token', async () => {
    const row = addConnection({ 'acme.com': { token: 'tok', verifiedAt: null } });

    const missing = await refusal(() => ssoService.verifyDomain('org-1', 'user-1', 'acme.com'));
    expect(missing?.status).toBe(400);
    expect(missing?.message).toMatch(/_pushify-verify\.acme\.com/);

    state.txt.set('_pushify-verify.acme.com', [['pushify-verify=wrong']]);
    expect((await refusal(() => ssoService.verifyDomain('org-1', 'user-1', 'acme.com')))?.status).toBe(400);
    expect(row.domainVerifications['acme.com'].verifiedAt).toBeNull();

    state.txt.set('_pushify-verify.acme.com', [['pushify-verify=tok']]);
    const result = await ssoService.verifyDomain('org-1', 'user-1', 'ACME.com');
    expect(result.domains[0].status).toBe('verified');
    expect(await ssoService.connectionForEmail('dana@acme.com')).not.toBeNull();
  });

  it('refuses a domain that is not on the connection', async () => {
    addConnection({ 'acme.com': { token: 'tok', verifiedAt: null } });
    expect((await refusal(() => ssoService.verifyDomain('org-1', 'user-1', 'other.com')))?.status).toBe(400);
  });

  it('refuses a domain another organization has already proven', async () => {
    addConnection({ 'acme.com': { token: 'first', verifiedAt: '2026-01-01T00:00:00.000Z' } });
    state.rows[0].organizationId = 'org-first';
    state.rows[0].id = 'conn-first';
    addConnection({ 'acme.com': { token: 'second', verifiedAt: null } });
    state.txt.set('_pushify-verify.acme.com', [['pushify-verify=second']]);

    expect((await refusal(() => ssoService.verifyDomain('org-1', 'user-1', 'acme.com')))?.status).toBe(409);
  });
});
