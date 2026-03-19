import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { userRepository } from '../repositories/user.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { hashPassword, verifyPassword } from '../lib/password';
import { generateTokenPair, verifyToken, generateTwoFactorToken, verifyTwoFactorToken } from '../lib/jwt';
import { generateSlug, hashToken, generateRandomToken } from '../lib/utils';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';
import { sendPasswordResetEmail, sendEmailVerificationEmail } from '../lib/email';

// Types
interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

interface LoginInput {
  email: string;
  password: string;
}

interface AuthResult {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  accessToken: string;
  refreshToken: string;
}

interface TwoFactorRequiredResult {
  requiresTwoFactor: true;
  twoFactorToken: string;
}

type LoginResult = AuthResult | TwoFactorRequiredResult;

export const authService = {
  /**
   * Register a new user with a default organization
   */
  async register(input: RegisterInput, locale: SupportedLocale = 'en'): Promise<AuthResult> {
    const { email, password, name } = input;

    // Check if user already exists
    const existingUser = await userRepository.findByEmail(email);
    if (existingUser) {
      throw new HTTPException(409, { message: t(locale, 'auth', 'emailAlreadyRegistered') });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user and organization in transaction
    const result = await db.transaction(async () => {
      // Create user
      const newUser = await userRepository.create({
        email,
        passwordHash,
        name,
      });

      // Create default organization
      const orgSlug = generateSlug(name) + '-' + Math.random().toString(36).substring(2, 8);
      const newOrg = await organizationRepository.create({
        name: `${name}'s Workspace`,
        slug: orgSlug,
      });

      // Add user as owner
      await organizationRepository.addMember({
        organizationId: newOrg.id,
        userId: newUser.id,
        role: 'owner',
      });

      return { user: newUser, organization: newOrg };
    });

    // Generate tokens
    const { accessToken, refreshToken } = await generateTokenPair(
      result.user.id,
      result.organization.id
    );

    // Store session
    await this.createSession(result.user.id, refreshToken);

    // Send verification email (fire-and-forget)
    this.sendVerificationEmail(result.user.id, locale).catch(() => {});

    logger.info({ userId: result.user.id }, 'User registered successfully');

    return {
      user: result.user,
      organization: result.organization,
      accessToken,
      refreshToken,
    };
  },

  /**
   * Login user with email and password
   * Returns TwoFactorRequiredResult if 2FA is enabled
   */
  async login(input: LoginInput, locale: SupportedLocale = 'en'): Promise<LoginResult> {
    const { email, password } = input;

    // Find user
    const user = await userRepository.findByEmail(email);
    if (!user) {
      throw new HTTPException(401, { message: t(locale, 'auth', 'invalidCredentials') });
    }

    // OAuth-only users (no password) cannot log in with email/password
    if (!user.passwordHash) {
      throw new HTTPException(401, { message: t(locale, 'auth', 'invalidCredentials') });
    }

    // Verify password
    const isValidPassword = await verifyPassword(user.passwordHash, password);
    if (!isValidPassword) {
      throw new HTTPException(401, { message: t(locale, 'auth', 'invalidCredentials') });
    }

    // Get user's organization
    const membership = await organizationRepository.findUserFirstOrganization(user.id);
    if (!membership) {
      throw new HTTPException(500, { message: t(locale, 'auth', 'noOrganization') });
    }

    // Check if 2FA is enabled
    if (user.twoFactorEnabled) {
      // Generate a temporary token for 2FA verification
      const twoFactorToken = await generateTwoFactorToken(user.id, membership.organization.id);

      logger.info({ userId: user.id }, '2FA required for login');

      return {
        requiresTwoFactor: true,
        twoFactorToken,
      };
    }

    // Generate tokens
    const { accessToken, refreshToken } = await generateTokenPair(
      user.id,
      membership.organization.id
    );

    // Store session
    await this.createSession(user.id, refreshToken);

    logger.info({ userId: user.id }, 'User logged in successfully');

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
      accessToken,
      refreshToken,
    };
  },

  /**
   * Complete login after 2FA verification
   */
  async verifyLoginTwoFactor(
    twoFactorToken: string,
    code: string,
    locale: SupportedLocale = 'en'
  ): Promise<AuthResult> {
    // Verify the 2FA token
    let payload;
    try {
      payload = await verifyTwoFactorToken(twoFactorToken);
    } catch {
      throw new HTTPException(401, { message: t(locale, 'auth', 'invalidToken') });
    }

    const userId = payload.sub!;
    const organizationId = payload.org;

    // Find user
    const fullUser = await userRepository.findById(userId);
    if (!fullUser) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    }

    // Import and use 2FA service to verify code
    const { twoFactorService } = await import('./twoFactor.service');

    // Try TOTP first
    let isValid = await twoFactorService.verifyCode(userId, code, locale);

    // If TOTP fails and code looks like a backup code (8 chars), try backup
    if (!isValid && code.length === 8) {
      isValid = await twoFactorService.verifyBackupCode(userId, code, locale);
    }

    if (!isValid) {
      throw new HTTPException(401, { message: t(locale, 'twoFactor', 'invalidCode') });
    }

    // Get organization details
    const membership = await organizationRepository.findUserFirstOrganization(userId);
    if (!membership) {
      throw new HTTPException(500, { message: t(locale, 'auth', 'noOrganization') });
    }

    // Generate tokens
    const { accessToken, refreshToken } = await generateTokenPair(userId, organizationId);

    // Store session
    await this.createSession(userId, refreshToken);

    logger.info({ userId }, 'User logged in with 2FA successfully');

    return {
      user: {
        id: fullUser.id,
        email: fullUser.email,
        name: fullUser.name,
        avatarUrl: fullUser.avatarUrl,
        emailVerified: fullUser.emailVerified,
        twoFactorEnabled: fullUser.twoFactorEnabled,
      },
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
      accessToken,
      refreshToken,
    };
  },

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(
    refreshToken: string,
    locale: SupportedLocale = 'en'
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // Verify token
    const payload = await verifyToken(refreshToken);
    if (payload.type !== 'refresh') {
      throw new HTTPException(401, { message: t(locale, 'auth', 'invalidRefreshToken') });
    }

    const userId = payload.sub!;

    // Verify session exists
    const tokenHash = await hashToken(refreshToken);
    const session = await userRepository.findSessionByTokenHash(tokenHash);
    if (!session) {
      throw new HTTPException(401, { message: t(locale, 'auth', 'sessionNotFound') });
    }

    // Get user's organization
    const membership = await organizationRepository.findUserFirstOrganization(userId);

    // Generate new tokens (rotation)
    const tokens = await generateTokenPair(userId, membership?.organizationId);

    // Rotate session
    await userRepository.deleteSessionByTokenHash(tokenHash);
    await this.createSession(userId, tokens.refreshToken);

    return tokens;
  },

  /**
   * Logout user by invalidating refresh token
   */
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = await hashToken(refreshToken);
    await userRepository.deleteSessionByTokenHash(tokenHash);
  },

  /**
   * Create a new session for user
   */
  async createSession(
    userId: string,
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    const tokenHash = await hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await userRepository.createSession({
      userId,
      tokenHash,
      ipAddress,
      userAgent,
      expiresAt,
    });
  },

  /**
   * Get current user by ID
   */
  async getCurrentUser(userId: string, locale: SupportedLocale = 'en') {
    const user = await userRepository.findByIdPublic(userId);
    if (!user) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    }
    return user;
  },

  /**
   * Update user profile
   */
  async updateProfile(
    userId: string,
    input: { name?: string; avatarUrl?: string | null },
    locale: SupportedLocale = 'en'
  ) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    }

    const updatedUser = await userRepository.update(userId, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
    });

    logger.info({ userId }, 'User profile updated');

    return {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      avatarUrl: updatedUser.avatarUrl,
    };
  },

  /**
   * Change user password
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    locale: SupportedLocale = 'en'
  ) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    }

    // Verify current password
    if (!user.passwordHash) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'currentPasswordIncorrect') });
    }
    const isValidPassword = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!isValidPassword) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'currentPasswordIncorrect') });
    }

    // Check new password is different
    const isSamePassword = await verifyPassword(user.passwordHash, input.newPassword);
    if (isSamePassword) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'newPasswordSameAsCurrent') });
    }

    // Hash and update password
    const newPasswordHash = await hashPassword(input.newPassword);
    await userRepository.update(userId, { passwordHash: newPasswordHash });

    logger.info({ userId }, 'User password changed');

    return { message: t(locale, 'auth', 'passwordChanged') };
  },

  /**
   * Get all sessions for user
   */
  async getSessions(userId: string) {
    const sessions = await userRepository.findAllSessionsByUserId(userId);

    return sessions.map((session) => ({
      id: session.id,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    }));
  },

  /**
   * Terminate a specific session
   */
  async terminateSession(
    userId: string,
    sessionId: string,
    locale: SupportedLocale = 'en'
  ) {
    const session = await userRepository.findSessionById(sessionId);

    if (!session || session.userId !== userId) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'sessionNotFound') });
    }

    await userRepository.deleteSessionById(sessionId);

    logger.info({ userId, sessionId }, 'Session terminated');

    return { message: t(locale, 'auth', 'sessionTerminated') };
  },

  /**
   * Terminate all other sessions (logout from other devices)
   */
  async terminateOtherSessions(
    userId: string,
    refreshToken: string,
    locale: SupportedLocale = 'en'
  ) {
    // Hash the refresh token to find the current session
    const tokenHash = await hashToken(refreshToken);
    const currentSession = await userRepository.findSessionByTokenHash(tokenHash);

    if (!currentSession) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'sessionNotFound') });
    }

    await userRepository.deleteOtherSessions(userId, currentSession.id);

    logger.info({ userId }, 'All other sessions terminated');

    return { message: t(locale, 'auth', 'otherSessionsTerminated') };
  },

  /**
   * GitHub OAuth login — creates or finds user, returns JWT
   */
  async githubLogin(
    code: string,
    locale: SupportedLocale = 'en',
    ipAddress?: string,
    userAgent?: string
  ): Promise<AuthResult> {
    const { githubService } = await import('./github.service');

    // Exchange code for token
    const tokenData = await githubService.exchangeCodeForToken(code);

    // Get GitHub user profile
    const githubUser = await githubService.getUser(tokenData.access_token);

    // GitHub users need an email — fetch from /user/emails if not public
    let email = githubUser.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      if (emailsRes.ok) {
        const emails: Array<{ email: string; primary: boolean; verified: boolean }> = await emailsRes.json();
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email ?? emails[0]?.email ?? null;
      }
    }

    if (!email) {
      throw new HTTPException(400, { message: 'GitHub account has no public email. Please add a public email to your GitHub profile.' });
    }

    const githubId = String(githubUser.id);
    const displayName = githubUser.name ?? githubUser.login;

    // Find existing user by GitHub ID or email
    let user = await userRepository.findByGithubId(githubId);

    if (!user) {
      // Try by email (link account if email matches)
      const existingByEmail = await userRepository.findByEmail(email);
      if (existingByEmail) {
        // Link GitHub ID to existing account
        user = await userRepository.update(existingByEmail.id, {
          githubId,
          avatarUrl: existingByEmail.avatarUrl ?? githubUser.avatar_url,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        });
      } else {
        // Create new user (no password for OAuth)
        const newUser = await userRepository.create({
          email: email.toLowerCase(),
          passwordHash: null,
          name: displayName,
          avatarUrl: githubUser.avatar_url ?? null,
        });
        user = await userRepository.update(newUser.id, {
          githubId,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        });

        // Create default organization
        const orgSlug = generateSlug(githubUser.login) + '-' + Math.random().toString(36).substring(2, 8);
        const org = await organizationRepository.create({
          name: `${displayName}'s Workspace`,
          slug: orgSlug,
        });
        await organizationRepository.addMember({
          organizationId: org.id,
          userId: newUser.id,
          role: 'owner',
        });
      }
    }

    if (!user) {
      throw new HTTPException(500, { message: t(locale, 'auth', 'noOrganization') });
    }

    const membership = await organizationRepository.findUserFirstOrganization(user.id);
    if (!membership) {
      throw new HTTPException(500, { message: t(locale, 'auth', 'noOrganization') });
    }

    // Generate JWT pair & create session
    const tokens = await generateTokenPair(user.id, membership.organization.id);
    await this.createSession(user.id, tokens.refreshToken, ipAddress, userAgent);

    logger.info({ userId: user.id, provider: 'github' }, 'OAuth login successful');

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl ?? null,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
      },
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
      ...tokens,
    };
  },

  /**
   * Google OAuth login — creates or finds user, returns JWT
   */
  async googleLogin(
    code: string,
    locale: SupportedLocale = 'en',
    ipAddress?: string,
    userAgent?: string
  ): Promise<AuthResult> {
    const { googleService } = await import('./google.service');

    // Exchange code for token
    const tokenData = await googleService.exchangeCodeForToken(code);

    // Get Google user profile
    const googleUser = await googleService.getUser(tokenData.access_token);

    if (!googleUser.email) {
      throw new HTTPException(400, { message: 'Google account has no email address.' });
    }

    const googleId = googleUser.id;
    const displayName = googleUser.name || googleUser.email.split('@')[0];

    // Find existing user by Google ID or email
    let user = await userRepository.findByGoogleId(googleId);

    if (!user) {
      // Try by email (link account if email matches)
      const existingByEmail = await userRepository.findByEmail(googleUser.email);
      if (existingByEmail) {
        // Link Google ID to existing account
        user = await userRepository.update(existingByEmail.id, {
          googleId,
          avatarUrl: existingByEmail.avatarUrl ?? googleUser.picture,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        });
      } else {
        // Create new user (no password for OAuth)
        const newUser = await userRepository.create({
          email: googleUser.email.toLowerCase(),
          passwordHash: null,
          name: displayName,
          avatarUrl: googleUser.picture ?? null,
        });
        user = await userRepository.update(newUser.id, {
          googleId,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        });

        // Create default organization
        const orgSlug = generateSlug(displayName) + '-' + Math.random().toString(36).substring(2, 8);
        const org = await organizationRepository.create({
          name: `${displayName}'s Workspace`,
          slug: orgSlug,
        });
        await organizationRepository.addMember({
          organizationId: org.id,
          userId: newUser.id,
          role: 'owner',
        });
      }
    }

    if (!user) {
      throw new HTTPException(500, { message: t(locale, 'auth', 'noOrganization') });
    }

    const membership = await organizationRepository.findUserFirstOrganization(user.id);
    if (!membership) {
      throw new HTTPException(500, { message: t(locale, 'auth', 'noOrganization') });
    }

    // Generate JWT pair & create session
    const tokens = await generateTokenPair(user.id, membership.organization.id);
    await this.createSession(user.id, tokens.refreshToken, ipAddress, userAgent);

    logger.info({ userId: user.id, provider: 'google' }, 'OAuth login successful');

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl ?? null,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
      },
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
      ...tokens,
    };
  },

  /**
   * Forgot password - generates a reset token
   * Always returns success to avoid revealing whether an email exists
   */
  async forgotPassword(
    email: string,
    locale: SupportedLocale = 'en'
  ): Promise<{ message: string; resetToken?: string }> {
    const user = await userRepository.findByEmail(email);

    if (!user) {
      // Don't reveal whether the email exists
      return { message: t(locale, 'auth', 'passwordResetTokenSent') };
    }

    // Delete any existing reset tokens for this user
    await userRepository.deletePasswordResetTokensByUserId(user.id);

    // Generate a random token (URL-safe hex)
    const resetToken = generateRandomToken(32);
    const tokenHash = await hashToken(resetToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store the hashed token
    await userRepository.createPasswordResetToken({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    logger.info({ userId: user.id }, 'Password reset token generated');

    // Send reset email (fire-and-forget, won't throw)
    await sendPasswordResetEmail(user.email, resetToken, locale as 'en' | 'tr');

    return {
      message: t(locale, 'auth', 'passwordResetTokenSent'),
    };
  },

  /**
   * Reset password using a reset token
   */
  async resetPassword(
    token: string,
    newPassword: string,
    locale: SupportedLocale = 'en'
  ): Promise<{ message: string }> {
    // Hash the provided token to look it up
    const tokenHash = await hashToken(token);
    const resetToken = await userRepository.findPasswordResetTokenByHash(tokenHash);

    if (!resetToken) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'passwordResetTokenInvalid') });
    }

    // Check if the token has expired
    if (new Date() > resetToken.expiresAt) {
      // Clean up expired token
      await userRepository.deletePasswordResetTokensByUserId(resetToken.userId);
      throw new HTTPException(400, { message: t(locale, 'auth', 'passwordResetTokenExpired') });
    }

    // Hash the new password and update the user
    const newPasswordHash = await hashPassword(newPassword);
    await userRepository.update(resetToken.userId, { passwordHash: newPasswordHash });

    // Delete all reset tokens for this user
    await userRepository.deletePasswordResetTokensByUserId(resetToken.userId);

    logger.info({ userId: resetToken.userId }, 'Password reset successfully');

    return { message: t(locale, 'auth', 'passwordResetSuccess') };
  },

  /**
   * Send email verification link
   */
  async sendVerificationEmail(
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<{ message: string }> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    }

    if (user.emailVerified) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'emailAlreadyVerified') });
    }

    // Delete any existing tokens for this user
    await userRepository.deleteEmailVerificationTokensByUserId(userId);

    const rawToken = await generateRandomToken();
    const tokenHash = await hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await userRepository.createEmailVerificationToken({ userId, tokenHash, expiresAt });

    await sendEmailVerificationEmail(user.email, rawToken, locale as 'en' | 'tr');

    logger.info({ userId }, 'Email verification sent');

    return { message: t(locale, 'auth', 'emailVerificationSent') };
  },

  /**
   * Confirm email with token from link
   */
  async verifyEmail(
    token: string,
    locale: SupportedLocale = 'en'
  ): Promise<{ message: string }> {
    const tokenHash = await hashToken(token);
    const record = await userRepository.findEmailVerificationTokenByHash(tokenHash);

    if (!record) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'emailVerificationInvalid') });
    }

    if (new Date() > record.expiresAt) {
      await userRepository.deleteEmailVerificationTokensByUserId(record.userId);
      throw new HTTPException(400, { message: t(locale, 'auth', 'emailVerificationInvalid') });
    }

    await userRepository.update(record.userId, {
      emailVerified: true,
      emailVerifiedAt: new Date(),
    });
    await userRepository.deleteEmailVerificationTokensByUserId(record.userId);

    logger.info({ userId: record.userId }, 'Email verified');

    return { message: t(locale, 'auth', 'emailVerified') };
  },
};
