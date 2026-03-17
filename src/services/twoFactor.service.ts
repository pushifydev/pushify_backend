import { generateSecret, verify, generateURI } from 'otplib';
import * as QRCode from 'qrcode';
import crypto from 'crypto';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { encrypt, decrypt } from '../lib/encryption';
import { hashPassword, verifyPassword } from '../lib/password';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

// Constants
const BACKUP_CODES_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;
const APP_NAME = 'Pushify';

export interface TwoFactorSetupResult {
  secret: string;
  qrCodeUrl: string;
  backupCodes: string[];
}

export interface TwoFactorStatus {
  enabled: boolean;
  hasBackupCodes: boolean;
}

export const twoFactorService = {
  /**
   * Generate a new TOTP secret and QR code for setup
   */
  async generateSetup(userId: string, userEmail: string): Promise<TwoFactorSetupResult> {
    // Generate a new secret
    const secret = generateSecret();

    // Generate OTP Auth URL for QR code
    const otpAuthUrl = generateURI({
      issuer: APP_NAME,
      label: userEmail,
      secret,
    });

    // Generate QR code as data URL
    const qrCodeUrl = await QRCode.toDataURL(otpAuthUrl);

    // Generate backup codes
    const backupCodes = this.generateBackupCodes();

    // Store the secret temporarily (encrypted) - will be confirmed when user verifies
    // We don't enable 2FA until the user successfully verifies a code
    const encryptedSecret = encrypt(secret);

    await db
      .update(users)
      .set({
        twoFactorSecret: encryptedSecret,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    logger.info({ userId }, '2FA setup initiated');

    return {
      secret, // Return plain secret for manual entry
      qrCodeUrl,
      backupCodes,
    };
  },

  /**
   * Verify TOTP code and enable 2FA
   */
  async verifyAndEnable(
    userId: string,
    code: string,
    backupCodes: string[],
    locale: SupportedLocale = 'en'
  ): Promise<void> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    }

    if (!user.twoFactorSecret) {
      throw new HTTPException(400, { message: t(locale, 'twoFactor', 'setupRequired') });
    }

    if (user.twoFactorEnabled) {
      throw new HTTPException(400, { message: t(locale, 'twoFactor', 'alreadyEnabled') });
    }

    // Decrypt the secret and verify the code
    const secret = decrypt(user.twoFactorSecret);
    const result = await verify({ token: code, secret });

    if (!result.valid) {
      throw new HTTPException(400, { message: t(locale, 'twoFactor', 'invalidCode') });
    }

    // Hash backup codes before storing
    const hashedBackupCodes = await Promise.all(
      backupCodes.map((code) => hashPassword(code))
    );

    // Enable 2FA and store hashed backup codes
    await db
      .update(users)
      .set({
        twoFactorEnabled: true,
        twoFactorBackupCodes: JSON.stringify(hashedBackupCodes),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    logger.info({ userId }, '2FA enabled successfully');
  },

  /**
   * Verify a TOTP code for login
   */
  async verifyCode(userId: string, code: string, locale: SupportedLocale = 'en'): Promise<boolean> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new HTTPException(400, { message: t(locale, 'twoFactor', 'notEnabled') });
    }

    const secret = decrypt(user.twoFactorSecret);
    const result = await verify({ token: code, secret });
    return result.valid;
  },

  /**
   * Verify a backup code and invalidate it
   */
  async verifyBackupCode(
    userId: string,
    code: string,
    locale: SupportedLocale = 'en'
  ): Promise<boolean> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user || !user.twoFactorEnabled) {
      throw new HTTPException(400, { message: t(locale, 'twoFactor', 'notEnabled') });
    }

    if (!user.twoFactorBackupCodes) {
      throw new HTTPException(400, { message: t(locale, 'twoFactor', 'noBackupCodes') });
    }

    const hashedCodes: string[] = JSON.parse(user.twoFactorBackupCodes);

    // Find and verify the backup code
    for (let i = 0; i < hashedCodes.length; i++) {
      const isValid = await verifyPassword(code, hashedCodes[i]);
      if (isValid) {
        // Remove the used backup code
        hashedCodes.splice(i, 1);

        await db
          .update(users)
          .set({
            twoFactorBackupCodes: JSON.stringify(hashedCodes),
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));

        logger.info({ userId }, 'Backup code used for 2FA');
        return true;
      }
    }

    return false;
  },

  /**
   * Disable 2FA
   */
  async disable(
    userId: string,
    password: string,
    locale: SupportedLocale = 'en'
  ): Promise<void> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    }

    // Verify password before disabling 2FA
    if (!user.passwordHash) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'invalidPassword') });
    }
    const isPasswordValid = await verifyPassword(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'invalidPassword') });
    }

    await db
      .update(users)
      .set({
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorBackupCodes: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    logger.info({ userId }, '2FA disabled');
  },

  /**
   * Regenerate backup codes
   */
  async regenerateBackupCodes(
    userId: string,
    password: string,
    locale: SupportedLocale = 'en'
  ): Promise<string[]> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    }

    if (!user.twoFactorEnabled) {
      throw new HTTPException(400, { message: t(locale, 'twoFactor', 'notEnabled') });
    }

    // Verify password
    if (!user.passwordHash) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'invalidPassword') });
    }
    const isPasswordValid = await verifyPassword(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'invalidPassword') });
    }

    // Generate new backup codes
    const backupCodes = this.generateBackupCodes();
    const hashedBackupCodes = await Promise.all(
      backupCodes.map((code) => hashPassword(code))
    );

    await db
      .update(users)
      .set({
        twoFactorBackupCodes: JSON.stringify(hashedBackupCodes),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    logger.info({ userId }, 'Backup codes regenerated');

    return backupCodes;
  },

  /**
   * Get 2FA status for a user
   */
  async getStatus(userId: string): Promise<TwoFactorStatus> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        twoFactorEnabled: true,
        twoFactorBackupCodes: true,
      },
    });

    if (!user) {
      return { enabled: false, hasBackupCodes: false };
    }

    let backupCodesCount = 0;
    if (user.twoFactorBackupCodes) {
      try {
        const codes = JSON.parse(user.twoFactorBackupCodes);
        backupCodesCount = codes.length;
      } catch {
        backupCodesCount = 0;
      }
    }

    return {
      enabled: user.twoFactorEnabled,
      hasBackupCodes: backupCodesCount > 0,
    };
  },

  /**
   * Check if user has 2FA enabled
   */
  async isEnabled(userId: string): Promise<boolean> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { twoFactorEnabled: true },
    });

    return user?.twoFactorEnabled ?? false;
  },

  /**
   * Generate random backup codes
   */
  generateBackupCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < BACKUP_CODES_COUNT; i++) {
      // Generate random alphanumeric code (uppercase)
      const code = crypto
        .randomBytes(BACKUP_CODE_LENGTH)
        .toString('hex')
        .slice(0, BACKUP_CODE_LENGTH)
        .toUpperCase();
      codes.push(code);
    }
    return codes;
  },
};
