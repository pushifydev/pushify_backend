import { env } from '../config/env';
import { renderTransactionalEmail } from './email-templates';

/**
 * Admin notification catalog — operational events that email the operator(s) listed in
 * ADMIN_NOTIFY_EMAILS (comma-separated). Delivery goes through the BullMQ notification
 * infrastructure when Redis is configured, with a direct-send fallback otherwise.
 */

export type AdminEvent =
  | 'user.registered'
  | 'subscription.activated'
  | 'subscription.canceled'
  | 'payment.failed'
  | 'wallet.topup'
  | 'server.created'
  | 'server.deleted'
  | 'server.suspended'
  | 'project.created'
  | 'project.deleted'
  | 'database.created'
  | 'database.deleted'
  | 'deployment.failed'
  | 'domain.purchased'
  | 'domain.renewed'
  | 'domain.renewal_failed'
  | 'domain.transfer_started'
  | 'domain.transfer_completed'
  | 'domain.transfer_failed'
  | 'domain.authcode_viewed'
  | 'feedback.cancellation'
  | 'backup.verify_failed'
  | 'certificate.expiring'
  | 'resource.pressure'
  | 'server.disk_full';

export const ADMIN_EVENT_TITLES: Record<AdminEvent, string> = {
  'user.registered': 'New user registered',
  'subscription.activated': 'Subscription activated',
  'subscription.canceled': 'Subscription canceled',
  'payment.failed': 'Payment failed',
  'wallet.topup': 'Infra wallet credited',
  'server.created': 'Server created',
  'server.deleted': 'Server deleted',
  'server.suspended': 'Server suspended (insufficient credits)',
  'project.created': 'Project created',
  'project.deleted': 'Project deleted',
  'database.created': 'Database created',
  'database.deleted': 'Database deleted',
  'deployment.failed': 'Deployment failed',
  'domain.purchased': 'Domain purchased',
  'domain.renewed': 'Domain renewed',
  'domain.renewal_failed': 'Domain renewal failed',
  'domain.transfer_started': 'Domain transfer started',
  'domain.transfer_completed': 'Domain transfer completed',
  'domain.transfer_failed': 'Domain transfer failed',
  'domain.authcode_viewed': 'Domain auth code viewed (transfer-out)',
  'feedback.cancellation': 'Cancellation feedback received',
  'backup.verify_failed': 'Backup restore test failed',
  'certificate.expiring': 'HTTPS certificate expiring soon',
  'resource.pressure': 'An app is running out of memory or CPU',
  'server.disk_full': 'A server is running out of disk',
};

/** Parse ADMIN_NOTIFY_EMAILS into a clean recipient list. */
export function parseAdminNotifyEmails(raw?: string): string[] {
  const source = raw ?? env.ADMIN_NOTIFY_EMAILS ?? '';
  return source
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 3 && s.includes('@'));
}

export interface AdminEmailContent {
  subject: string;
  html: string;
  text: string;
}

/** Build the admin email — a quiet, scannable field table. */
export function buildAdminEmailContent(
  event: AdminEvent,
  fields: Record<string, string | number | null | undefined>,
): AdminEmailContent {
  const title = ADMIN_EVENT_TITLES[event] ?? event;
  const when = new Date().toISOString();

  const entries = Object.entries(fields).filter(
    ([, v]) => v !== undefined && v !== null && String(v).length > 0,
  );

  // Values are escaped by the details renderer.
  const html = renderTransactionalEmail({
    eyebrow: 'Pushify Admin',
    title,
    details: [
      ...entries.map(([k, v]) => ({ label: k, value: String(v) })),
      { label: 'Time', value: when },
      { label: 'Event', value: event },
    ],
  });

  const text =
    `${title}\n` +
    entries.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\nTime: ${when}\nEvent: ${event}`;

  return { subject: `[Pushify] ${title}`, html, text };
}
