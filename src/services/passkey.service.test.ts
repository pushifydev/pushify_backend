import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { HTTPException } from 'hono/http-exception';

/**
 * Passkeys end to end through the real WebAuthn verifier: a fake authenticator below creates real
 * key pairs and signs real CBOR / clientDataJSON, so registration and sign-in are checked as a
 * browser would drive them. Only storage, the session store and the SSO lookup are replaced.
 */

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  user: null as Record<string, unknown> | null,
  sso: vi.fn(),
  identity: vi.fn(),
  createSession: vi.fn(),
  record: vi.fn(),
  firstOrg: vi.fn(),
}));

vi.mock('../db', () => ({ db: {} }));
vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('./auth-event.service', () => ({ recordAuthEvent: h.record }));
vi.mock('./auth.service', () => ({
  authService: { assertSsoNotEnforced: h.sso, createSession: h.createSession },
}));
vi.mock('./twoFactor.service', () => ({ twoFactorService: { verifyIdentityForSensitiveAction: h.identity } }));
vi.mock('../repositories/user.repository', () => ({
  userRepository: { findById: async (id: string) => (h.user && h.user.id === id ? h.user : undefined) },
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findUserFirstOrganization: h.firstOrg },
}));
vi.mock('../repositories/passkey.repository', () => ({
  passkeyRepository: {
    findByUserId: async (userId: string) => h.rows.filter((r) => r.userId === userId),
    countByUserId: async (userId: string) => h.rows.filter((r) => r.userId === userId).length,
    findByCredentialId: async (credentialId: string) => h.rows.find((r) => r.credentialId === credentialId),
    create: async (input: Record<string, unknown>) => {
      const row = { ...input, id: crypto.randomUUID(), createdAt: new Date(), lastUsedAt: null };
      h.rows.push(row);
      return row;
    },
    markUsed: async (id: string, signCount: number, backedUp: boolean) => {
      const row = h.rows.find((r) => r.id === id);
      if (row) Object.assign(row, { signCount, backedUp, lastUsedAt: new Date() });
    },
    deleteForUser: async (id: string, userId: string) => {
      const before = h.rows.length;
      h.rows = h.rows.filter((r) => !(r.id === id && r.userId === userId));
      return before - h.rows.length;
    },
  },
}));

import { passkeyService } from './passkey.service';
import { verifyToken } from '../lib/jwt';
import {
  decodeCbor,
  parseAuthenticatorData,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  WebAuthnError,
} from '../lib/webauthn';

// The relying party the service derives from FRONTEND_URL's default (http://localhost:3000)
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const USER_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const ORG = { id: 'org-1', name: 'Acme', slug: 'acme' };

// ── A fake authenticator ──

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([cborHead(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([cborHead(4, v.length), ...v.map(cbor)]);
  return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

function fakeAuthenticator(kind: 'es256' | 'ed25519' | 'rs256' = 'es256') {
  const pair =
    kind === 'es256'
      ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : kind === 'ed25519'
        ? crypto.generateKeyPairSync('ed25519')
        : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const raw = (s?: string) => Buffer.from(s!, 'base64url');
  const cose =
    kind === 'es256'
      ? new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, raw(jwk.x)], [-3, raw(jwk.y)]])
      : kind === 'ed25519'
        ? new Map<Cbor, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, raw(jwk.x)]])
        : new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, raw(jwk.n)], [-2, raw(jwk.e)]]);
  const credentialId = crypto.randomBytes(16);
  let counter = 0;

  const clientData = (type: string, challenge: string, origin: string) =>
    b64u(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
  const authData = (rpId: string, flags: number, count: number, attested?: Buffer) => {
    const head = Buffer.alloc(37);
    crypto.createHash('sha256').update(rpId).digest().copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(count, 33);
    return attested ? Buffer.concat([head, attested]) : head;
  };

  return {
    credentialId: b64u(credentialId),
    create(challenge: string, o: { origin?: string; rpId?: string; flags?: number } = {}) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const attested = Buffer.concat([Buffer.alloc(16), idLength, credentialId, cbor(cose)]);
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData(o.rpId ?? RP_ID, o.flags ?? UP | UV | AT, 0, attested)],
        ])
      );
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.create', challenge, o.origin ?? ORIGIN),
          attestationObject: b64u(attestationObject),
          transports: ['internal', 'hybrid', 'bogus'],
        },
      };
    },
    get(
      challenge: string,
      o: { origin?: string; rpId?: string; flags?: number; userHandle?: string | null; counter?: number; tamper?: boolean } = {}
    ) {
      if (o.counter !== undefined) counter = o.counter;
      const data = authData(o.rpId ?? RP_ID, o.flags ?? UP | UV, counter);
      const cd = clientData('webauthn.get', challenge, o.origin ?? ORIGIN);
      const signed = Buffer.concat([data, crypto.createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]);
      let signature = crypto.sign(kind === 'ed25519' ? null : 'sha256', signed, pair.privateKey);
      if (o.tamper) signature = Buffer.from(signature.map((b, i) => (i === signature.length - 1 ? b ^ 1 : b)));
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: cd,
          authenticatorData: b64u(data),
          signature: b64u(signature),
          userHandle: o.userHandle === undefined ? b64u(Buffer.from(USER_ID.replace(/-/g, ''), 'hex')) : o.userHandle,
        },
      };
    },
  };
}

const expected = (challenge: string) => ({ challenge, origins: [ORIGIN], rpId: RP_ID, requireUserVerification: true });

async function register(auth = fakeAuthenticator()) {
  const options = await passkeyService.registrationOptions(USER_ID, { password: 'pw' });
  const passkey = await passkeyService.verifyRegistration(USER_ID, { credential: auth.create(options.challenge), name: 'Laptop' });
  return { auth, passkey };
}

async function signIn(auth: ReturnType<typeof fakeAuthenticator>, o: Parameters<ReturnType<typeof fakeAuthenticator>['get']>[1] = {}) {
  const { challenge } = await passkeyService.authenticationOptions();
  return passkeyService.verifyAuthentication(auth.get(challenge, o));
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof HTTPException) return err.status;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.user = {
    id: USER_ID,
    email: 'ada@example.com',
    name: 'Ada',
    avatarUrl: null,
    emailVerified: true,
    twoFactorEnabled: false,
    passwordHash: 'hash',
  };
  h.sso.mockResolvedValue(undefined);
  h.identity.mockResolvedValue(undefined);
  h.createSession.mockResolvedValue(undefined);
  h.firstOrg.mockResolvedValue({ organizationId: ORG.id, organization: ORG });
});

describe('passkey registration', () => {
  it('offers creation options bound to the account and confirms the password first', async () => {
    const options = await passkeyService.registrationOptions(USER_ID, { password: 'pw' });

    expect(h.identity).toHaveBeenCalledWith(USER_ID, { password: 'pw' }, 'en');
    expect(options.rp).toEqual({ id: RP_ID, name: 'Pushify' });
    expect(options.user).toEqual({ id: b64u(Buffer.from(USER_ID.replace(/-/g, ''), 'hex')), name: 'ada@example.com', displayName: 'Ada' });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257]);
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  });

  it('stores a verified passkey and records the event', async () => {
    const { auth, passkey } = await register();

    expect(passkey).toMatchObject({ name: 'Laptop', transports: ['internal', 'hybrid'], backedUp: false, lastUsedAt: null });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ userId: USER_ID, credentialId: auth.credentialId, algorithm: -7, signCount: 0 });
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, event: 'passkey_added', method: 'passkey' }));
    // The next registration excludes it, so the same authenticator is not registered twice
    const next = await passkeyService.registrationOptions(USER_ID, { password: 'pw' });
    expect(next.excludeCredentials).toEqual([{ type: 'public-key', id: auth.credentialId, transports: ['internal', 'hybrid'] }]);
  });

  it.each(['ed25519', 'rs256'] as const)('accepts %s keys', async (kind) => {
    const { auth } = await register(fakeAuthenticator(kind));
    expect(h.rows[0].algorithm).toBe(kind === 'ed25519' ? -8 : -257);
    expect('accessToken' in (await signIn(auth))).toBe(true);
  });

  it('refuses a wrong password before issuing a challenge', async () => {
    h.identity.mockRejectedValue(new HTTPException(400, { message: 'Invalid password' }));
    expect(await status(passkeyService.registrationOptions(USER_ID, { password: 'nope' }))).toBe(400);
  });

  it('lets an OAuth-only account without 2FA register with its session alone', async () => {
    h.user = { ...h.user, passwordHash: null, twoFactorEnabled: false };
    await passkeyService.registrationOptions(USER_ID, {});
    expect(h.identity).not.toHaveBeenCalled();
  });

  it('refuses an address under enforced SSO', async () => {
    h.sso.mockRejectedValue(new HTTPException(403, { message: 'Use SSO' }));
    expect(await status(passkeyService.registrationOptions(USER_ID, { password: 'pw' }))).toBe(403);
    expect(h.sso).toHaveBeenCalledWith('ada@example.com');
  });

  it('uses a challenge once, and only for the user it was issued to', async () => {
    const auth = fakeAuthenticator();
    const { challenge } = await passkeyService.registrationOptions(USER_ID, { password: 'pw' });
    expect(await status(passkeyService.verifyRegistration('someone-else', { credential: auth.create(challenge) }))).toBe(400);
    // …and the attempt consumed it
    expect(await status(passkeyService.verifyRegistration(USER_ID, { credential: auth.create(challenge) }))).toBe(400);
    expect(h.rows).toHaveLength(0);
  });

  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['another RP ID', { rpId: 'evil.example' }],
    ['no user verification', { flags: UP | AT }],
  ])('refuses a credential created for %s', async (_label, o) => {
    const auth = fakeAuthenticator();
    const { challenge } = await passkeyService.registrationOptions(USER_ID, { password: 'pw' });
    expect(await status(passkeyService.verifyRegistration(USER_ID, { credential: auth.create(challenge, o) }))).toBe(400);
    expect(h.rows).toHaveLength(0);
  });

  it('refuses a credential that is already registered', async () => {
    const { auth } = await register();
    const { challenge } = await passkeyService.registrationOptions(USER_ID, { password: 'pw' });
    expect(await status(passkeyService.verifyRegistration(USER_ID, { credential: auth.create(challenge) }))).toBe(409);
  });
});

describe('passkey sign-in', () => {
  it('signs in with the existing JWT pair and session, and records the event', async () => {
    const { auth } = await register();
    const result = await signIn(auth, { counter: 1 });

    if (!('accessToken' in result)) throw new Error('expected a session');
    expect(result.user).toMatchObject({ id: USER_ID, email: 'ada@example.com' });
    expect(result.organization).toEqual(ORG);
    expect(await verifyToken(result.accessToken)).toMatchObject({ sub: USER_ID, org: ORG.id, type: 'access' });
    expect(await verifyToken(result.refreshToken)).toMatchObject({ sub: USER_ID, type: 'refresh' });
    expect(h.createSession).toHaveBeenCalledWith(USER_ID, result.refreshToken, undefined, undefined, 'en');
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, event: 'login', method: 'passkey' }));
    expect(h.rows[0]).toMatchObject({ signCount: 1 });
    expect(h.rows[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('still asks for TOTP when the account has it', async () => {
    const { auth } = await register();
    h.user = { ...h.user, twoFactorEnabled: true };

    const result = await signIn(auth);
    expect(result).toEqual({ requiresTwoFactor: true, twoFactorToken: expect.any(String) });
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'two_factor_required', method: 'passkey' }));
  });

  it('does not get around enforced SSO', async () => {
    const { auth } = await register();
    h.sso.mockRejectedValue(new HTTPException(403, { message: 'Use SSO' }));

    expect(await status(signIn(auth))).toBe(403);
    expect(h.sso).toHaveBeenCalledWith('ada@example.com');
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'login_failed', method: 'passkey' }));
  });

  it('refuses a bad signature and records the failure', async () => {
    const { auth } = await register();
    expect(await status(signIn(auth, { tamper: true }))).toBe(401);
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, event: 'login_failed', method: 'passkey' }));
  });

  it('refuses a replayed assertion: the challenge is single use', async () => {
    const { auth } = await register();
    const { challenge } = await passkeyService.authenticationOptions();
    const assertion = auth.get(challenge);
    expect(await status(passkeyService.verifyAuthentication(assertion))).toBe(200);
    expect(await status(passkeyService.verifyAuthentication(assertion))).toBe(400);
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a challenge that was never issued', async () => {
    const { auth } = await register();
    expect(await status(passkeyService.verifyAuthentication(auth.get(b64u(crypto.randomBytes(32)))))).toBe(400);
  });

  it('refuses a counter that goes backwards (cloned authenticator)', async () => {
    const { auth } = await register();
    await signIn(auth, { counter: 5 });
    expect(await status(signIn(auth, { counter: 5 }))).toBe(401);
    expect(await status(signIn(auth, { counter: 6 }))).toBe(200);
  });

  it('refuses an assertion without the matching user handle', async () => {
    const { auth } = await register();
    expect(await status(signIn(auth, { userHandle: null }))).toBe(401);
    expect(await status(signIn(auth, { userHandle: b64u(crypto.randomBytes(16)) }))).toBe(401);
  });

  it('refuses an unknown passkey without saying whose it could be', async () => {
    expect(await status(signIn(fakeAuthenticator()))).toBe(401);
    expect(h.record).not.toHaveBeenCalled();
  });

  it('refuses an assertion for another origin or without user verification', async () => {
    const { auth } = await register();
    expect(await status(signIn(auth, { origin: 'https://evil.example' }))).toBe(401);
    expect(await status(signIn(auth, { flags: UP }))).toBe(401);
  });
});

describe('listing and removing passkeys', () => {
  it('lists only public fields', async () => {
    await register();
    const list = await passkeyService.list(USER_ID);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(['backedUp', 'createdAt', 'id', 'lastUsedAt', 'name', 'transports']);
  });

  it('removes your own passkey, records it, and it no longer signs in', async () => {
    const { auth, passkey } = await register();
    await passkeyService.remove(USER_ID, passkey.id);

    expect(h.rows).toHaveLength(0);
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, event: 'passkey_removed', method: 'passkey' }));
    expect(await status(signIn(auth))).toBe(401);
  });

  it("cannot remove someone else's passkey", async () => {
    const { passkey } = await register();
    expect(await status(passkeyService.remove('another-user', passkey.id))).toBe(404);
    expect(h.rows).toHaveLength(1);
  });
});

describe('WebAuthn verifier', () => {
  it('rejects malformed CBOR without throwing anything but WebAuthnError', () => {
    for (const bytes of [
      Buffer.from([0xa1]), // map with a missing entry
      Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]), // byte string longer than the data
      Buffer.from([0x9f]), // indefinite length
      Buffer.from([0xc0, 0x00]), // tag
      Buffer.from([0xa2, 0x01, 0x00, 0x01, 0x00]), // duplicate key
      Buffer.from([0x00, 0x00]), // trailing data
    ]) {
      expect(() => decodeCbor(bytes)).toThrow(WebAuthnError);
    }
  });

  it('rejects truncated authenticator data', () => {
    expect(() => parseAuthenticatorData(Buffer.alloc(36))).toThrow(WebAuthnError);
    const withAt = Buffer.alloc(40);
    withAt[32] = AT;
    expect(() => parseAuthenticatorData(withAt)).toThrow(WebAuthnError);
  });

  it('rejects an assertion signed by another key for the same credential id', () => {
    const real = fakeAuthenticator();
    const challenge = b64u(crypto.randomBytes(32));
    const reg = verifyRegistrationResponse(real.create(challenge), expected(challenge));
    const impostor = fakeAuthenticator();
    const forged = impostor.get(challenge);
    forged.id = forged.rawId = reg.credentialId;
    expect(() =>
      verifyAuthenticationResponse(forged, expected(challenge), { credentialId: reg.credentialId, publicKey: reg.publicKey, signCount: 0 })
    ).toThrow('Signature is not valid');
  });

  it('rejects a registration whose key uses an algorithm that was not offered', () => {
    const challenge = b64u(crypto.randomBytes(32));
    const credential = fakeAuthenticator().create(challenge);
    // Rewrite the COSE key's alg from -7 (0x26) to -5 (0x24), same length, so only the algorithm differs
    const att = Buffer.from(credential.response.attestationObject, 'base64url');
    const at = att.indexOf(Buffer.from([0x01, 0x02, 0x03, 0x26]));
    expect(at).toBeGreaterThan(0);
    att[at + 3] = 0x24;
    credential.response.attestationObject = b64u(att);
    expect(() => verifyRegistrationResponse(credential, expected(challenge))).toThrow('Unsupported public key algorithm');
  });
});
