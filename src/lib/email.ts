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
      expiry: 'This link expires in <strong style="color:#18181b;">1 hour</strong>.',
      ignore: "If you didn't request this, you can ignore this email — your password will not change.",
      urlLabel: 'Or copy this link into your browser:',
    },
    tr: {
      title: 'Şifrenizi sıfırlayın',
      greeting: 'Merhaba,',
      body: 'Pushify hesabınız için şifre sıfırlama talebi aldık. Yeni şifre belirlemek için aşağıdaki butona tıklayın.',
      button: 'Şifreyi sıfırla',
      expiry: 'Bu bağlantı <strong style="color:#18181b;">1 saat</strong> içinde geçersiz olur.',
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
      expiry: 'This link expires in <strong style="color:#18181b;">24 hours</strong>.',
      ignore: "If you didn't create an account, you can ignore this email.",
      urlLabel: 'Or copy this link into your browser:',
    },
    tr: {
      title: 'E-postanızı doğrulayın',
      greeting: 'Merhaba,',
      body: "Pushify'a hoş geldiniz. Hesabınızı tamamlamak için e-posta adresinizi doğrulayın.",
      button: 'E-postayı doğrula',
      expiry: 'Bu bağlantı <strong style="color:#18181b;">24 saat</strong> içinde geçersiz olur.',
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
      expiry: 'This invitation expires in <strong style="color:#18181b;">7 days</strong>.',
      ignore: "If you weren't expecting this, you can ignore this email.",
      urlLabel: 'Or copy this link into your browser:',
    },
    tr: {
      title: `${orgName} — Pushify daveti`,
      greeting: 'Merhaba,',
      button: 'Daveti kabul et',
      expiry: 'Bu davet <strong style="color:#18181b;">7 gün</strong> içinde geçersiz olur.',
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
      ? `<strong style="color:#18181b;">${safeInviter}</strong>, sizi <strong style="color:#18181b;">${safeOrg}</strong> organizasyonuna <strong style="color:#18181b;">${safeRole}</strong> olarak davet etti.`
      : `<strong style="color:#18181b;">${safeInviter}</strong> invited you to join <strong style="color:#18181b;">${safeOrg}</strong> as <strong style="color:#18181b;">${safeRole}</strong>.`;

  return renderTransactionalEmail({
    title: locale === 'tr' ? `${safeOrg} — Pushify daveti` : `Join ${safeOrg} on Pushify`,
    greeting: t.greeting,
    bodyHtml,
    button: { href: inviteUrl, label: t.button },
    notes: [t.expiry, t.ignore],
    urlFallback: { label: t.urlLabel, href: inviteUrl },
  });
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function infraCreditTopUpTemplate(
  orgName: string,
  amountCents: number,
  balanceCents: number,
  billingUrl: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: 'Infrastructure credits added',
      greeting: 'Hi there,',
      button: 'View billing',
    },
    tr: {
      title: 'Altyapı kredileri eklendi',
      greeting: 'Merhaba,',
      button: 'Faturalandırmayı görüntüle',
    },
  };
  const t = texts[locale] ?? texts.en;
  const safeOrg = esc(orgName);
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeOrg}</strong> için <strong style="color:#18181b;">${formatUsd(amountCents)}</strong> altyapı kredisi yüklendi. Güncel bakiye: <strong style="color:#18181b;">${formatUsd(balanceCents)}</strong>.`
      : `<strong style="color:#18181b;">${formatUsd(amountCents)}</strong> in infrastructure credits was added to <strong style="color:#18181b;">${safeOrg}</strong>. New balance: <strong style="color:#18181b;">${formatUsd(balanceCents)}</strong>.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: billingUrl, label: t.button },
  });
}

function infraCreditsLowTemplate(
  orgName: string,
  balanceCents: number,
  billingUrl: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: 'Low infrastructure credits',
      greeting: 'Hi there,',
      button: 'Add credits',
      note: 'Managed servers may be stopped automatically when credits run out.',
    },
    tr: {
      title: 'Altyapı kredisi düşük',
      greeting: 'Merhaba,',
      button: 'Kredi ekle',
      note: 'Krediler bittiğinde yönetilen sunucular otomatik olarak durdurulabilir.',
    },
  };
  const t = texts[locale] ?? texts.en;
  const safeOrg = esc(orgName);
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeOrg}</strong> altyapı cüzdan bakiyesi <strong style="color:#18181b;">${formatUsd(balanceCents)}</strong> seviyesine düştü. Kesinti yaşamamak için kredi ekleyin.`
      : `Infrastructure credit balance for <strong style="color:#18181b;">${safeOrg}</strong> is low (<strong style="color:#18181b;">${formatUsd(balanceCents)}</strong>). Add credits to avoid interruptions.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: billingUrl, label: t.button },
    notes: [t.note],
  });
}

function infraServerSuspendedTemplate(
  orgName: string,
  serverName: string,
  billingUrl: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: 'Server stopped — credits exhausted',
      greeting: 'Hi there,',
      button: 'Add credits',
      note: 'After adding credits, start the server again from the dashboard.',
    },
    tr: {
      title: 'Sunucu durduruldu — kredi bitti',
      greeting: 'Merhaba,',
      button: 'Kredi ekle',
      note: 'Kredi yükledikten sonra sunucuyu panelden yeniden başlatabilirsiniz.',
    },
  };
  const t = texts[locale] ?? texts.en;
  const safeOrg = esc(orgName);
  const safeServer = esc(serverName);
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeServer}</strong> (<strong style="color:#18181b;">${safeOrg}</strong>) yönetilen sunucusu, yetersiz altyapı kredisi nedeniyle durduruldu.`
      : `Managed server <strong style="color:#18181b;">${safeServer}</strong> in <strong style="color:#18181b;">${safeOrg}</strong> was stopped because infrastructure credits ran out.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: billingUrl, label: t.button },
    notes: [t.note],
  });
}

function billingPlanActivatedTemplate(
  orgName: string,
  planName: string,
  billingUrl: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: 'Plan updated',
      greeting: 'Hi there,',
      button: 'View billing',
    },
    tr: {
      title: 'Plan güncellendi',
      greeting: 'Merhaba,',
      button: 'Faturalandırmayı görüntüle',
    },
  };
  const t = texts[locale] ?? texts.en;
  const safeOrg = esc(orgName);
  const safePlan = esc(planName);
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeOrg}</strong> için platform planınız <strong style="color:#18181b;">${safePlan}</strong> olarak güncellendi.`
      : `Your platform plan for <strong style="color:#18181b;">${safeOrg}</strong> is now <strong style="color:#18181b;">${safePlan}</strong>.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    notes: [
      locale === 'tr'
        ? 'Yönetilen bulut sunucuları ayrı altyapı kredileri ile faturalandırılır.'
        : 'Managed cloud servers are billed separately via infrastructure credits.',
    ],
    button: { href: billingUrl, label: t.button },
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
      ? `<strong style="color:#18181b;">${safeOrg}</strong> için son ödeme işlenemedi. Kesinti yaşamamak için ödeme yönteminizi güncelleyin.`
      : `We couldn't process the latest payment for <strong style="color:#18181b;">${safeOrg}</strong>. Update your payment method to avoid service interruption.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: billingUrl, label: t.button },
    notes: [t.note],
  });
}

function billingSuspendedTemplate(
  orgName: string,
  billingUrl: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: 'Subscription ended — services paused',
      greeting: 'Hi there,',
      button: 'Manage billing',
      note: 'Resume your plan to start servers and deployments again. Projects were paused automatically.',
    },
    tr: {
      title: 'Abonelik sona erdi — hizmetler duraklatıldı',
      greeting: 'Merhaba,',
      button: 'Faturalamayı yönet',
      note: 'Sunucuları ve dağıtımları yeniden başlatmak için planınızı yenileyin. Projeler otomatik olarak duraklatıldı.',
    },
  };

  const t = texts[locale] ?? texts.en;
  const safeOrg = esc(orgName);
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeOrg}</strong> için platform aboneliği sona erdi. Yönetilen sunucular durduruldu ve aktif projeler duraklatıldı.`
      : `Your platform subscription for <strong style="color:#18181b;">${safeOrg}</strong> has ended. Managed servers were stopped and active projects were paused.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: billingUrl, label: t.button },
    notes: [t.note],
  });
}

function welcomeTemplate(name: string, dashboardUrl: string, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Welcome to Pushify',
      greeting: 'Hi there,',
      button: 'Open dashboard',
      note: 'Need a hand getting started? Just reply to this email.',
    },
    tr: {
      title: "Pushify'a hoş geldiniz",
      greeting: 'Merhaba,',
      button: 'Panele git',
      note: 'Başlarken yardıma mı ihtiyacınız var? Bu e-postayı yanıtlamanız yeterli.',
    },
  };
  const t = texts[locale] ?? texts.en;
  const safeName = esc(name || (locale === 'tr' ? 'oradaki' : 'there'));
  const bodyHtml =
    locale === 'tr'
      ? `Hoş geldin <strong style="color:#18181b;">${safeName}</strong>! Hesabın hazır. Pushify ile uygulamalarını ve sunucularını tek bir yerden dağıtabilir ve yönetebilirsin. İlk projeni oluşturmak için panele göz at.`
      : `Welcome aboard, <strong style="color:#18181b;">${safeName}</strong>! Your account is ready. Pushify lets you deploy and manage your apps and servers from one place. Head to your dashboard to create your first project.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: dashboardUrl, label: t.button },
    notes: [t.note],
  });
}

function passwordChangedTemplate(
  name: string | undefined,
  resetUrl: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: 'Your password was changed',
      greeting: name ? `Hi ${name},` : 'Hi there,',
      body: 'The password for your Pushify account was just changed.',
      button: 'Reset password',
      note: "If you made this change, you're all set — no further action is needed.",
      warn: "If this wasn't you, reset your password immediately and contact support.",
    },
    tr: {
      title: 'Şifreniz değiştirildi',
      greeting: name ? `Merhaba ${name},` : 'Merhaba,',
      body: 'Pushify hesabınızın şifresi az önce değiştirildi.',
      button: 'Şifreyi sıfırla',
      note: 'Bu değişikliği siz yaptıysanız yapmanız gereken bir şey yok.',
      warn: 'Bu işlemi siz yapmadıysanız hemen şifrenizi sıfırlayın ve destek ile iletişime geçin.',
    },
  };
  const t = texts[locale] ?? texts.en;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    body: t.body,
    button: { href: resetUrl, label: t.button },
    notes: [t.note, t.warn],
  });
}

function twoFactorEnabledTemplate(name: string | undefined, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Two-factor authentication enabled',
      greeting: name ? `Hi ${name},` : 'Hi there,',
      body: 'Two-factor authentication (2FA) is now active on your Pushify account. From now on, signing in will require a code from your authenticator app.',
      note: 'Keep your backup codes somewhere safe — they let you sign in if you lose your device.',
      warn: "If you didn't enable this, reset your password and contact support right away.",
    },
    tr: {
      title: 'İki adımlı doğrulama etkinleştirildi',
      greeting: name ? `Merhaba ${name},` : 'Merhaba,',
      body: 'Pushify hesabınızda iki adımlı doğrulama (2FA) artık etkin. Bundan sonra giriş yaparken doğrulama uygulamanızdan bir kod gerekecek.',
      note: 'Yedek kodlarınızı güvenli bir yerde saklayın — cihazınızı kaybederseniz giriş yapmanızı sağlarlar.',
      warn: 'Bu işlemi siz yapmadıysanız hemen şifrenizi sıfırlayın ve destek ile iletişime geçin.',
    },
  };
  const t = texts[locale] ?? texts.en;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    body: t.body,
    notes: [t.note, t.warn],
  });
}

function twoFactorDisabledTemplate(name: string | undefined, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Two-factor authentication disabled',
      greeting: name ? `Hi ${name},` : 'Hi there,',
      body: 'Two-factor authentication (2FA) was turned off for your Pushify account. Your account is now protected by your password only.',
      warn: "If you didn't make this change, reset your password and contact support immediately — your account may be at risk.",
    },
    tr: {
      title: 'İki adımlı doğrulama kapatıldı',
      greeting: name ? `Merhaba ${name},` : 'Merhaba,',
      body: 'Pushify hesabınız için iki adımlı doğrulama (2FA) kapatıldı. Hesabınız artık yalnızca şifrenizle korunuyor.',
      warn: 'Bu değişikliği siz yapmadıysanız hemen şifrenizi sıfırlayın ve destek ile iletişime geçin — hesabınız risk altında olabilir.',
    },
  };
  const t = texts[locale] ?? texts.en;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    body: t.body,
    notes: [t.warn],
  });
}

function serverReadyTemplate(serverName: string, serverUrl: string, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Your server is ready',
      greeting: 'Hi there,',
      button: 'View server',
      note: 'You can now deploy projects to this server from the dashboard.',
    },
    tr: {
      title: 'Sunucunuz hazır',
      greeting: 'Merhaba,',
      button: 'Sunucuyu görüntüle',
      note: 'Artık panelden bu sunucuya proje dağıtabilirsiniz.',
    },
  };
  const t = texts[locale] ?? texts.en;
  const safeServer = esc(serverName);
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeServer}</strong> sunucusunun kurulumu tamamlandı ve kullanıma hazır.`
      : `Setup for <strong style="color:#18181b;">${safeServer}</strong> finished successfully and the server is ready to use.`;

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: serverUrl, label: t.button },
    notes: [t.note],
  });
}

function newLoginTemplate(
  name: string | undefined,
  details: { ipAddress?: string; userAgent?: string; time: string },
  resetUrl: string,
  locale: 'en' | 'tr'
): string {
  const texts = {
    en: {
      title: 'New sign-in to your account',
      greeting: name ? `Hi ${name},` : 'Hi there,',
      body: 'We noticed a sign-in to your Pushify account from a new device or browser.',
      button: 'Secure your account',
      labelTime: 'Time',
      labelIp: 'IP address',
      labelDevice: 'Device',
      note: 'If this was you, no action is needed.',
      warn: "If you don't recognize this, reset your password and review your active sessions.",
    },
    tr: {
      title: 'Hesabınızda yeni giriş',
      greeting: name ? `Merhaba ${name},` : 'Merhaba,',
      body: 'Pushify hesabınıza yeni bir cihaz veya tarayıcıdan giriş yapıldığını fark ettik.',
      button: 'Hesabınızı koruyun',
      labelTime: 'Zaman',
      labelIp: 'IP adresi',
      labelDevice: 'Cihaz',
      note: 'Bu işlemi siz yaptıysanız yapmanız gereken bir şey yok.',
      warn: 'Bunu siz yapmadıysanız şifrenizi sıfırlayın ve aktif oturumlarınızı gözden geçirin.',
    },
  };
  const t = texts[locale] ?? texts.en;

  const detailLines: string[] = [
    `${t.labelTime}: <strong style="color:#18181b;">${esc(details.time)}</strong>`,
  ];
  if (details.ipAddress) {
    detailLines.push(`${t.labelIp}: <strong style="color:#18181b;">${esc(details.ipAddress)}</strong>`);
  }
  if (details.userAgent) {
    detailLines.push(`${t.labelDevice}: <strong style="color:#18181b;">${esc(details.userAgent)}</strong>`);
  }

  return renderTransactionalEmail({
    title: t.title,
    greeting: t.greeting,
    body: t.body,
    button: { href: resetUrl, label: t.button },
    notes: [...detailLines, t.note, t.warn],
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

export async function sendInfraCreditTopUpEmail(
  to: string,
  orgName: string,
  amountCents: number,
  balanceCents: number,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping infra top-up email');
    return;
  }

  const billingUrl = `${env.FRONTEND_URL}/dashboard/billing`;
  const subjects = {
    en: `Infrastructure credits added — ${orgName}`,
    tr: `Altyapı kredileri eklendi — ${orgName}`,
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: infraCreditTopUpTemplate(orgName, amountCents, balanceCents, billingUrl, locale),
    });
    logger.info({ to, orgName, amountCents }, 'Infra credit top-up email sent');
  } catch (error) {
    logger.error({ error, to, orgName }, 'Failed to send infra top-up email');
  }
}

export async function sendInfraCreditsLowEmail(
  to: string,
  orgName: string,
  balanceCents: number,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping infra low balance email');
    return;
  }

  const billingUrl = `${env.FRONTEND_URL}/dashboard/billing`;
  const subjects = {
    en: `Low infrastructure credits — ${orgName}`,
    tr: `Düşük altyapı kredisi — ${orgName}`,
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: infraCreditsLowTemplate(orgName, balanceCents, billingUrl, locale),
    });
    logger.info({ to, orgName, balanceCents }, 'Infra low balance email sent');
  } catch (error) {
    logger.error({ error, to, orgName }, 'Failed to send infra low balance email');
  }
}

export async function sendInfraServerSuspendedEmail(
  to: string,
  orgName: string,
  serverName: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping infra server suspended email');
    return;
  }

  const billingUrl = `${env.FRONTEND_URL}/dashboard/billing`;
  const subjects = {
    en: `Server stopped — add credits (${orgName})`,
    tr: `Sunucu durduruldu — kredi ekleyin (${orgName})`,
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: infraServerSuspendedTemplate(orgName, serverName, billingUrl, locale),
    });
    logger.info({ to, orgName, serverName }, 'Infra server suspended email sent');
  } catch (error) {
    logger.error({ error, to, orgName, serverName }, 'Failed to send infra server suspended email');
  }
}

export async function sendBillingPlanActivatedEmail(
  to: string,
  orgName: string,
  planName: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping plan activated email');
    return;
  }

  const billingUrl = `${env.FRONTEND_URL}/dashboard/billing`;
  const subjects = {
    en: `Plan updated — ${orgName}`,
    tr: `Plan güncellendi — ${orgName}`,
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: billingPlanActivatedTemplate(orgName, planName, billingUrl, locale),
    });
    logger.info({ to, orgName, planName }, 'Billing plan activated email sent');
  } catch (error) {
    logger.error({ error, to, orgName }, 'Failed to send plan activated email');
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

export async function sendBillingSuspendedEmail(
  to: string,
  orgName: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping billing suspended email');
    return;
  }

  const billingUrl = `${env.FRONTEND_URL}/dashboard/billing`;
  const subjects = {
    en: `Services paused — ${orgName}`,
    tr: `Hizmetler duraklatıldı — ${orgName}`,
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: billingSuspendedTemplate(orgName, billingUrl, locale),
    });
    logger.info({ to, orgName }, 'Billing suspended email sent');
  } catch (error) {
    logger.error({ error, to, orgName }, 'Failed to send billing suspended email');
  }
}

export async function sendWelcomeEmail(
  to: string,
  name: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping welcome email');
    return;
  }

  const dashboardUrl = `${env.FRONTEND_URL}/dashboard`;
  const subjects = {
    en: 'Welcome to Pushify',
    tr: "Pushify'a hoş geldiniz",
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: welcomeTemplate(name, dashboardUrl, locale),
    });
    logger.info({ to }, 'Welcome email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send welcome email');
  }
}

export async function sendPasswordChangedEmail(
  to: string,
  name: string | undefined,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping password changed email');
    return;
  }

  const resetUrl = `${env.FRONTEND_URL}/forgot-password`;
  const subjects = {
    en: 'Your Pushify password was changed',
    tr: 'Pushify şifreniz değiştirildi',
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: passwordChangedTemplate(name, resetUrl, locale),
    });
    logger.info({ to }, 'Password changed email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send password changed email');
  }
}

export async function sendTwoFactorEnabledEmail(
  to: string,
  name: string | undefined,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping 2FA enabled email');
    return;
  }

  const subjects = {
    en: 'Two-factor authentication enabled',
    tr: 'İki adımlı doğrulama etkinleştirildi',
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: twoFactorEnabledTemplate(name, locale),
    });
    logger.info({ to }, '2FA enabled email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send 2FA enabled email');
  }
}

export async function sendTwoFactorDisabledEmail(
  to: string,
  name: string | undefined,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping 2FA disabled email');
    return;
  }

  const subjects = {
    en: 'Two-factor authentication disabled',
    tr: 'İki adımlı doğrulama kapatıldı',
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: twoFactorDisabledTemplate(name, locale),
    });
    logger.info({ to }, '2FA disabled email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send 2FA disabled email');
  }
}

export async function sendServerReadyEmail(
  to: string,
  serverName: string,
  serverId: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping server ready email');
    return;
  }

  const serverUrl = `${env.FRONTEND_URL}/dashboard/servers/${serverId}`;
  const subjects = {
    en: `Your server "${serverName}" is ready`,
    tr: `"${serverName}" sunucunuz hazır`,
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: serverReadyTemplate(serverName, serverUrl, locale),
    });
    logger.info({ to, serverName }, 'Server ready email sent');
  } catch (error) {
    logger.error({ error, to, serverName }, 'Failed to send server ready email');
  }
}

export async function sendNewLoginEmail(
  to: string,
  name: string | undefined,
  details: { ipAddress?: string; userAgent?: string; time: string },
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping new login email');
    return;
  }

  const resetUrl = `${env.FRONTEND_URL}/forgot-password`;
  const subjects = {
    en: 'New sign-in to your Pushify account',
    tr: 'Pushify hesabınızda yeni giriş',
  };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: newLoginTemplate(name, details, resetUrl, locale),
    });
    logger.info({ to }, 'New login email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send new login email');
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

/** Generic admin notification email — subject/html/text prebuilt by lib/admin-notify. */
export async function sendAdminNotificationEmail(
  to: string[],
  subject: string,
  html: string,
  text: string
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping admin notification');
    return;
  }
  if (to.length === 0) return;

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to: to.join(', '),
      subject,
      html,
      text,
    });
    logger.info({ to, subject }, 'Admin notification email sent');
  } catch (error) {
    logger.error({ error, to, subject }, 'Failed to send admin notification email');
  }
}
