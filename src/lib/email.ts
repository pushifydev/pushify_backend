import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';
import {
  escapeHtml,
  EMAIL_CONTENT_END,
  renderTransactionalEmail,
  renderNotificationEmail,
  type EmailDetailRow,
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
    eyebrow: locale === 'tr' ? 'Şifre sıfırlama' : 'Password reset',
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
    eyebrow: locale === 'tr' ? 'E-posta doğrulama' : 'Verify email',
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
    eyebrow: locale === 'tr' ? 'Davet' : 'Invitation',
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
    eyebrow: locale === 'tr' ? 'Kredi eklendi' : 'Credits added',
    tone: 'success',
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
    eyebrow: locale === 'tr' ? 'Düşük kredi' : 'Low credits',
    tone: 'warning',
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
    eyebrow: locale === 'tr' ? 'Sunucu durduruldu' : 'Server stopped',
    tone: 'danger',
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
    eyebrow: locale === 'tr' ? 'Faturalandırma' : 'Billing',
    tone: 'success',
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
  locale: 'en' | 'tr',
  payUrl?: string | null,
  reason: 'failed' | 'action_required' = 'failed',
): string {
  const texts = {
    en: {
      title: reason === 'action_required' ? 'Confirm your payment' : 'Payment failed',
      greeting: 'Hi there,',
      pay: reason === 'action_required' ? 'Confirm payment' : 'Pay invoice',
      manage: 'Manage billing',
      note: payUrl
        ? 'The button opens Stripe’s secure payment page: pay with the saved card or another one. Already paid? You can ignore this email.'
        : 'If you already updated your card, you can ignore this email.',
    },
    tr: {
      title: reason === 'action_required' ? 'Ödemenizi onaylayın' : 'Ödeme başarısız',
      greeting: 'Merhaba,',
      pay: reason === 'action_required' ? 'Ödemeyi onayla' : 'Faturayı öde',
      manage: 'Faturalamayı yönet',
      note: payUrl
        ? 'Düğme Stripe’ın güvenli ödeme sayfasını açar: kayıtlı kartla ya da başka bir kartla ödeyebilirsiniz. Zaten ödediyseniz bu e-postayı yok sayabilirsiniz.'
        : 'Kartınızı zaten güncellediyseniz bu e-postayı yok sayabilirsiniz.',
    },
  };

  const t = texts[locale] ?? texts.en;
  const safeOrg = esc(orgName);
  const bodyHtml =
    reason === 'action_required'
      ? locale === 'tr'
        ? `Bankanız <strong style="color:#18181b;">${safeOrg}</strong> ödemesi için onay (3D Secure) istiyor. Onaylamazsanız ödeme tamamlanmaz.`
        : `Your bank needs you to confirm the payment for <strong style="color:#18181b;">${safeOrg}</strong> (3D Secure). Until you do, it can't go through.`
      : locale === 'tr'
        ? `<strong style="color:#18181b;">${safeOrg}</strong> için son ödeme işlenemedi. Kesinti yaşamamak için faturayı şimdi ödeyin ya da kartınızı güncelleyin.`
        : `We couldn't process the latest payment for <strong style="color:#18181b;">${safeOrg}</strong>. Pay the invoice now or update your card to avoid service interruption.`;

  return renderTransactionalEmail({
    eyebrow: reason === 'action_required' ? (locale === 'tr' ? 'Onay gerekli' : 'Action required') : locale === 'tr' ? 'Ödeme başarısız' : 'Payment failed',
    tone: reason === 'action_required' ? 'warning' : 'danger',
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    // One click to pay: Stripe's hosted invoice page (saved card, a new card, 3D Secure).
    button: payUrl ? { href: payUrl, label: t.pay } : { href: billingUrl, label: t.manage },
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
    eyebrow: locale === 'tr' ? 'Hizmetler duraklatıldı' : 'Services paused',
    tone: 'danger',
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
    eyebrow: locale === 'tr' ? 'Hoş geldiniz' : 'Welcome',
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
    eyebrow: locale === 'tr' ? 'Güvenlik' : 'Security',
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
    eyebrow: locale === 'tr' ? 'Güvenlik' : 'Security',
    tone: 'success',
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
    eyebrow: locale === 'tr' ? 'Güvenlik' : 'Security',
    tone: 'warning',
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
    eyebrow: locale === 'tr' ? 'Sunucu hazır' : 'Server ready',
    tone: 'success',
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

  // Values are escaped by the details renderer.
  const detailRows: EmailDetailRow[] = [{ label: t.labelTime, value: details.time }];
  if (details.ipAddress) {
    detailRows.push({ label: t.labelIp, value: details.ipAddress });
  }
  if (details.userAgent) {
    detailRows.push({ label: t.labelDevice, value: details.userAgent });
  }

  return renderTransactionalEmail({
    eyebrow: locale === 'tr' ? 'Yeni giriş' : 'New sign-in',
    title: t.title,
    greeting: t.greeting,
    body: t.body,
    details: detailRows,
    button: { href: resetUrl, label: t.button },
    notes: [t.note, t.warn],
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
  locale: 'en' | 'tr' = 'en',
  receiptUrl?: string | null
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
      html: withInvoiceLink(infraCreditTopUpTemplate(orgName, amountCents, balanceCents, billingUrl, locale), receiptUrl, locale),
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

export async function sendBackupVerificationFailedEmail(
  to: string,
  orgName: string,
  databaseName: string,
  error: string,
  databaseId: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping backup verification email');
    return;
  }

  const dbUrl = `${env.FRONTEND_URL}/dashboard/databases/${databaseId}`;
  const subjects = {
    en: `Backup restore test failed — ${databaseName} (${orgName})`,
    tr: `Yedek geri yükleme testi başarısız — ${databaseName} (${orgName})`,
  };
  const copy = {
    en: {
      lead: `We tried to restore the latest backup of <strong>${escapeHtml(String(databaseName))}</strong> into a throwaway container and it did not come back cleanly.`,
      why: 'Your live database was not touched. But this backup may not be recoverable — please check it before you need it.',
      cta: 'Open the database',
    },
    tr: {
      lead: `<strong>${escapeHtml(String(databaseName))}</strong> veritabanının son yedeğini geçici bir container'a geri yüklemeyi denedik ve düzgün geri gelmedi.`,
      why: 'Canlı veritabanınıza dokunulmadı. Ancak bu yedek kurtarılamaz olabilir — ihtiyaç duymadan önce kontrol edin.',
      cta: 'Veritabanını aç',
    },
  }[locale] ?? { lead: '', why: '', cta: 'Open' };

  const html = renderTransactionalEmail({
    eyebrow: locale === 'tr' ? 'Yedek testi başarısız' : 'Backup test failed',
    tone: 'danger',
    bodyHtml: [copy.lead, copy.why],
    code: { text: error },
    button: { href: dbUrl, label: copy.cta },
  });

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html,
    });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send backup verification email');
  }
}

export async function sendAppDownEmail(
  to: string,
  details: { orgName: string; projectName: string; projectId: string; url: string; statusCode?: number; error?: string },
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping app down email');
    return;
  }

  const { orgName, projectName, projectId, url, statusCode, error } = details;
  const projectUrl = `${env.FRONTEND_URL}/dashboard/projects/${projectId}`;
  const reason = statusCode ? `HTTP ${statusCode}` : error || 'no answer';
  const subjects = {
    en: `${projectName} is not answering (${orgName})`,
    tr: `${projectName} cevap vermiyor (${orgName})`,
  };
  const copy = {
    en: {
      lead: `<strong>${escapeHtml(String(projectName))}</strong> stopped answering at ${escapeHtml(String(url))} — three checks in a row failed (${escapeHtml(String(reason))}).`,
      why: 'The app may have crashed, run out of memory or be stuck starting. Its logs in Pushify usually say which. You get one more email when it answers again.',
      cta: 'Open the project',
    },
    tr: {
      lead: `<strong>${escapeHtml(String(projectName))}</strong> ${escapeHtml(String(url))} adresinde cevap vermiyor — üst üste üç kontrol başarısız oldu (${escapeHtml(String(reason))}).`,
      why: 'Uygulama çökmüş, belleği dolmuş ya da başlangıçta takılmış olabilir. Pushify’daki logları genelde sebebini gösterir. Tekrar cevap verdiğinde bir e-posta daha göndereceğiz.',
      cta: 'Projeyi aç',
    },
  }[locale];

  const html = renderTransactionalEmail({
    eyebrow: locale === 'tr' ? 'Uygulama cevap vermiyor' : 'App down',
    tone: 'danger',
    bodyHtml: [copy.lead, copy.why],
    button: { href: projectUrl, label: copy.cta },
  });

  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject: subjects[locale] ?? subjects.en, html });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send app down email');
  }
}

/**
 * An app is close to the edge but has not fallen over yet — the whole point is that this arrives
 * before the "not answering" mail does. It says what to do, because "95% memory" on its own
 * leaves the reader with a number and no next step.
 */
export async function sendResourcePressureEmail(
  to: string,
  details: {
    orgName: string;
    projectName: string;
    projectId: string;
    resource: 'memory' | 'cpu';
    percent: number;
    containerName: string;
  },
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping resource pressure email');
    return;
  }

  const { orgName, projectName, projectId, resource, percent, containerName } = details;
  const projectUrl = `${env.FRONTEND_URL}/dashboard/projects/${projectId}?tab=overview`;
  const rounded = Math.round(percent);
  const isMemory = resource === 'memory';

  const subjects = {
    en: isMemory
      ? `${projectName} is running out of memory (${orgName})`
      : `${projectName} is using all its CPU (${orgName})`,
    tr: isMemory
      ? `${projectName} belleğini tüketmek üzere (${orgName})`
      : `${projectName} CPU'sunu tamamen kullanıyor (${orgName})`,
  };
  const copy = {
    en: {
      lead: isMemory
        ? `<strong>${escapeHtml(String(projectName))}</strong> has been using ${rounded}% of the memory it is allowed for several minutes (container <code>${escapeHtml(String(containerName))}</code>).`
        : `<strong>${escapeHtml(String(projectName))}</strong> has been running at ${rounded}% CPU for a while (container <code>${escapeHtml(String(containerName))}</code>).`,
      why: isMemory
        ? 'When it reaches the limit the kernel kills the process and the container restarts — usually as a loop, and usually at the worst time. Either give it more memory, or find what is holding on to it.'
        : 'The app is not down, but requests are queuing behind a saturated CPU. If this is not a build or a batch job, it is worth looking at what is spinning.',
      cta: 'Open the project',
    },
    tr: {
      lead: isMemory
        ? `<strong>${escapeHtml(String(projectName))}</strong> birkaç dakikadır izin verilen belleğin %${rounded} kadarını kullanıyor (container <code>${escapeHtml(String(containerName))}</code>).`
        : `<strong>${escapeHtml(String(projectName))}</strong> bir süredir %${rounded} CPU ile çalışıyor (container <code>${escapeHtml(String(containerName))}</code>).`,
      why: isMemory
        ? 'Sınıra ulaştığında çekirdek süreci öldürür ve container yeniden başlar — genelde döngüye girer, genelde en kötü anda. Ya belleği artırın ya da belleği tutan şeyi bulun.'
        : 'Uygulama ayakta ama istekler doymuş bir CPU\'nun arkasında sıraya giriyor. Bu bir build ya da toplu iş değilse, neyin döndüğüne bakmakta fayda var.',
      cta: 'Projeyi aç',
    },
  }[locale];

  const html = renderTransactionalEmail({
    eyebrow: isMemory
      ? locale === 'tr' ? 'Bellek baskısı' : 'Memory pressure'
      : locale === 'tr' ? 'CPU baskısı' : 'CPU pressure',
    tone: 'warning',
    bodyHtml: [copy.lead, copy.why],
    button: { href: projectUrl, label: copy.cta },
  });

  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject: subjects[locale] ?? subjects.en, html });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send resource pressure email');
  }
}

/**
 * A server filling up takes every container on it down together — apps and managed databases
 * alike — so this goes out while there is still room to act.
 */
export async function sendServerDiskEmail(
  to: string,
  details: {
    orgName: string;
    serverName: string;
    serverId: string;
    usedPercent: number;
    availGb: number;
    critical: boolean;
  },
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping server disk email');
    return;
  }

  const { orgName, serverName, serverId, usedPercent, availGb, critical } = details;
  const serverUrl = `${env.FRONTEND_URL}/dashboard/servers/${serverId}`;

  const subjects = {
    en: critical
      ? `${serverName} is almost out of disk (${orgName})`
      : `${serverName} disk is ${usedPercent}% full (${orgName})`,
    tr: critical
      ? `${serverName} sunucusunun diski dolmak üzere (${orgName})`
      : `${serverName} sunucusunun diski %${usedPercent} dolu (${orgName})`,
  };
  const copy = {
    en: {
      lead: `<strong>${escapeHtml(String(serverName))}</strong> is ${usedPercent}% full — ${availGb} GB left.`,
      why: critical
        ? 'At this level deploys fail and containers start losing writes. Everything on this server is affected, databases included.'
        : 'Old Docker images are usually most of it. Running <code>docker system prune -af</code> on the server reclaims the space that unused builds are holding.',
      cta: 'Open the server',
    },
    tr: {
      lead: `<strong>${escapeHtml(String(serverName))}</strong> diskinin %${usedPercent} kadarı dolu — ${availGb} GB kaldı.`,
      why: critical
        ? 'Bu seviyede deploy\'lar başarısız olur ve container\'lar yazma kaybetmeye başlar. Bu sunucudaki her şey etkilenir, veritabanları dahil.'
        : 'Genelde suçlu eski Docker imajlarıdır. Sunucuda <code>docker system prune -af</code> çalıştırmak, kullanılmayan build\'lerin tuttuğu yeri geri kazandırır.',
      cta: 'Sunucuyu aç',
    },
  }[locale];

  const html = renderTransactionalEmail({
    eyebrow: locale === 'tr' ? 'Disk alanı' : 'Disk space',
    tone: critical ? 'danger' : 'warning',
    bodyHtml: [copy.lead, copy.why],
    button: { href: serverUrl, label: copy.cta },
  });

  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject: subjects[locale] ?? subjects.en, html });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send server disk email');
  }
}

export async function sendResourceRecoveredEmail(
  to: string,
  details: { orgName: string; projectName: string; projectId: string; resource: 'memory' | 'cpu'; lastedFor: string },
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping resource recovered email');
    return;
  }

  const { orgName, projectName, projectId, resource, lastedFor } = details;
  const projectUrl = `${env.FRONTEND_URL}/dashboard/projects/${projectId}?tab=overview`;
  const what = resource === 'memory' ? { en: 'Memory', tr: 'Bellek' } : { en: 'CPU', tr: 'CPU' };

  const subjects = {
    en: `${projectName}: ${what.en.toLowerCase()} is back to normal (${orgName})`,
    tr: `${projectName}: ${what.tr.toLowerCase()} normale döndü (${orgName})`,
  };
  const copy = {
    en: `<strong>${escapeHtml(String(projectName))}</strong> is back under its ${what.en.toLowerCase()} threshold. It was over for about ${escapeHtml(String(lastedFor))}.`,
    tr: `<strong>${escapeHtml(String(projectName))}</strong> ${what.tr.toLowerCase()} eşiğinin altına döndü. Yaklaşık ${escapeHtml(String(lastedFor))} boyunca eşiğin üzerindeydi.`,
  }[locale];

  const html = renderTransactionalEmail({
    eyebrow: locale === 'tr' ? 'Normale döndü' : 'Recovered',
    tone: 'success',
    bodyHtml: copy,
    button: { href: projectUrl, label: locale === 'tr' ? 'Projeyi aç' : 'Open the project' },
  });

  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject: subjects[locale] ?? subjects.en, html });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send resource recovered email');
  }
}

export async function sendAppRecoveredEmail(
  to: string,
  details: { orgName: string; projectName: string; projectId: string; url: string; downFor: string },
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping app recovered email');
    return;
  }

  const { orgName, projectName, projectId, url, downFor } = details;
  const projectUrl = `${env.FRONTEND_URL}/dashboard/projects/${projectId}`;
  const subjects = {
    en: `${projectName} is answering again (${orgName})`,
    tr: `${projectName} tekrar cevap veriyor (${orgName})`,
  };
  const copy = {
    en: `<strong>${escapeHtml(String(projectName))}</strong> answers again at ${escapeHtml(String(url))}. It was unreachable for about ${escapeHtml(String(downFor))}.`,
    tr: `<strong>${escapeHtml(String(projectName))}</strong> ${escapeHtml(String(url))} adresinde tekrar cevap veriyor. Yaklaşık ${escapeHtml(String(downFor))} boyunca erişilemedi.`,
  }[locale];

  const html = renderTransactionalEmail({
    eyebrow: locale === 'tr' ? 'Tekrar ayakta' : 'Recovered',
    tone: 'success',
    bodyHtml: copy,
    button: { href: projectUrl, label: locale === 'tr' ? 'Projeyi aç' : 'Open the project' },
  });

  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject: subjects[locale] ?? subjects.en, html });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send app recovered email');
  }
}

export async function sendCertificateExpiryEmail(
  to: string,
  details: { orgName: string; domain: string; projectName: string; projectId: string; expiresAt: Date; daysLeft: number; final: boolean },
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping certificate expiry email');
    return;
  }

  const { orgName, domain, projectName, projectId, expiresAt, daysLeft, final } = details;
  const projectUrl = `${env.FRONTEND_URL}/dashboard/projects/${projectId}`;
  const date = expiresAt.toISOString().slice(0, 10);
  const expired = daysLeft < 0;
  const subjects = {
    en: expired
      ? `HTTPS certificate expired — ${domain} (${orgName})`
      : `HTTPS certificate for ${domain} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${orgName})`,
    tr: expired
      ? `HTTPS sertifikasının süresi doldu — ${domain} (${orgName})`
      : `${domain} HTTPS sertifikasının süresi ${daysLeft} gün içinde doluyor (${orgName})`,
  };
  const copy = {
    en: {
      lead: expired
        ? `The HTTPS certificate of <strong>${escapeHtml(String(domain))}</strong> (${escapeHtml(String(projectName))}) expired on ${escapeHtml(String(date))}. Visitors now see a security warning.`
        : `The HTTPS certificate of <strong>${escapeHtml(String(domain))}</strong> (${escapeHtml(String(projectName))}) expires on ${escapeHtml(String(date))}${final ? ' — this is the last reminder' : ''}.`,
      why: 'Pushify renews certificates automatically, so this one is failing to renew. The usual causes: the domain\'s DNS (A record) no longer points at the server, or port 80 is blocked by a firewall. Check the domain in Pushify and verify it again.',
      cta: 'Open the project',
    },
    tr: {
      lead: expired
        ? `<strong>${escapeHtml(String(domain))}</strong> (${escapeHtml(String(projectName))}) alan adının HTTPS sertifikasının süresi ${escapeHtml(String(date))} tarihinde doldu. Ziyaretçiler artık güvenlik uyarısı görüyor.`
        : `<strong>${escapeHtml(String(domain))}</strong> (${escapeHtml(String(projectName))}) alan adının HTTPS sertifikasının süresi ${escapeHtml(String(date))} tarihinde doluyor${final ? ' — bu son hatırlatma' : ''}.`,
      why: 'Pushify sertifikaları otomatik yeniler; bu sertifika yenilenemiyor. En sık sebepler: alan adının DNS kaydı (A kaydı) artık sunucuyu göstermiyor ya da 80 numaralı port bir güvenlik duvarında kapalı. Alan adını Pushify’da kontrol edip yeniden doğrulayın.',
      cta: 'Projeyi aç',
    },
  }[locale];

  const html = renderTransactionalEmail({
    eyebrow: expired
      ? locale === 'tr' ? 'Sertifika süresi doldu' : 'Certificate expired'
      : locale === 'tr' ? 'Sertifika süresi doluyor' : 'Certificate expiring',
    tone: expired ? 'danger' : 'warning',
    bodyHtml: [copy.lead, copy.why],
    button: { href: projectUrl, label: copy.cta },
  });

  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject: subjects[locale] ?? subjects.en, html });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send certificate expiry email');
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
  locale: 'en' | 'tr' = 'en',
  invoiceUrl?: string | null
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
      html: withInvoiceLink(billingPlanActivatedTemplate(orgName, planName, billingUrl, locale), invoiceUrl, locale),
    });
    logger.info({ to, orgName, planName }, 'Billing plan activated email sent');
  } catch (error) {
    logger.error({ error, to, orgName }, 'Failed to send plan activated email');
  }
}

export async function sendBillingPaymentFailedEmail(
  to: string,
  orgName: string,
  locale: 'en' | 'tr' = 'en',
  payUrl?: string | null,
  reason: 'failed' | 'action_required' = 'failed',
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping billing payment failed email');
    return;
  }

  const billingUrl = `${env.FRONTEND_URL}/dashboard/billing`;
  const subjects =
    reason === 'action_required'
      ? { en: `Confirm your payment for ${orgName}`, tr: `${orgName} ödemenizi onaylayın` }
      : { en: `Action required: payment failed for ${orgName}`, tr: `İşlem gerekli: ${orgName} ödemesi başarısız` };

  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: billingPaymentFailedTemplate(orgName, billingUrl, locale, payUrl, reason),
    });
    logger.info({ to, orgName, reason }, 'Billing payment failed email sent');
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
/** Append a quiet invoice/receipt link above the closing body tag when a URL is known. */
function withInvoiceLink(html: string, url: string | null | undefined, locale: 'en' | 'tr'): string {
  if (!url) return html;
  const label = locale === 'tr' ? 'Faturayı / makbuzu görüntüle' : 'View invoice / receipt';
  const block = `<p style="margin:20px 0 0;font-size:13px;line-height:1.5"><a href="${url}" style="color:#09090b;text-decoration:underline">${label}</a></p>`;
  if (html.includes(EMAIL_CONTENT_END)) return html.replace(EMAIL_CONTENT_END, block + EMAIL_CONTENT_END);
  return html.includes('</body>') ? html.replace('</body>', block + '</body>') : html + block;
}

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

// ============ Domain sales emails ============

function formatDomainDate(date: Date, locale: 'en' | 'tr'): string {
  return date.toLocaleDateString(locale === 'tr' ? 'tr-TR' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export async function sendDomainPurchasedEmail(
  to: string,
  orgName: string,
  domainName: string,
  priceCents: number,
  expiresAt: Date,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping domain purchase email');
    return;
  }
  const domainsUrl = `${env.FRONTEND_URL}/dashboard/domains`;
  const safeDomain = esc(domainName);
  const expiry = formatDomainDate(expiresAt, locale);
  const subjects = {
    en: `Domain registered — ${domainName}`,
    tr: `Alan adı kaydedildi — ${domainName}`,
  };
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeDomain}</strong> alan adı <strong style="color:#18181b;">${esc(orgName)}</strong> için kaydedildi (${formatUsd(priceCents)}). Yenileme tarihi: <strong style="color:#18181b;">${expiry}</strong>.`
      : `<strong style="color:#18181b;">${safeDomain}</strong> was registered for <strong style="color:#18181b;">${esc(orgName)}</strong> (${formatUsd(priceCents)}). Renews on <strong style="color:#18181b;">${expiry}</strong>.`;
  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: renderTransactionalEmail({
        eyebrow: locale === 'tr' ? 'Alan adı' : 'Domain',
        tone: 'success',
        title: locale === 'tr' ? 'Alan adı kaydedildi' : 'Domain registered',
        greeting: locale === 'tr' ? 'Merhaba,' : 'Hi there,',
        bodyHtml,
        button: { href: domainsUrl, label: locale === 'tr' ? 'Alan adlarını görüntüle' : 'View domains' },
      }),
    });
    logger.info({ to, domainName }, 'Domain purchase email sent');
  } catch (error) {
    logger.error({ error, to, domainName }, 'Failed to send domain purchase email');
  }
}

export async function sendDomainRenewedEmail(
  to: string,
  orgName: string,
  domainName: string,
  priceCents: number,
  expiresAt: Date,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping domain renewal email');
    return;
  }
  const domainsUrl = `${env.FRONTEND_URL}/dashboard/domains`;
  const expiry = formatDomainDate(expiresAt, locale);
  const subjects = {
    en: `Domain renewed — ${domainName}`,
    tr: `Alan adı yenilendi — ${domainName}`,
  };
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${esc(domainName)}</strong> otomatik olarak yenilendi (${formatUsd(priceCents)}). Yeni yenileme tarihi: <strong style="color:#18181b;">${expiry}</strong>.`
      : `<strong style="color:#18181b;">${esc(domainName)}</strong> was renewed automatically (${formatUsd(priceCents)}). Next renewal: <strong style="color:#18181b;">${expiry}</strong>.`;
  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: renderTransactionalEmail({
        eyebrow: locale === 'tr' ? 'Alan adı' : 'Domain',
        tone: 'success',
        title: locale === 'tr' ? 'Alan adı yenilendi' : 'Domain renewed',
        greeting: locale === 'tr' ? 'Merhaba,' : 'Hi there,',
        bodyHtml,
        button: { href: domainsUrl, label: locale === 'tr' ? 'Alan adlarını görüntüle' : 'View domains' },
      }),
    });
    logger.info({ to, domainName }, 'Domain renewed email sent');
  } catch (error) {
    logger.error({ error, to, domainName }, 'Failed to send domain renewed email');
  }
}

export async function sendDomainRenewalReminderEmail(
  to: string,
  orgName: string,
  domainName: string,
  expiresAt: Date,
  reason: 'insufficient_credits' | 'auto_renew_off' | 'renewal_failed',
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping domain renewal reminder');
    return;
  }
  const billingUrl = `${env.FRONTEND_URL}/dashboard/billing`;
  const expiry = formatDomainDate(expiresAt, locale);
  const reasons = {
    en: {
      insufficient_credits:
        'Auto-renew is on, but your infrastructure credit balance is too low to cover the renewal. Add credits to keep the domain.',
      auto_renew_off:
        'Auto-renew is turned off for this domain. Enable it (or renew manually) to keep the domain.',
      renewal_failed:
        'The automatic renewal attempt failed. We will retry, but please check your billing to be safe.',
    },
    tr: {
      insufficient_credits:
        'Otomatik yenileme açık, ancak altyapı kredisi bakiyeniz yenileme için yetersiz. Alan adını korumak için kredi yükleyin.',
      auto_renew_off:
        'Bu alan adı için otomatik yenileme kapalı. Alan adını korumak için açın ya da manuel yenileyin.',
      renewal_failed:
        'Otomatik yenileme denemesi başarısız oldu. Yeniden deneyeceğiz; yine de faturalandırmayı kontrol edin.',
    },
  };
  const subjects = {
    en: `Action needed — ${domainName} expires on ${expiry}`,
    tr: `İşlem gerekli — ${domainName} ${expiry} tarihinde sona eriyor`,
  };
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${esc(domainName)}</strong> alan adının süresi <strong style="color:#18181b;">${expiry}</strong> tarihinde doluyor. ${(reasons.tr as Record<string, string>)[reason]}`
      : `<strong style="color:#18181b;">${esc(domainName)}</strong> expires on <strong style="color:#18181b;">${expiry}</strong>. ${(reasons.en as Record<string, string>)[reason]}`;
  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: renderTransactionalEmail({
        eyebrow: locale === 'tr' ? 'İşlem gerekli' : 'Action needed',
        tone: 'warning',
        title: locale === 'tr' ? 'Alan adı yenileme hatırlatması' : 'Domain renewal reminder',
        greeting: locale === 'tr' ? 'Merhaba,' : 'Hi there,',
        bodyHtml,
        button: { href: billingUrl, label: locale === 'tr' ? 'Faturalandırmaya git' : 'Go to billing' },
      }),
    });
    logger.info({ to, domainName, reason }, 'Domain renewal reminder sent');
  } catch (error) {
    logger.error({ error, to, domainName }, 'Failed to send domain renewal reminder');
  }
}

export async function sendDomainTransferStartedEmail(
  to: string,
  orgName: string,
  domainName: string,
  priceCents: number,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return;
  const domainsUrl = `${env.FRONTEND_URL}/dashboard/domains`;
  const subjects = {
    en: `Domain transfer started — ${domainName}`,
    tr: `Alan adı transferi başlatıldı — ${domainName}`,
  };
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${esc(domainName)}</strong> için transfer başlatıldı (${formatUsd(priceCents)} — 1 yıl yenileme dahil). Transferler genellikle 5-7 gün sürer; mevcut sağlayıcınızdan gelen onay e-postası süreci hızlandırır. Tamamlanınca haber vereceğiz.`
      : `The transfer of <strong style="color:#18181b;">${esc(domainName)}</strong> has started (${formatUsd(priceCents)} — includes a 1-year renewal). Transfers usually take 5-7 days; approving the confirmation email from your current provider speeds it up. We'll let you know when it completes.`;
  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: renderTransactionalEmail({
        eyebrow: locale === 'tr' ? 'Alan adı transferi' : 'Domain transfer',
        title: locale === 'tr' ? 'Transfer başlatıldı' : 'Transfer started',
        greeting: locale === 'tr' ? 'Merhaba,' : 'Hi there,',
        bodyHtml,
        button: { href: domainsUrl, label: locale === 'tr' ? 'Alan adlarını görüntüle' : 'View domains' },
      }),
    });
  } catch (error) {
    logger.error({ error, to, domainName }, 'Failed to send transfer started email');
  }
}

export async function sendDomainTransferResultEmail(
  to: string,
  orgName: string,
  domainName: string,
  succeeded: boolean,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return;
  const domainsUrl = `${env.FRONTEND_URL}/dashboard/domains`;
  const subjects = {
    en: succeeded
      ? `Domain transfer completed — ${domainName}`
      : `Domain transfer failed — ${domainName}`,
    tr: succeeded
      ? `Alan adı transferi tamamlandı — ${domainName}`
      : `Alan adı transferi başarısız — ${domainName}`,
  };
  const bodyHtml = succeeded
    ? locale === 'tr'
      ? `<strong style="color:#18181b;">${esc(domainName)}</strong> artık Pushify'da! DNS kayıtlarını yönetebilir ve bir projeye bağlayabilirsiniz.`
      : `<strong style="color:#18181b;">${esc(domainName)}</strong> is now managed in Pushify! You can manage its DNS records and connect it to a project.`
    : locale === 'tr'
      ? `<strong style="color:#18181b;">${esc(domainName)}</strong> transferi tamamlanamadı (iptal veya ret). Ödemeniz hesabınıza kredi olarak iade edildi. Yetki kodunu ve kilidi kontrol edip tekrar deneyebilirsiniz.`
      : `The transfer of <strong style="color:#18181b;">${esc(domainName)}</strong> could not be completed (cancelled or rejected). Your payment was refunded to your credit balance. Check the auth code and lock status, then try again.`;
  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: renderTransactionalEmail({
        eyebrow: locale === 'tr' ? 'Alan adı transferi' : 'Domain transfer',
        tone: succeeded ? 'success' : 'danger',
        title: subjects[locale] ?? subjects.en,
        greeting: locale === 'tr' ? 'Merhaba,' : 'Hi there,',
        bodyHtml,
        button: { href: domainsUrl, label: locale === 'tr' ? 'Alan adlarını görüntüle' : 'View domains' },
      }),
    });
  } catch (error) {
    logger.error({ error, to, domainName }, 'Failed to send transfer result email');
  }
}

export async function sendDomainAuthCodeViewedEmail(
  to: string,
  orgName: string,
  domainName: string,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return;
  const domainsUrl = `${env.FRONTEND_URL}/dashboard/domains`;
  const subjects = {
    en: `Transfer auth code viewed — ${domainName}`,
    tr: `Transfer yetki kodu görüntülendi — ${domainName}`,
  };
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${esc(domainName)}</strong> için transfer yetki (EPP) kodu görüntülendi ve alan adının kilidi açıldı. Bu işlemi siz yapmadıysanız hemen şifrenizi değiştirin ve destek ile iletişime geçin.`
      : `The transfer auth (EPP) code for <strong style="color:#18181b;">${esc(domainName)}</strong> was viewed and the domain was unlocked. If this wasn't you, change your password immediately and contact support.`;
  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: renderTransactionalEmail({
        eyebrow: locale === 'tr' ? 'Güvenlik' : 'Security',
        tone: 'warning',
        title: locale === 'tr' ? 'Güvenlik bildirimi' : 'Security notice',
        greeting: locale === 'tr' ? 'Merhaba,' : 'Hi there,',
        bodyHtml,
        button: { href: domainsUrl, label: locale === 'tr' ? 'Alan adlarını görüntüle' : 'View domains' },
      }),
    });
  } catch (error) {
    logger.error({ error, to, domainName }, 'Failed to send auth code viewed email');
  }
}

// ============ Onboarding lifecycle emails ============
// Every send goes through sendOnboardingEmail so the unsubscribe footer is never missed.

export type OnboardingEmailKey = 'first_deploy' | 'stuck' | 'connect_domain' | 'add_database';

const ONBOARDING_CONTENT: Record<
  OnboardingEmailKey,
  { subject: string; title: string; body: string; button: string; href: string }
> = {
  first_deploy: {
    subject: 'Deploy your first app in under a minute',
    title: 'Your first deploy is one push away',
    body: 'Connect a Git repository, pick a server (or use ours), and Pushify detects your framework, builds in Docker and puts it live with SSL. Most first deploys finish in under a minute.',
    button: 'Deploy your first app',
    href: '/dashboard/projects/new',
  },
  stuck: {
    subject: 'Need a hand getting started?',
    title: 'Stuck on something?',
    body: "You created your Pushify account a few days ago but haven't deployed yet — if something got in the way, we'd genuinely like to fix it. The docs cover the common paths, the step-by-step Next.js guide walks a full VPS setup, and replying to this email reaches a human.",
    button: 'Read the quickstart docs',
    href: '/docs',
  },
  connect_domain: {
    subject: 'Put a real domain on your app',
    title: 'Your app deserves its own domain',
    body: 'Your deployment is live on a pushify.dev subdomain. Connect a domain you already own — DNS checks and SSL are automatic — or search and register one right inside Pushify and it wires itself to your project.',
    button: 'Connect a domain',
    href: '/dashboard/domains',
  },
  add_database: {
    subject: 'Add a database to your project',
    title: 'One click to Postgres, MySQL, Redis or MongoDB',
    body: 'Pushify provisions databases on your servers with credentials, backups and network wiring handled for you — your app reaches them by name on a private network.',
    button: 'Add a database',
    href: '/dashboard/databases',
  },
};

export async function sendOnboardingEmail(
  to: string,
  key: OnboardingEmailKey,
  unsubscribeUrl: string
): Promise<boolean> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return false;
  const c = ONBOARDING_CONTENT[key];
  const html = renderTransactionalEmail({
    eyebrow: 'Getting started',
    title: c.title,
    greeting: 'Hi there,',
    body: c.body,
    button: { href: `${env.FRONTEND_URL}${c.href}`, label: c.button },
    footerNote: `You get a few of these while settling in. <a href="${unsubscribeUrl}" style="color:#71717a;text-decoration:underline;">Unsubscribe from onboarding emails</a>.`,
  });
  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject: c.subject, html });
    logger.info({ to, key }, 'Onboarding email sent');
    return true;
  } catch (error) {
    logger.error({ error, to, key }, 'Failed to send onboarding email');
    return false;
  }
}

export interface WeeklyDigestStats {
  deployments: number;
  failedDeployments: number;
  activeProjects: number;
  runningServers: number;
  walletBalanceCents: number;
}

export async function sendWeeklyDigestEmail(
  to: string,
  orgName: string,
  stats: WeeklyDigestStats
): Promise<boolean> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return false;
  const dashboardUrl = `${env.FRONTEND_URL}/dashboard`;
  const settingsUrl = `${env.FRONTEND_URL}/dashboard/settings?tab=notifications`;
  const rows: EmailDetailRow[] = [
    { label: 'Deployments this week', value: String(stats.deployments) },
    { label: 'Failed deployments', value: String(stats.failedDeployments) },
    { label: 'Active projects', value: String(stats.activeProjects) },
    { label: 'Running servers', value: String(stats.runningServers) },
    { label: 'Infrastructure credits', value: formatUsd(stats.walletBalanceCents) },
  ];
  const bodyHtml = `Your week on <strong style="color:#18181b;">${esc(orgName)}</strong>:`;
  const html = renderTransactionalEmail({
    eyebrow: 'Weekly digest',
    title: 'Your Pushify week',
    greeting: 'Hi there,',
    bodyHtml,
    details: rows,
    button: { href: dashboardUrl, label: 'Open dashboard' },
    footerNote: `Weekly digest is on for your account — <a href="${settingsUrl}" style="color:#71717a;text-decoration:underline;">manage notification settings</a>.`,
  });
  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject: `Your Pushify week — ${orgName}`, html });
    logger.info({ to, orgName }, 'Weekly digest sent');
    return true;
  } catch (error) {
    logger.error({ error, to }, 'Failed to send weekly digest');
    return false;
  }
}

// ============ Deployment alerts (Settings → Notifications) ============

export interface DeploymentAlertEmailInput {
  projectName: string;
  branch?: string;
  error?: string;
  url: string;
}

function deploymentFailedTemplate(input: DeploymentAlertEmailInput, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Deployment failed',
      greeting: 'Hi there,',
      button: 'Open deployment',
      note: 'You get this because Deployment alerts is on in Settings → Notifications.',
    },
    tr: {
      title: 'Deploy başarısız oldu',
      greeting: 'Merhaba,',
      button: 'Deploy\'u aç',
      note: 'Bu e-postayı Ayarlar → Bildirimler\'de "Deploy uyarıları" açık olduğu için alıyorsunuz.',
    },
  };
  const t = texts[locale] ?? texts.en;
  const safeProject = esc(input.projectName);
  const branch = input.branch ? ` <span style="color:#71717a;">(${esc(input.branch)})</span>` : '';
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeProject}</strong>${branch} projesinin son deploy'u başarısız oldu.`
      : `The latest deployment of <strong style="color:#18181b;">${safeProject}</strong>${branch} failed.`;

  return renderTransactionalEmail({
    eyebrow: locale === 'tr' ? 'Deploy başarısız' : 'Deploy failed',
    tone: 'danger',
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    code: input.error ? { text: input.error.slice(0, 600) } : undefined,
    button: { href: input.url, label: t.button },
    footerNote: t.note,
  });
}

function deploymentRecoveredTemplate(input: DeploymentAlertEmailInput, locale: 'en' | 'tr'): string {
  const texts = {
    en: {
      title: 'Deployment recovered',
      greeting: 'Hi there,',
      button: 'Open deployment',
      note: 'You get this because Deployment alerts is on in Settings → Notifications.',
    },
    tr: {
      title: 'Deploy tekrar düzeldi',
      greeting: 'Merhaba,',
      button: 'Deploy\'u aç',
      note: 'Bu e-postayı Ayarlar → Bildirimler\'de "Deploy uyarıları" açık olduğu için alıyorsunuz.',
    },
  };
  const t = texts[locale] ?? texts.en;
  const safeProject = esc(input.projectName);
  const branch = input.branch ? ` <span style="color:#71717a;">(${esc(input.branch)})</span>` : '';
  const bodyHtml =
    locale === 'tr'
      ? `<strong style="color:#18181b;">${safeProject}</strong>${branch} projesinin yeni deploy'u başarılı — önceki hata giderildi.`
      : `A new deployment of <strong style="color:#18181b;">${safeProject}</strong>${branch} succeeded after the previous one failed.`;

  return renderTransactionalEmail({
    eyebrow: locale === 'tr' ? 'Deploy düzeldi' : 'Deploy recovered',
    tone: 'success',
    title: t.title,
    greeting: t.greeting,
    bodyHtml,
    button: { href: input.url, label: t.button },
    footerNote: t.note,
  });
}

export async function sendDeploymentFailedEmail(
  to: string,
  input: DeploymentAlertEmailInput,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping deployment failed email');
    return;
  }
  const subjects = {
    en: `Deployment failed: ${input.projectName}`,
    tr: `Deploy başarısız: ${input.projectName}`,
  };
  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: deploymentFailedTemplate(input, locale),
    });
    logger.info({ to, project: input.projectName }, 'Deployment failed email sent');
  } catch (error) {
    logger.error({ error, to, project: input.projectName }, 'Failed to send deployment failed email');
  }
}

export async function sendDeploymentRecoveredEmail(
  to: string,
  input: DeploymentAlertEmailInput,
  locale: 'en' | 'tr' = 'en'
): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    logger.warn('Email not configured — skipping deployment recovered email');
    return;
  }
  const subjects = {
    en: `Deployment recovered: ${input.projectName}`,
    tr: `Deploy düzeldi: ${input.projectName}`,
  };
  try {
    await transporter.sendMail({
      from: FROM_ADDRESS,
      to,
      subject: subjects[locale] ?? subjects.en,
      html: deploymentRecoveredTemplate(input, locale),
    });
    logger.info({ to, project: input.projectName }, 'Deployment recovered email sent');
  } catch (error) {
    logger.error({ error, to, project: input.projectName }, 'Failed to send deployment recovered email');
  }
}
