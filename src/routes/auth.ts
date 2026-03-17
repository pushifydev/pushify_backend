import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authService } from '../services/auth.service';
import { organizationService } from '../services/organization.service';
import { authMiddleware } from '../middleware/auth';
import { authRateLimiter, passwordResetRateLimiter } from '../middleware/rate-limit';
import { t } from '../i18n';
import type { AppEnv } from '../types';

// ============ Schemas ============

const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .openapi('User');

const OrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  })
  .openapi('Organization');

const AuthResponseSchema = z
  .object({
    data: z.object({
      user: UserSchema,
      organization: OrganizationSchema,
    }),
    accessToken: z.string(),
    refreshToken: z.string(),
  })
  .openapi('AuthResponse');

const TokenResponseSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
  })
  .openapi('TokenResponse');

const MessageSchema = z
  .object({
    message: z.string(),
  })
  .openapi('Message');

const CurrentUserSchema = z
  .object({
    data: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      avatarUrl: z.string().nullable(),
      emailVerified: z.boolean(),
      twoFactorEnabled: z.boolean(),
      createdAt: z.coerce.date(),
    }),
  })
  .openapi('CurrentUser');

// ============ Request Schemas ============

const RegisterRequestSchema = z
  .object({
    email: z.string().email().openapi({ example: 'user@example.com' }),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .openapi({ example: 'SecurePass123' }),
    name: z.string().min(2).max(100).openapi({ example: 'John Doe' }),
  })
  .openapi('RegisterRequest');

const LoginRequestSchema = z
  .object({
    email: z.string().email().openapi({ example: 'user@example.com' }),
    password: z.string().min(1).openapi({ example: 'SecurePass123' }),
  })
  .openapi('LoginRequest');

const RefreshRequestSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .openapi('RefreshRequest');

const TwoFactorRequiredSchema = z
  .object({
    requiresTwoFactor: z.literal(true),
    twoFactorToken: z.string(),
  })
  .openapi('TwoFactorRequired');

const LoginResponseSchema = z.union([
  AuthResponseSchema,
  TwoFactorRequiredSchema,
]).openapi('LoginResponse');

const VerifyTwoFactorRequestSchema = z
  .object({
    twoFactorToken: z.string().min(1).openapi({ description: 'The temporary token received from login' }),
    code: z.string().min(1).openapi({ example: '123456', description: 'TOTP code or backup code' }),
  })
  .openapi('VerifyTwoFactorRequest');

const UpdateProfileRequestSchema = z
  .object({
    name: z.string().min(2).max(100).optional().openapi({ example: 'John Doe' }),
    avatarUrl: z.string().url().nullable().optional().openapi({ example: 'https://example.com/avatar.jpg' }),
  })
  .openapi('UpdateProfileRequest');

const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).openapi({ example: 'OldPass123' }),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .openapi({ example: 'NewSecurePass123' }),
  })
  .openapi('ChangePasswordRequest');

const GithubLoginCallbackRequestSchema = z
  .object({
    code: z.string().min(1).openapi({ description: 'OAuth code from GitHub' }),
  })
  .openapi('GithubLoginCallbackRequest');

const GithubLoginUrlResponseSchema = z
  .object({
    url: z.string().url(),
  })
  .openapi('GithubLoginUrlResponse');

const ForgotPasswordRequestSchema = z
  .object({
    email: z.string().email().openapi({ example: 'user@example.com' }),
  })
  .openapi('ForgotPasswordRequest');

const ForgotPasswordResponseSchema = z
  .object({
    message: z.string(),
  })
  .openapi('ForgotPasswordResponse');

const ResetPasswordRequestSchema = z
  .object({
    token: z.string().min(1).openapi({ description: 'The password reset token' }),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .openapi({ example: 'NewSecurePass123' }),
  })
  .openapi('ResetPasswordRequest');

const VerifyEmailRequestSchema = z
  .object({
    token: z.string().min(1).openapi({ description: 'The email verification token' }),
  })
  .openapi('VerifyEmailRequest');

const MessageResponseSchema = z
  .object({ message: z.string() })
  .openapi('MessageResponse');

const SessionSchema = z
  .object({
    id: z.string(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
  })
  .openapi('Session');

const SessionsListSchema = z
  .object({
    data: z.array(SessionSchema),
  })
  .openapi('SessionsList');

// ============ Route Definitions ============

const registerRoute = createRoute({
  method: 'post',
  path: '/register',
  tags: ['Authentication'],
  summary: 'Register a new user',
  description: 'Creates a new user account with a default organization',
  request: {
    body: {
      content: {
        'application/json': {
          schema: RegisterRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'User registered successfully',
      content: {
        'application/json': {
          schema: AuthResponseSchema,
        },
      },
    },
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['Authentication'],
  summary: 'Login user',
  description: 'Authenticate user with email and password. Returns 2FA token if 2FA is enabled.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: LoginRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Login successful or 2FA required',
      content: {
        'application/json': {
          schema: LoginResponseSchema,
        },
      },
    },
  },
});

const verifyTwoFactorRoute = createRoute({
  method: 'post',
  path: '/login/2fa',
  tags: ['Authentication'],
  summary: 'Verify 2FA code for login',
  description: 'Complete login by verifying TOTP code or backup code',
  request: {
    body: {
      content: {
        'application/json': {
          schema: VerifyTwoFactorRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: {
        'application/json': {
          schema: AuthResponseSchema,
        },
      },
    },
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/refresh',
  tags: ['Authentication'],
  summary: 'Refresh access token',
  description: 'Get a new access token using a refresh token',
  request: {
    body: {
      content: {
        'application/json': {
          schema: RefreshRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Tokens refreshed successfully',
      content: {
        'application/json': {
          schema: TokenResponseSchema,
        },
      },
    },
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/logout',
  tags: ['Authentication'],
  summary: 'Logout user',
  description: 'Invalidate the refresh token and end the session',
  request: {
    body: {
      content: {
        'application/json': {
          schema: RefreshRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Logged out successfully',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Authentication'],
  summary: 'Get current user',
  description: 'Get the currently authenticated user profile',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Current user data',
      content: {
        'application/json': {
          schema: CurrentUserSchema,
        },
      },
    },
  },
});

const updateProfileRoute = createRoute({
  method: 'patch',
  path: '/me',
  tags: ['Authentication'],
  summary: 'Update profile',
  description: 'Update the currently authenticated user profile',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: UpdateProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Profile updated successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: UserSchema,
          }),
        },
      },
    },
  },
});

const changePasswordRoute = createRoute({
  method: 'post',
  path: '/me/change-password',
  tags: ['Authentication'],
  summary: 'Change password',
  description: 'Change the currently authenticated user password',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ChangePasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password changed successfully',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

const getSessionsRoute = createRoute({
  method: 'get',
  path: '/me/sessions',
  tags: ['Authentication'],
  summary: 'Get active sessions',
  description: 'Get all active sessions for the current user',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'List of active sessions',
      content: {
        'application/json': {
          schema: SessionsListSchema,
        },
      },
    },
  },
});

const terminateSessionRoute = createRoute({
  method: 'delete',
  path: '/me/sessions/{sessionId}',
  tags: ['Authentication'],
  summary: 'Terminate a session',
  description: 'Terminate a specific session by ID',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      sessionId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Session terminated successfully',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

const TerminateOtherSessionsRequestSchema = z
  .object({
    refreshToken: z.string().min(1).openapi({ description: 'Current refresh token to identify current session' }),
  })
  .openapi('TerminateOtherSessionsRequest');

const terminateOtherSessionsRoute = createRoute({
  method: 'post',
  path: '/me/sessions/terminate-others',
  tags: ['Authentication'],
  summary: 'Terminate other sessions',
  description: 'Terminate all sessions except the current one',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: TerminateOtherSessionsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Other sessions terminated successfully',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

const githubLoginUrlRoute = createRoute({
  method: 'get',
  path: '/github/login-url',
  tags: ['Authentication'],
  summary: 'Get GitHub OAuth login URL',
  description: 'Returns the GitHub OAuth URL to redirect the user to for login/signup',
  responses: {
    200: {
      description: 'GitHub OAuth URL',
      content: {
        'application/json': {
          schema: GithubLoginUrlResponseSchema,
        },
      },
    },
  },
});

const githubLoginCallbackRoute = createRoute({
  method: 'post',
  path: '/github/login-callback',
  tags: ['Authentication'],
  summary: 'Handle GitHub OAuth login callback',
  description: 'Exchange OAuth code for user session. Creates account if first login.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: GithubLoginCallbackRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: {
        'application/json': {
          schema: LoginResponseSchema,
        },
      },
    },
  },
});

const forgotPasswordRoute = createRoute({
  method: 'post',
  path: '/forgot-password',
  tags: ['Authentication'],
  summary: 'Request password reset',
  description: 'Send a password reset token for the given email. Always returns success to avoid revealing whether an email exists.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: ForgotPasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password reset token sent (if email exists)',
      content: {
        'application/json': {
          schema: ForgotPasswordResponseSchema,
        },
      },
    },
  },
});

const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/reset-password',
  tags: ['Authentication'],
  summary: 'Reset password',
  description: 'Reset password using a valid reset token',
  request: {
    body: {
      content: {
        'application/json': {
          schema: ResetPasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password reset successfully',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

const sendVerificationEmailRoute = createRoute({
  method: 'post',
  path: '/verify-email/send',
  tags: ['Authentication'],
  summary: 'Send email verification',
  description: 'Send (or resend) the email verification link for the authenticated user',
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: 'Verification email sent',
      content: { 'application/json': { schema: MessageResponseSchema } },
    },
  },
});

const verifyEmailRoute = createRoute({
  method: 'post',
  path: '/verify-email/confirm',
  tags: ['Authentication'],
  summary: 'Confirm email verification',
  description: 'Verify email using the token from the verification link',
  request: {
    body: {
      content: { 'application/json': { schema: VerifyEmailRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Email verified successfully',
      content: { 'application/json': { schema: MessageResponseSchema } },
    },
  },
});

// ============ Router ============

const authRouter = new OpenAPIHono<AppEnv>();

// Apply rate limiting to sensitive auth endpoints
authRouter.use('/register', authRateLimiter);
authRouter.use('/login', authRateLimiter);
authRouter.use('/refresh', authRateLimiter);
authRouter.use('/forgot-password', passwordResetRateLimiter);
authRouter.use('/reset-password', passwordResetRateLimiter);

// Register
authRouter.openapi(registerRoute, async (c) => {
  const input = c.req.valid('json');
  const locale = c.get('locale');
  const result = await authService.register(input, locale);

  return c.json(
    {
      data: {
        user: result.user,
        organization: result.organization,
      },
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
    201
  );
});

// Login
authRouter.openapi(loginRoute, async (c) => {
  const input = c.req.valid('json');
  const locale = c.get('locale');
  const result = await authService.login(input, locale);

  // Check if 2FA is required
  if ('requiresTwoFactor' in result) {
    return c.json({
      requiresTwoFactor: true,
      twoFactorToken: result.twoFactorToken,
    });
  }

  return c.json({
    data: {
      user: result.user,
      organization: result.organization,
    },
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
});

// Verify 2FA for login
authRouter.use('/login/2fa', authRateLimiter);
authRouter.openapi(verifyTwoFactorRoute, async (c) => {
  const { twoFactorToken, code } = c.req.valid('json');
  const locale = c.get('locale');

  const result = await authService.verifyLoginTwoFactor(twoFactorToken, code, locale);

  return c.json({
    data: {
      user: result.user,
      organization: result.organization,
    },
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
});

// Refresh
authRouter.openapi(refreshRoute, async (c) => {
  const { refreshToken } = c.req.valid('json');
  const locale = c.get('locale');
  const tokens = await authService.refreshAccessToken(refreshToken, locale);

  return c.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
});

// Logout
authRouter.openapi(logoutRoute, async (c) => {
  const { refreshToken } = c.req.valid('json');
  const locale = c.get('locale');
  await authService.logout(refreshToken);

  return c.json({ message: t(locale, 'auth', 'logoutSuccess') });
});

// GitHub OAuth Login URL
authRouter.openapi(githubLoginUrlRoute, async (c) => {
  const { githubService } = await import('../services/github.service');
  const state = Math.random().toString(36).substring(2);
  const url = githubService.getAuthorizationUrl(state);
  return c.json({ url });
});

// GitHub OAuth Login Callback
authRouter.use('/github/login-callback', authRateLimiter);
authRouter.openapi(githubLoginCallbackRoute, async (c) => {
  const { code } = c.req.valid('json');
  const locale = c.get('locale');
  const ipAddress = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip');
  const userAgent = c.req.header('user-agent');

  const result = await authService.githubLogin(code, locale, ipAddress, userAgent);

  return c.json({
    data: {
      user: result.user,
      organization: result.organization,
    },
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
});

// Forgot Password
authRouter.openapi(forgotPasswordRoute, async (c) => {
  const { email } = c.req.valid('json');
  const locale = c.get('locale');
  const result = await authService.forgotPassword(email, locale);

  return c.json(result);
});

// Reset Password
authRouter.openapi(resetPasswordRoute, async (c) => {
  const { token, password } = c.req.valid('json');
  const locale = c.get('locale');
  const result = await authService.resetPassword(token, password, locale);

  return c.json(result);
});

// Email Verification — send link (requires auth)
authRouter.use('/verify-email/send', authMiddleware);
authRouter.openapi(sendVerificationEmailRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const result = await authService.sendVerificationEmail(userId, locale);
  return c.json(result);
});

// Email Verification — confirm token (public)
authRouter.openapi(verifyEmailRoute, async (c) => {
  const { token } = c.req.valid('json');
  const locale = c.get('locale');
  const result = await authService.verifyEmail(token, locale);
  return c.json(result);
});

// Me (protected)
authRouter.use('/me', authMiddleware);
authRouter.use('/me/*', authMiddleware);

authRouter.openapi(meRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const user = await authService.getCurrentUser(userId, locale);

  return c.json({
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt,
    },
  });
});

// Update Profile
authRouter.openapi(updateProfileRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const input = c.req.valid('json');

  const user = await authService.updateProfile(userId, input, locale);

  return c.json({ data: user });
});

// Change Password
authRouter.openapi(changePasswordRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const input = c.req.valid('json');

  const result = await authService.changePassword(userId, input, locale);

  return c.json(result);
});

// Get Sessions
authRouter.openapi(getSessionsRoute, async (c) => {
  const userId = c.get('userId')!;

  const sessions = await authService.getSessions(userId);

  return c.json({ data: sessions });
});

// Terminate Specific Session
authRouter.openapi(terminateSessionRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { sessionId } = c.req.valid('param');

  const result = await authService.terminateSession(userId, sessionId, locale);

  return c.json(result);
});

// Terminate Other Sessions
authRouter.openapi(terminateOtherSessionsRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { refreshToken } = c.req.valid('json');

  const result = await authService.terminateOtherSessions(userId, refreshToken, locale);

  return c.json(result);
});

// ============ Invitation Routes (public + authenticated) ============

// Get invitation info by token (public)
authRouter.get('/invitations/info', async (c) => {
  const token = c.req.query('token');
  const locale = c.get('locale');

  if (!token) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Token is required' } }, 400);
  }

  const info = await organizationService.getInvitationInfo(token, locale);
  return c.json({ data: info });
});

// Accept invitation (authenticated)
authRouter.post('/invitations/accept', authMiddleware, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { token } = await c.req.json();

  if (!token) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Token is required' } }, 400);
  }

  const result = await organizationService.acceptInvitation(token, userId, locale);
  return c.json({
    data: result,
    message: t(locale, 'organizations', 'invitationAccepted'),
  });
});

export { authRouter as authRoutes };
