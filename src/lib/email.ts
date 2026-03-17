import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

// ============ Transporter ============

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: env.GMAIL_USER,
    pass: env.GMAIL_APP_PASSWORD,
  },
});

const FROM_ADDRESS = env.GMAIL_USER
  ? `"${env.GMAIL_FROM_NAME}" <${env.GMAIL_USER}>`
  : '"Pushify" <noreply@pushify.dev>';

// ============ Templates ============

function baseTemplate(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pushify</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0f;min-height:100vh;">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color:#06b6d4;border-radius:10px;width:40px;height:40px;text-align:center;vertical-align:middle;">
                    <span style="color:#0a0a0f;font-weight:900;font-size:20px;line-height:40px;">P</span>
                  </td>
                  <td style="padding-left:10px;vertical-align:middle;">
                    <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">Pushify</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#111118;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:40px 36px;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="color:#4b5563;font-size:12px;margin:0;">
                &copy; ${new Date().getFullYear()} Pushify. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function passwordResetTemplate(resetUrl: string, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Reset your password',
      greeting: 'Hi there,',
      body: 'We received a request to reset the password for your Pushify account. Click the button below to set a new password.',
      button: 'Reset Password',
      expiry: 'This link will expire in <strong style="color:#e2e8f0;">1 hour</strong>.',
      ignore: "If you didn't request a password reset, you can safely ignore this email — your password won't be changed.",
      urlLabel: 'Or copy and paste this URL into your browser:',
    },
    tr: {
      title: 'Şifrenizi sıfırlayın',
      greeting: 'Merhaba,',
      body: 'Pushify hesabınız için şifre sıfırlama talebi aldık. Yeni bir şifre belirlemek için aşağıdaki butona tıklayın.',
      button: 'Şifreyi Sıfırla',
      expiry: 'Bu bağlantı <strong style="color:#e2e8f0;">1 saat</strong> içinde geçerliliğini yitirecektir.',
      ignore: 'Şifre sıfırlama talebinde bulunmadıysanız bu e-postayı güvenle yok sayabilirsiniz — şifreniz değiştirilmeyecektir.',
      urlLabel: "Ya da bu URL'yi tarayıcınıza kopyalayıp yapıştırın:",
    },
  };

  const t = texts[locale] ?? texts.en;

  return baseTemplate(`
    <!-- Title -->
    <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0 0 8px 0;letter-spacing:-0.5px;">${t.title}</h1>

    <!-- Greeting -->
    <p style="color:#9ca3af;font-size:15px;line-height:1.6;margin:0 0 20px 0;">${t.greeting}</p>
    <p style="color:#9ca3af;font-size:15px;line-height:1.6;margin:0 0 32px 0;">${t.body}</p>

    <!-- Button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td align="center">
          <a href="${resetUrl}"
             style="display:inline-block;background-color:#06b6d4;color:#0a0a0f;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;letter-spacing:-0.2px;">
            ${t.button}
          </a>
        </td>
      </tr>
    </table>

    <!-- Divider -->
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:0 0 24px 0;" />

    <!-- Expiry -->
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 16px 0;">${t.expiry}</p>

    <!-- Ignore note -->
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 24px 0;">${t.ignore}</p>

    <!-- Raw URL fallback -->
    <p style="color:#6b7280;font-size:12px;margin:0 0 8px 0;">${t.urlLabel}</p>
    <p style="margin:0;">
      <a href="${resetUrl}" style="color:#06b6d4;font-size:12px;word-break:break-all;text-decoration:none;">${resetUrl}</a>
    </p>
  `);
}

function emailVerificationTemplate(verifyUrl: string, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Verify your email address',
      greeting: 'Hi there,',
      body: 'Thanks for signing up for Pushify! Please verify your email address by clicking the button below.',
      button: 'Verify Email',
      expiry: 'This link will expire in <strong style="color:#e2e8f0;">24 hours</strong>.',
      ignore: "If you didn't create a Pushify account, you can safely ignore this email.",
      urlLabel: 'Or copy and paste this URL into your browser:',
    },
    tr: {
      title: 'E-posta adresinizi doğrulayın',
      greeting: 'Merhaba,',
      body: "Pushify'a kaydolduğunuz için teşekkürler! E-posta adresinizi aşağıdaki butona tıklayarak doğrulayın.",
      button: 'E-postayı Doğrula',
      expiry: 'Bu bağlantı <strong style="color:#e2e8f0;">24 saat</strong> içinde geçerliliğini yitirecektir.',
      ignore: 'Bir Pushify hesabı oluşturmadıysanız bu e-postayı güvenle yok sayabilirsiniz.',
      urlLabel: "Ya da bu URL'yi tarayıcınıza kopyalayıp yapıştırın:",
    },
  };

  const t = texts[locale] ?? texts.en;

  return baseTemplate(`
    <!-- Title -->
    <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0 0 8px 0;letter-spacing:-0.5px;">${t.title}</h1>

    <!-- Greeting -->
    <p style="color:#9ca3af;font-size:15px;line-height:1.6;margin:0 0 20px 0;">${t.greeting}</p>
    <p style="color:#9ca3af;font-size:15px;line-height:1.6;margin:0 0 32px 0;">${t.body}</p>

    <!-- Button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td align="center">
          <a href="${verifyUrl}"
             style="display:inline-block;background-color:#06b6d4;color:#0a0a0f;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;letter-spacing:-0.2px;">
            ${t.button}
          </a>
        </td>
      </tr>
    </table>

    <!-- Divider -->
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:0 0 24px 0;" />

    <!-- Expiry -->
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 16px 0;">${t.expiry}</p>

    <!-- Ignore note -->
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 24px 0;">${t.ignore}</p>

    <!-- Raw URL fallback -->
    <p style="color:#6b7280;font-size:12px;margin:0 0 8px 0;">${t.urlLabel}</p>
    <p style="margin:0;">
      <a href="${verifyUrl}" style="color:#06b6d4;font-size:12px;word-break:break-all;text-decoration:none;">${verifyUrl}</a>
    </p>
  `);
}

function orgInvitationTemplate(
  inviteUrl: string,
  orgName: string,
  inviterName: string,
  role: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: `You've been invited to join ${orgName}`,
      greeting: 'Hi there,',
      body: `<strong style="color:#e2e8f0;">${inviterName}</strong> has invited you to join <strong style="color:#e2e8f0;">${orgName}</strong> as a <strong style="color:#e2e8f0;">${role}</strong>.`,
      button: 'Accept Invitation',
      expiry: 'This invitation will expire in <strong style="color:#e2e8f0;">7 days</strong>.',
      ignore: "If you weren't expecting this invitation, you can safely ignore this email.",
      urlLabel: 'Or copy and paste this URL into your browser:',
    },
    tr: {
      title: `${orgName} organizasyonuna davet edildiniz`,
      greeting: 'Merhaba,',
      body: `<strong style="color:#e2e8f0;">${inviterName}</strong> sizi <strong style="color:#e2e8f0;">${orgName}</strong> organizasyonuna <strong style="color:#e2e8f0;">${role}</strong> olarak katılmaya davet etti.`,
      button: 'Daveti Kabul Et',
      expiry: 'Bu davet <strong style="color:#e2e8f0;">7 gün</strong> içinde geçerliliğini yitirecektir.',
      ignore: 'Bu daveti beklemiyorsanız bu e-postayı güvenle yok sayabilirsiniz.',
      urlLabel: "Ya da bu URL'yi tarayıcınıza kopyalayıp yapıştırın:",
    },
  };

  const t = texts[locale] ?? texts.en;

  return baseTemplate(`
    <!-- Title -->
    <h1 style="color:#ffffff;font-size:24px;font-weight:700;margin:0 0 8px 0;letter-spacing:-0.5px;">${t.title}</h1>

    <!-- Greeting -->
    <p style="color:#9ca3af;font-size:15px;line-height:1.6;margin:0 0 20px 0;">${t.greeting}</p>
    <p style="color:#9ca3af;font-size:15px;line-height:1.6;margin:0 0 32px 0;">${t.body}</p>

    <!-- Button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td align="center">
          <a href="${inviteUrl}"
             style="display:inline-block;background-color:#06b6d4;color:#0a0a0f;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;letter-spacing:-0.2px;">
            ${t.button}
          </a>
        </td>
      </tr>
    </table>

    <!-- Divider -->
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:0 0 24px 0;" />

    <!-- Expiry -->
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 16px 0;">${t.expiry}</p>

    <!-- Ignore note -->
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 24px 0;">${t.ignore}</p>

    <!-- Raw URL fallback -->
    <p style="color:#6b7280;font-size:12px;margin:0 0 8px 0;">${t.urlLabel}</p>
    <p style="margin:0;">
      <a href="${inviteUrl}" style="color:#06b6d4;font-size:12px;word-break:break-all;text-decoration:none;">${inviteUrl}</a>
    </p>
  `);
}

// ============ Send Functions ============

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping password reset email');
    return;
  }

  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  const subjects = {
    en: 'Reset your Pushify password',
    tr: 'Pushify şifrenizi sıfırlayın',
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: passwordResetTemplate(resetUrl, locale),
    });

    logger.info({ to }, 'Password reset email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send password reset email');
    // Don't throw — email failure shouldn't block the API response
  }
}

export async function sendEmailVerificationEmail(
  to: string,
  verificationToken: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping email verification email');
    return;
  }

  const verifyUrl = `${env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

  const subjects = {
    en: 'Verify your Pushify email address',
    tr: 'Pushify e-posta adresinizi doğrulayın',
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: emailVerificationTemplate(verifyUrl, locale),
    });

    logger.info({ to }, 'Email verification email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send email verification email');
  }
}

export async function sendOrgInvitationEmail(
  to: string,
  invitationToken: string,
  orgName: string,
  inviterName: string,
  role: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping org invitation email');
    return;
  }

  const inviteUrl = `${env.FRONTEND_URL}/accept-invitation?token=${invitationToken}`;

  const subjects = {
    en: `You've been invited to join ${orgName} on Pushify`,
    tr: `Pushify'da ${orgName} organizasyonuna davet edildiniz`,
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: orgInvitationTemplate(inviteUrl, orgName, inviterName, role, locale),
    });

    logger.info({ to, orgName }, 'Org invitation email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send org invitation email');
  }
}

export async function verifyEmailConnection(): Promise<boolean> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return false;
  try {
    await transporter.verify();
    return true;
  } catch {
    return false;
  }
}
