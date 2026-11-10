import crypto from 'node:crypto';

/**
 * WebAuthn (passkey) ceremony verification, Relying Party side, on node:crypto only.
 *
 * Deliberately narrow — the subset Pushify asks browsers for:
 *  - attestation "none": the attestation statement is not verified and no authenticator model is
 *    trusted or refused because of it. The registering user is already signed in; all we need from
 *    the authenticator is its public key;
 *  - algorithms ES256 (-7), EdDSA/Ed25519 (-8) and RS256 (-257), the ones offered in
 *    `pubKeyCredParams`;
 *  - CTAP2 canonical CBOR: definite lengths, no tags, no floats.
 * Everything else is refused with a `WebAuthnError`, never accepted unchecked.
 *
 * Spec: https://www.w3.org/TR/webauthn-2/#sctn-registering-a-new-credential (§7.1) and
 * #sctn-verifying-assertion (§7.2). Step numbers below refer to those sections.
 */

export class WebAuthnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_EDDSA = -8;
export const COSE_ALG_RS256 = -257;
export const SUPPORTED_COSE_ALGORITHMS = [COSE_ALG_ES256, COSE_ALG_EDDSA, COSE_ALG_RS256] as const;

// ── base64url ──

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Strict: Buffer.from(…, 'base64url') silently skips characters outside the alphabet. */
export function fromBase64Url(value: string, field = 'value'): Buffer {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw new WebAuthnError(`${field} is not base64url`);
  }
  return Buffer.from(value, 'base64url');
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** The WebAuthn user handle for an account: its UUID as 16 bytes — opaque, no personal data. */
export function userHandleFor(userId: string): string {
  const hex = userId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new WebAuthnError('user id is not a UUID');
  return toBase64Url(Buffer.from(hex, 'hex'));
}

export function generateChallenge(): string {
  return toBase64Url(crypto.randomBytes(32));
}

// ── CBOR (RFC 8949), the subset WebAuthn uses ──

type CborValue = number | string | boolean | null | undefined | Buffer | CborValue[] | Map<CborValue, CborValue>;

const MAX_CBOR_DEPTH = 16;

function decodeCborItem(buf: Buffer, start: number, depth: number): { value: CborValue; end: number } {
  if (depth > MAX_CBOR_DEPTH) throw new WebAuthnError('CBOR nested too deeply');
  if (start >= buf.length) throw new WebAuthnError('CBOR data is truncated');

  const initial = buf[start];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let offset = start + 1;

  const need = (n: number) => {
    if (offset + n > buf.length) throw new WebAuthnError('CBOR data is truncated');
  };

  if (major === 7) {
    if (info === 20) return { value: false, end: offset };
    if (info === 21) return { value: true, end: offset };
    if (info === 22) return { value: null, end: offset };
    if (info === 23) return { value: undefined, end: offset };
    throw new WebAuthnError('Unsupported CBOR simple value or float');
  }

  let argument: number;
  if (info < 24) {
    argument = info;
  } else if (info === 24) {
    need(1);
    argument = buf[offset];
    offset += 1;
  } else if (info === 25) {
    need(2);
    argument = buf.readUInt16BE(offset);
    offset += 2;
  } else if (info === 26) {
    need(4);
    argument = buf.readUInt32BE(offset);
    offset += 4;
  } else if (info === 27) {
    need(8);
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError('CBOR integer too large');
    argument = Number(big);
    offset += 8;
  } else {
    // 28–30 are reserved, 31 is an indefinite length: neither is canonical CTAP2 CBOR
    throw new WebAuthnError('Unsupported CBOR length encoding');
  }

  switch (major) {
    case 0:
      return { value: argument, end: offset };
    case 1:
      return { value: -1 - argument, end: offset };
    case 2: {
      need(argument);
      return { value: Buffer.from(buf.subarray(offset, offset + argument)), end: offset + argument };
    }
    case 3: {
      need(argument);
      return { value: buf.subarray(offset, offset + argument).toString('utf8'), end: offset + argument };
    }
    case 4: {
      // Every item takes at least one byte: a length larger than what is left is a lie
      if (argument > buf.length - offset) throw new WebAuthnError('CBOR data is truncated');
      const items: CborValue[] = [];
      for (let i = 0; i < argument; i++) {
        const item = decodeCborItem(buf, offset, depth + 1);
        items.push(item.value);
        offset = item.end;
      }
      return { value: items, end: offset };
    }
    case 5: {
      if (argument * 2 > buf.length - offset) throw new WebAuthnError('CBOR data is truncated');
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < argument; i++) {
        const key = decodeCborItem(buf, offset, depth + 1);
        if (typeof key.value !== 'number' && typeof key.value !== 'string') {
          throw new WebAuthnError('Unsupported CBOR map key');
        }
        if (map.has(key.value)) throw new WebAuthnError('Duplicate CBOR map key');
        const entry = decodeCborItem(buf, key.end, depth + 1);
        map.set(key.value, entry.value);
        offset = entry.end;
      }
      return { value: map, end: offset };
    }
    default:
      // 6: tags, not used by WebAuthn
      throw new WebAuthnError('Unsupported CBOR type');
  }
}

/** The first CBOR item in `buf` and where it ends (authenticator data has items back to back). */
export function decodeCborFirst(buf: Buffer): { value: CborValue; end: number } {
  return decodeCborItem(buf, 0, 0);
}

/** Exactly one CBOR item, nothing after it. */
export function decodeCbor(buf: Buffer): CborValue {
  const { value, end } = decodeCborItem(buf, 0, 0);
  if (end !== buf.length) throw new WebAuthnError('Unexpected data after CBOR item');
  return value;
}

// ── Authenticator data (§6.1) ──

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export interface AuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  signCount: number;
  attestedCredential?: {
    aaguid: string;
    credentialId: Buffer;
    /** COSE_Key bytes, exactly as sent */
    publicKey: Buffer;
  };
}

function formatAaguid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) throw new WebAuthnError('Authenticator data is too short');
  const flags = data[32];
  const result: AuthenticatorData = {
    rpIdHash: Buffer.from(data.subarray(0, 32)),
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    backupEligible: (flags & FLAG_BE) !== 0,
    backedUp: (flags & FLAG_BS) !== 0,
    signCount: data.readUInt32BE(33),
  };
  if (result.backedUp && !result.backupEligible) {
    throw new WebAuthnError('Authenticator data says backed up but not backup eligible');
  }

  let offset = 37;
  if (flags & FLAG_AT) {
    if (data.length < offset + 18) throw new WebAuthnError('Attested credential data is truncated');
    const aaguid = formatAaguid(data.subarray(offset, offset + 16));
    offset += 16;
    const idLength = data.readUInt16BE(offset);
    offset += 2;
    if (idLength === 0 || idLength > 1023) throw new WebAuthnError('Credential ID has an invalid length');
    if (data.length < offset + idLength) throw new WebAuthnError('Attested credential data is truncated');
    const credentialId = Buffer.from(data.subarray(offset, offset + idLength));
    offset += idLength;
    const key = decodeCborFirst(data.subarray(offset));
    const publicKey = Buffer.from(data.subarray(offset, offset + key.end));
    offset += key.end;
    result.attestedCredential = { aaguid, credentialId, publicKey };
  }
  if (flags & FLAG_ED) {
    // Extension outputs: not used, but they must be a well-formed map
    const extensions = decodeCborFirst(data.subarray(offset));
    if (!(extensions.value instanceof Map)) throw new WebAuthnError('Authenticator extensions are not a map');
    offset += extensions.end;
  }
  if (offset !== data.length) throw new WebAuthnError('Unexpected data after authenticator data');
  return result;
}

// ── COSE keys (RFC 9053) ──

function coseBytes(map: Map<CborValue, CborValue>, label: number, length?: number): Buffer {
  const value = map.get(label);
  if (!Buffer.isBuffer(value)) throw new WebAuthnError(`COSE key parameter ${label} is missing`);
  if (length !== undefined && value.length !== length) {
    throw new WebAuthnError(`COSE key parameter ${label} has the wrong length`);
  }
  return value;
}

/** A COSE_Key as a node:crypto public key, refused unless it is one of the supported algorithms. */
export function importCosePublicKey(cose: Buffer): { algorithm: number; key: crypto.KeyObject } {
  const map = decodeCbor(cose);
  if (!(map instanceof Map)) throw new WebAuthnError('COSE key is not a map');
  const kty = map.get(1);
  const alg = map.get(3);

  let jwk: crypto.JsonWebKey;
  if (alg === COSE_ALG_ES256) {
    if (kty !== 2 || map.get(-1) !== 1) throw new WebAuthnError('ES256 key is not an EC2 P-256 key');
    jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(coseBytes(map, -2, 32)),
      y: toBase64Url(coseBytes(map, -3, 32)),
    };
  } else if (alg === COSE_ALG_EDDSA) {
    if (kty !== 1 || map.get(-1) !== 6) throw new WebAuthnError('EdDSA key is not an Ed25519 key');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(coseBytes(map, -2, 32)) };
  } else if (alg === COSE_ALG_RS256) {
    if (kty !== 3) throw new WebAuthnError('RS256 key is not an RSA key');
    const n = coseBytes(map, -1);
    // Below 2048 bits is not acceptable (leading zero byte tolerated)
    if (n.length < 256) throw new WebAuthnError('RSA key is too short');
    jwk = { kty: 'RSA', n: toBase64Url(n), e: toBase64Url(coseBytes(map, -2)) };
  } else {
    throw new WebAuthnError('Unsupported public key algorithm');
  }

  try {
    return { algorithm: alg, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) };
  } catch {
    throw new WebAuthnError('Public key is not valid');
  }
}

function verifySignature(algorithm: number, key: crypto.KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    // ES256 signatures are ASN.1 DER in WebAuthn, which is node's default for EC keys
    if (algorithm === COSE_ALG_EDDSA) return crypto.verify(null, data, key, signature);
    return crypto.verify('sha256', data, key, signature);
  } catch {
    return false;
  }
}

// ── Client data (§5.8.1) ──

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function parseClientData(clientDataJSON: Buffer): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientDataJSON.toString('utf8'));
  } catch {
    throw new WebAuthnError('Client data is not JSON');
  }
  const data = parsed as Partial<ClientData> | null;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string') {
    throw new WebAuthnError('Client data is incomplete');
  }
  return data as ClientData;
}

/**
 * The challenge a response answers, read before it is verified, to find the ceremony it belongs
 * to. Null when unreadable. Not a check on its own: the verify functions compare it again.
 */
export function readClientDataChallenge(clientDataJSON: string): string | null {
  try {
    const { challenge } = parseClientData(fromBase64Url(clientDataJSON, 'clientDataJSON'));
    return BASE64URL_RE.test(challenge) && challenge.length > 0 ? challenge : null;
  } catch {
    return null;
  }
}

function checkClientData(
  clientDataJSON: Buffer,
  expected: { type: 'webauthn.create' | 'webauthn.get'; challenge: string; origins: string[] }
): void {
  const data = parseClientData(clientDataJSON);
  if (data.type !== expected.type) throw new WebAuthnError('Client data has the wrong ceremony type');
  if (data.challenge !== expected.challenge) throw new WebAuthnError('Challenge does not match');
  if (!expected.origins.includes(data.origin)) throw new WebAuthnError(`Origin ${data.origin} is not allowed`);
  // Pushify's dashboard never runs the ceremony inside a cross-origin iframe
  if (data.crossOrigin === true) throw new WebAuthnError('Cross-origin ceremonies are not allowed');
}

function sha256(data: Buffer | string): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

function checkAuthenticatorFlags(auth: AuthenticatorData, rpId: string, requireUserVerification: boolean): void {
  const expectedHash = sha256(rpId);
  if (!crypto.timingSafeEqual(auth.rpIdHash, expectedHash)) throw new WebAuthnError('RP ID hash does not match');
  if (!auth.userPresent) throw new WebAuthnError('User was not present');
  if (requireUserVerification && !auth.userVerified) throw new WebAuthnError('User was not verified');
}

function credentialIdOf(credential: { id: string; rawId: string }): Buffer {
  const rawId = fromBase64Url(credential.rawId, 'rawId');
  if (rawId.length === 0 || !rawId.equals(fromBase64Url(credential.id, 'id'))) {
    throw new WebAuthnError('Credential id and rawId differ');
  }
  return rawId;
}

/** Canonical base64url of a credential id, as stored. */
export function normalizeCredentialId(id: string): string {
  return toBase64Url(fromBase64Url(id, 'credential id'));
}

export interface ExpectedCeremony {
  challenge: string;
  origins: string[];
  rpId: string;
  requireUserVerification: boolean;
}

// ── Registration (§7.1) ──

export interface RegistrationCredential {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string };
}

export interface VerifiedRegistration {
  credentialId: string;
  /** COSE_Key, base64url */
  publicKey: string;
  algorithm: number;
  signCount: number;
  aaguid: string;
  backupEligible: boolean;
  backedUp: boolean;
}

export function verifyRegistrationResponse(credential: RegistrationCredential, expected: ExpectedCeremony): VerifiedRegistration {
  if (credential.type !== 'public-key') throw new WebAuthnError('Credential type is not public-key');
  const rawId = credentialIdOf(credential);

  // Steps 5–12
  checkClientData(fromBase64Url(credential.response.clientDataJSON, 'clientDataJSON'), {
    type: 'webauthn.create',
    challenge: expected.challenge,
    origins: expected.origins,
  });

  // Step 12: fmt, attStmt, authData. The statement itself is not verified (attestation "none")
  const attestation = decodeCbor(fromBase64Url(credential.response.attestationObject, 'attestationObject'));
  if (!(attestation instanceof Map)) throw new WebAuthnError('Attestation object is not a map');
  const authDataBytes = attestation.get('authData');
  if (typeof attestation.get('fmt') !== 'string' || !(attestation.get('attStmt') instanceof Map) || !Buffer.isBuffer(authDataBytes)) {
    throw new WebAuthnError('Attestation object is incomplete');
  }

  // Steps 13–16
  const auth = parseAuthenticatorData(authDataBytes);
  checkAuthenticatorFlags(auth, expected.rpId, expected.requireUserVerification);
  if (!auth.attestedCredential) throw new WebAuthnError('No credential was created');
  if (!auth.attestedCredential.credentialId.equals(rawId)) throw new WebAuthnError('Credential id does not match the authenticator data');

  // Step 17: one of the algorithms that were offered
  const { algorithm } = importCosePublicKey(auth.attestedCredential.publicKey);

  return {
    credentialId: toBase64Url(rawId),
    publicKey: toBase64Url(auth.attestedCredential.publicKey),
    algorithm,
    signCount: auth.signCount,
    aaguid: auth.attestedCredential.aaguid,
    backupEligible: auth.backupEligible,
    backedUp: auth.backedUp,
  };
}

// ── Authentication (§7.2) ──

export interface AuthenticationCredential {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string };
}

export interface StoredCredential {
  credentialId: string;
  /** COSE_Key, base64url */
  publicKey: string;
  signCount: number;
}

export interface VerifiedAuthentication {
  signCount: number;
  backedUp: boolean;
}

export function verifyAuthenticationResponse(
  credential: AuthenticationCredential,
  expected: ExpectedCeremony,
  stored: StoredCredential
): VerifiedAuthentication {
  if (credential.type !== 'public-key') throw new WebAuthnError('Credential type is not public-key');
  // Step 5/6: the credential is the one that was looked up
  if (toBase64Url(credentialIdOf(credential)) !== stored.credentialId) throw new WebAuthnError('Unknown credential');

  const clientDataJSON = fromBase64Url(credential.response.clientDataJSON, 'clientDataJSON');
  const authDataBytes = fromBase64Url(credential.response.authenticatorData, 'authenticatorData');
  const signature = fromBase64Url(credential.response.signature, 'signature');

  // Steps 10–14
  checkClientData(clientDataJSON, { type: 'webauthn.get', challenge: expected.challenge, origins: expected.origins });

  // Steps 15–17
  const auth = parseAuthenticatorData(authDataBytes);
  checkAuthenticatorFlags(auth, expected.rpId, expected.requireUserVerification);
  if (auth.attestedCredential) throw new WebAuthnError('Unexpected attested credential data in an assertion');

  // Steps 19–20: signature over authenticatorData ‖ SHA-256(clientDataJSON)
  const { algorithm, key } = importCosePublicKey(fromBase64Url(stored.publicKey, 'publicKey'));
  const signed = Buffer.concat([authDataBytes, sha256(clientDataJSON)]);
  if (!verifySignature(algorithm, key, signed, signature)) throw new WebAuthnError('Signature is not valid');

  // Step 21: a counter that does not move forward means a cloned authenticator. Both zero is
  // normal: synced passkeys do not keep a counter.
  if ((auth.signCount > 0 || stored.signCount > 0) && auth.signCount <= stored.signCount) {
    throw new WebAuthnError('Signature counter did not increase');
  }

  return { signCount: auth.signCount, backedUp: auth.backedUp };
}
