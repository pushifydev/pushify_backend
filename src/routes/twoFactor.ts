import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware } from '../middleware/auth';
import { authRateLimiter } from '../middleware/rate-limit';
import { twoFactorService } from '../services/twoFactor.service';
import { authService } from '../services/auth.service';
import { t } from '../i18n';
import type { AppEnv } from '../types';

// ============ Schemas ============

const TwoFactorSetupSchema = z
  .object({
    secret: z.string(),
    qrCodeUrl: z.string(),
    backupCodes: z.array(z.string()),
  })
  .openapi('TwoFactorSetup');

const TwoFactorStatusSchema = z
  .object({
    enabled: z.boolean(),
    hasBackupCodes: z.boolean(),
  })
  .openapi('TwoFactorStatus');

const BackupCodesSchema = z
  .object({
    backupCodes: z.array(z.string()),
  })
  .openapi('BackupCodes');

const MessageSchema = z
  .object({
    message: z.string(),
  })
  .openapi('TwoFactorMessage');

// ============ Request Schemas ============

const EnableRequestSchema = z
  .object({
    code: z.string().length(6, 'Code must be 6 digits').openapi({ example: '123456' }),
    backupCodes: z.array(z.string()).min(8).max(10).openapi({
      description: 'The backup codes received from setup, to be hashed and stored',
    }),
  })
  .openapi('TwoFactorEnableRequest');

const VerifyRequestSchema = z
  .object({
    code: z.string().min(1).openapi({ example: '123456' }),
  })
  .openapi('TwoFactorVerifyRequest');

const DisableRequestSchema = z
  .object({
    password: z.string().min(1).openapi({ example: 'YourPassword123' }),
  })
  .openapi('TwoFactorDisableRequest');

const RegenerateBackupCodesRequestSchema = z
  .object({
    password: z.string().min(1).openapi({ example: 'YourPassword123' }),
  })
  .openapi('RegenerateBackupCodesRequest');

// ============ Route Definitions ============

const setupRoute = createRoute({
  method: 'post',
  path: '/setup',
  tags: ['Two-Factor Authentication'],
  summary: 'Generate 2FA setup',
  description: 'Generate a new TOTP secret and QR code for 2FA setup. Returns backup codes that must be saved by the user.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '2FA setup data generated successfully',
      content: {
        'application/json': {
          schema: TwoFactorSetupSchema,
        },
      },
    },
  },
});

const enableRoute = createRoute({
  method: 'post',
  path: '/enable',
  tags: ['Two-Factor Authentication'],
  summary: 'Enable 2FA',
  description: 'Verify the TOTP code and enable 2FA for the account',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: EnableRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: '2FA enabled successfully',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

const verifyRoute = createRoute({
  method: 'post',
  path: '/verify',
  tags: ['Two-Factor Authentication'],
  summary: 'Verify 2FA code',
  description: 'Verify a TOTP code or backup code during login',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: VerifyRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Code verified successfully',
      content: {
        'application/json': {
          schema: z.object({ valid: z.boolean() }),
        },
      },
    },
  },
});

const disableRoute = createRoute({
  method: 'post',
  path: '/disable',
  tags: ['Two-Factor Authentication'],
  summary: 'Disable 2FA',
  description: 'Disable 2FA for the account (requires password confirmation)',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: DisableRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: '2FA disabled successfully',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

const regenerateBackupCodesRoute = createRoute({
  method: 'post',
  path: '/backup-codes/regenerate',
  tags: ['Two-Factor Authentication'],
  summary: 'Regenerate backup codes',
  description: 'Generate new backup codes (invalidates existing ones)',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: RegenerateBackupCodesRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Backup codes regenerated successfully',
      content: {
        'application/json': {
          schema: BackupCodesSchema,
        },
      },
    },
  },
});

const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: ['Two-Factor Authentication'],
  summary: 'Get 2FA status',
  description: 'Check if 2FA is enabled for the current user',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '2FA status',
      content: {
        'application/json': {
          schema: TwoFactorStatusSchema,
        },
      },
    },
  },
});

// ============ Router ============

const twoFactorRouter = new OpenAPIHono<AppEnv>();

// All 2FA routes require authentication
twoFactorRouter.use('/*', authMiddleware);

// Apply rate limiting to sensitive endpoints
twoFactorRouter.use('/setup', authRateLimiter);
twoFactorRouter.use('/enable', authRateLimiter);
twoFactorRouter.use('/verify', authRateLimiter);
twoFactorRouter.use('/disable', authRateLimiter);
twoFactorRouter.use('/backup-codes/regenerate', authRateLimiter);

// Setup - Generate secret and QR code
twoFactorRouter.openapi(setupRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  // Get user's email for the QR code
  const user = await authService.getCurrentUser(userId, locale);

  const setup = await twoFactorService.generateSetup(userId, user.email);

  return c.json({
    secret: setup.secret,
    qrCodeUrl: setup.qrCodeUrl,
    backupCodes: setup.backupCodes,
  });
});

// Enable - Verify code and enable 2FA
twoFactorRouter.openapi(enableRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { code, backupCodes } = c.req.valid('json');

  await twoFactorService.verifyAndEnable(userId, code, backupCodes, locale);

  return c.json({ message: t(locale, 'twoFactor', 'enabled') });
});

// Verify - Check TOTP or backup code
twoFactorRouter.openapi(verifyRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { code } = c.req.valid('json');

  // Try TOTP first, then backup code
  let valid = await twoFactorService.verifyCode(userId, code, locale);

  if (!valid && code.length === 8) {
    // Backup codes are 8 characters
    valid = await twoFactorService.verifyBackupCode(userId, code, locale);
  }

  return c.json({ valid });
});

// Disable - Disable 2FA with password confirmation
twoFactorRouter.openapi(disableRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { password } = c.req.valid('json');

  await twoFactorService.disable(userId, password, locale);

  return c.json({ message: t(locale, 'twoFactor', 'disabled') });
});

// Regenerate backup codes
twoFactorRouter.openapi(regenerateBackupCodesRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { password } = c.req.valid('json');

  const backupCodes = await twoFactorService.regenerateBackupCodes(userId, password, locale);

  return c.json({ backupCodes });
});

// Status - Get 2FA status
twoFactorRouter.openapi(statusRoute, async (c) => {
  const userId = c.get('userId')!;

  const status = await twoFactorService.getStatus(userId);

  return c.json({
    enabled: status.enabled,
    hasBackupCodes: status.hasBackupCodes,
  });
});

export { twoFactorRouter as twoFactorRoutes };
