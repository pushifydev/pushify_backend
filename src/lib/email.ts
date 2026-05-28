import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';
import {
  renderTransactionalEmail,
  renderNotificationEmail,
  getNotificationEventEmoji,
  getNotificationEventTitle,
} from './email-templates';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Re-export for notification worker / service
export {
  renderNotificationEmail,
  getNotificationEventEmoji,
  getNotificationEventTitle,
};

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

// ============ Transactional templates ============

function passwordResetTemplate(resetUrl: string, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Reset your password',
      greeting: 'Hi there,',
      body: 'We received a request to reset the password for your Pushify account. Click the button below to choose a new password.',
      button: 'Reset password',
      expiry: 'This link expires in <strong style="color:#fafafa;">1 hour</strong>.',
      ignore: "If you didn't request this, you can ignore this email — your password will not change.",
      urlLabel: 'Or copy this link into your browser:',
    },
    tr: {
      title: 'Şifrenizi sıfırlayın',
      greeting: 'Merhaba,',
      body: 'Pushify hesabınız için şifre sıfırlama talebi aldık. Yeni şifre belirlemek için aşağıdaki butona tıklayın.',
      button: 'Şifreyi sıfırla',
      expiry: 'Bu bağlantı <strong style="color:#fafafa;">1 saat</strong> içinde geçersiz olur.',
      ignore: 'Bu talebi siz yapmadıysanız e-postayı yok sayabilirsiniz — şifreniz değişmeyecektir.',
      urlLabel: 'Bağlantıyı tarayıcıya yapıştırabilirsiniz:',
    },
  };

  const t = texts[locale] ?? texts.en;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    body: t.body,
    button: { href: resetUrl, label: t.button },
    notes: [t.expiry, t.ignore],
    urlFallback: { label: t.urlLabel, href: resetUrl },
  });
}

function emailVerificationTemplate(verifyUrl: string, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Verify your email',
      greeting: 'Hi there,',
      body: 'Thanks for signing up for Pushify. Confirm your email address to finish setting up your account.',
      button: 'Verify email',
      expiry: 'This link expires in <strong style="color:#fafafa;">24 hours</strong>.',
      ignore: "If you didn't create an account, you can ignore this email.",
      urlLabel: 'Or copy this link into your browser:',
    },
    tr: {
      title: 'E-postanızı doğrulayın',
      greeting: 'Merhaba,',
      body: "Pushify'a hoş geldiniz. Hesabınızı tamamlamak için e-posta adresinizi doğrulayın.",
      button: 'E-postayı doğrula',
      expiry: 'Bu bağlantı <strong style="color:#fafafa;">24 saat</strong> içinde geçersiz olur.',
      ignore: 'Hesap oluşturmadıysanız bu e-postayı yok sayabilirsiniz.',
      urlLabel: 'Bağlantıyı tarayıcıya yapıştırabilirsiniz:',
    },
  };

  const t = texts[locale] ?? texts.en;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    body: t.body,
    button: { href: verifyUrl, label: t.button },
    notes: [t.expiry, t.ignore],
    urlFallback: { label: t.urlLabel, href: verifyUrl },
  });
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
      title: `Join ${orgName} on Pushify`,
      greeting: 'Hi there,',
      button: 'Accept invitation',
      expiry: 'This invitation expires in <strong style="color:#fafafa;">7 days</strong>.',
      ignore: "If you weren't expecting this, you can ignore this email.",
      urlLabel: 'Or copy this link into your browser:',
    },
    tr: {
      title: `${orgName} — Pushify daveti`,
      greeting: 'Merhaba,',
      button: 'Daveti kabul et',
      expiry: 'Bu davet <strong style="color:#fafafa;">7 gün</strong> içinde geçersiz olur.',
      ignore: 'Bu daveti beklemiyorsanız e-postayı yok sayabilirsiniz.',
      urlLabel: 'Bağlantıyı tarayıcıya yapıştırabilirsiniz:',
    },
  };

  const t = texts[locale] ?? texts.en;
  const safeOrg = esc(orgName);
  const safeInviter = esc(inviterName);
  const safeRole = esc(role);
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#fafafa;">${safeInviter}</strong>, sizi <strong style="color:#fafafa;">${safeOrg}</strong> organizasyonuna <strong style="color:#fafafa;">${safeRole}</strong> olarak davet etti.`
      : `<strong style="color:#fafafa;">${safeInviter}</strong> invited you to join <strong style="color:#fafafa;">${safeOrg}</strong> as <strong style="color:#fafafa;">${safeRole}</strong>.`;

  return renderTransactionalEmail({
    title: locale === 'tr' ? `${safeOrg} — Pushify daveti` : `Join ${safeOrg} on Pushify`,
    greeting: t.greeting,
    bodyHtml,
    button: { href: inviteUrl, label: t.button },
    notes: [t.expiry, t.ignore],
    urlFallback: { label: t.urlLabel, href: inviteUrl },
  });
}

function billingPaymentFailedTemplate(
  orgName: string,
  billingUrl: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: 'Payment failed',
      greeting: 'Hi there,',
      button: 'Manage billing',
      note: 'If you already updated your card, you can ignore this email.',
    },
    tr: {
      title: 'Ödeme başarısız',
      greeting: 'Merhaba,',
      button: 'Faturalamayı yönet',
      note: 'Kartınızı zaten güncellediyseniz bu e-postayı yok sayabilirsiniz.',
    },
  };

  const t = texts[locale] ?? texts.en;
  const safeOrg = esc(orgName);
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#fafafa;">${safeOrg}</strong> için son ödeme işlenemedi. Kesinti yaşamamak için ödeme yönteminizi güncelleyin.`
      : `We couldn't process the latest payment for <strong style="color:#fafafa;">${safeOrg}</strong>. Update your payment method to avoid service interruption.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: billingUrl, label: t.button },
    notes: [t.note],
  });
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
    en: 'Verify your Pushify email',
    tr: 'Pushify e-postanızı doğrulayın',
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
    en: `Invitation to join ${orgName} on Pushify`,
    tr: `Pushify — ${orgName} daveti`,
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

export async function sendBillingPaymentFailedEmail(
  to: string,
  orgName: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping billing payment failed email');
    return;
  }

  const billingUrl = `${env.FRONTEND_URL}/dashboard/billing`;
  const subjects = {
    en: `Action required: payment failed for ${orgName}`,
    tr: `İşlem gerekli: ${orgName} ödemesi başarısız`,
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: billingPaymentFailedTemplate(orgName, billingUrl, locale),
    });
    logger.info({ to, orgName }, 'Billing payment failed email sent');
  } catch (error) {
    logger.error({ error, to, orgName }, 'Failed to send billing payment failed email');
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
