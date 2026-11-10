import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../middleware/auth';
import { rejectApiKeyAuth } from '../middleware/apikey-auth';
import { authRateLimiter } from '../middleware/rate-limit';
import { passkeyService } from '../services/passkey.service';
import { LoginResponseSchema } from './auth';
import type { AppEnv } from '../types';

// ============ Schemas ============

const base64url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/, 'Must be base64url');

const PasskeySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    transports: z.array(z.string()),
    backedUp: z.boolean().openapi({ description: 'Synced to the user\'s other devices (e.g. iCloud Keychain, Google Password Manager)' }),
    createdAt: z.coerce.date(),
    lastUsedAt: z.coerce.date().nullable(),
  })
  .openapi('Passkey');

const PasskeyMessageSchema = z.object({ message: z.string() }).openapi('PasskeyMessage');

const RegistrationOptionsRequestSchema = z
  .object({
    password: z.string().min(1).optional().openapi({ description: 'Current password (accounts that have one)' }),
    twoFactorCode: z.string().min(6).max(20).optional().openapi({
      description: 'TOTP or backup code (OAuth-only accounts with 2FA)',
    }),
  })
  .openapi('PasskeyRegistrationOptionsRequest');

const CredentialDescriptorSchema = z.object({
  type: z.literal('public-key'),
  id: z.string(),
  transports: z.array(z.string()).optional(),
});

const RegistrationOptionsSchema = z
  .object({
    data: z.object({
      challenge: z.string(),
      rp: z.object({ id: z.string(), name: z.string() }),
      user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
      pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number() })),
      timeout: z.number(),
      attestation: z.literal('none'),
      excludeCredentials: z.array(CredentialDescriptorSchema),
      authenticatorSelection: z.object({
        residentKey: z.literal('required'),
        requireResidentKey: z.literal(true),
        userVerification: z.literal('required'),
      }),
    }),
  })
  .openapi('PasskeyRegistrationOptions', {
    description: 'PublicKeyCredentialCreationOptionsJSON: pass `data` to navigator.credentials.create() (binary fields are base64url)',
  });

const RegistrationVerifyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional().openapi({ example: 'MacBook Touch ID' }),
    credential: z.object({
      id: base64url(1400),
      rawId: base64url(1400),
      type: z.literal('public-key'),
      response: z.object({
        clientDataJSON: base64url(4096),
        attestationObject: base64url(65536),
        transports: z.array(z.string().max(32)).max(10).optional(),
      }),
      authenticatorAttachment: z.string().max(32).optional(),
      clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi('PasskeyRegistrationVerifyRequest', {
    description: '`credential` is the RegistrationResponseJSON (PublicKeyCredential.toJSON()) of the created credential',
  });

const AuthenticationOptionsSchema = z
  .object({
    data: z.object({
      challenge: z.string(),
      rpId: z.string(),
      timeout: z.number(),
      userVerification: z.literal('required'),
      allowCredentials: z.array(CredentialDescriptorSchema),
    }),
  })
  .openapi('PasskeyAuthenticationOptions', {
    description: 'PublicKeyCredentialRequestOptionsJSON: pass `data` to navigator.credentials.get()',
  });

const AuthenticationVerifyRequestSchema = z
  .object({
    credential: z.object({
      id: base64url(1400),
      rawId: base64url(1400),
      type: z.literal('public-key'),
      response: z.object({
        clientDataJSON: base64url(4096),
        authenticatorData: base64url(8192),
        signature: base64url(2048),
        userHandle: base64url(128).nullable().optional(),
      }),
      authenticatorAttachment: z.string().max(32).optional(),
      clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi('PasskeyAuthenticationVerifyRequest', {
    description: '`credential` is the AuthenticationResponseJSON (PublicKeyCredential.toJSON()) of the assertion',
  });

const PasskeyIdParamSchema = z.object({
  passkeyId: z.string().uuid().openapi({ param: { name: 'passkeyId', in: 'path' } }),
});

// ============ Route Definitions ============

const registrationOptionsRoute = createRoute({
  method: 'post',
  path: '/register/options',
  tags: ['Passkeys'],
  summary: 'Start adding a passkey',
  description:
    'Returns the WebAuthn creation options for the signed-in user. Asks for the current password (or, for an OAuth-only account with 2FA, a TOTP/backup code). Refused (403) for addresses under an enforced SSO connection.',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: RegistrationOptionsRequestSchema } } } },
  responses: {
    200: { description: 'Creation options', content: { 'application/json': { schema: RegistrationOptionsSchema } } },
  },
});

const registrationVerifyRoute = createRoute({
  method: 'post',
  path: '/register/verify',
  tags: ['Passkeys'],
  summary: 'Finish adding a passkey',
  description: 'Verifies the credential the authenticator created for the challenge from /register/options and stores it.',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: RegistrationVerifyRequestSchema } } } },
  responses: {
    201: { description: 'Passkey added', content: { 'application/json': { schema: z.object({ data: PasskeySchema }) } } },
  },
});

const authenticationOptionsRoute = createRoute({
  method: 'post',
  path: '/login/options',
  tags: ['Passkeys'],
  summary: 'Start a passkey sign-in',
  description: 'Returns WebAuthn request options with a single-use challenge (valid 5 minutes). No email needed.',
  responses: {
    200: { description: 'Request options', content: { 'application/json': { schema: AuthenticationOptionsSchema } } },
  },
});

const authenticationVerifyRoute = createRoute({
  method: 'post',
  path: '/login/verify',
  tags: ['Passkeys'],
  summary: 'Finish a passkey sign-in',
  description:
    'Verifies the assertion and signs the user in, exactly like POST /auth/login: tokens and a session, or `requiresTwoFactor` with a token for POST /auth/login/2fa when the account has TOTP. Refused (403) for addresses under an enforced SSO connection.',
  request: { body: { content: { 'application/json': { schema: AuthenticationVerifyRequestSchema } } } },
  responses: {
    200: { description: 'Signed in or 2FA required', content: { 'application/json': { schema: LoginResponseSchema } } },
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Passkeys'],
  summary: 'List my passkeys',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Passkeys of the signed-in user', content: { 'application/json': { schema: z.object({ data: z.array(PasskeySchema) }) } } },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{passkeyId}',
  tags: ['Passkeys'],
  summary: 'Remove one of my passkeys',
  security: [{ bearerAuth: [] }],
  request: { params: PasskeyIdParamSchema },
  responses: {
    200: { description: 'Passkey removed', content: { 'application/json': { schema: PasskeyMessageSchema } } },
  },
});

// ============ Router ============

const passkeyRouter = new OpenAPIHono<AppEnv>();

const requestContext = (c: { req: { header: (name: string) => string | undefined } }) => ({
  ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
  userAgent: c.req.header('user-agent'),
});

// Sign-in: public, rate limited like the password login
passkeyRouter.use('/login/*', authRateLimiter);

// Managing your own passkeys: a dashboard session only, never an API key
passkeyRouter.use('/register/*', authMiddleware, rejectApiKeyAuth(), authRateLimiter);
passkeyRouter.use('/', authMiddleware, rejectApiKeyAuth());
passkeyRouter.use('/:passkeyId', authMiddleware, rejectApiKeyAuth(), authRateLimiter);

passkeyRouter.openapi(registrationOptionsRoute, async (c) => {
  const options = await passkeyService.registrationOptions(c.get('userId')!, c.req.valid('json'), c.get('locale'));
  return c.json({ data: options });
});

passkeyRouter.openapi(registrationVerifyRoute, async (c) => {
  const passkey = await passkeyService.verifyRegistration(c.get('userId')!, c.req.valid('json'), c.get('locale'), requestContext(c));
  return c.json({ data: passkey }, 201);
});

passkeyRouter.openapi(authenticationOptionsRoute, async (c) => {
  return c.json({ data: await passkeyService.authenticationOptions() });
});

passkeyRouter.openapi(authenticationVerifyRoute, async (c) => {
  const { credential } = c.req.valid('json');
  const result = await passkeyService.verifyAuthentication(credential, c.get('locale'), requestContext(c));

  if ('requiresTwoFactor' in result) {
    return c.json({ requiresTwoFactor: true as const, twoFactorToken: result.twoFactorToken });
  }
  return c.json({
    data: { user: result.user, organization: result.organization },
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
});

passkeyRouter.openapi(listRoute, async (c) => {
  return c.json({ data: await passkeyService.list(c.get('userId')!) });
});

passkeyRouter.openapi(deleteRoute, async (c) => {
  const { passkeyId } = c.req.valid('param');
  const result = await passkeyService.remove(c.get('userId')!, passkeyId, c.get('locale'), requestContext(c));
  return c.json(result);
});

export { passkeyRouter as passkeyRoutes };
