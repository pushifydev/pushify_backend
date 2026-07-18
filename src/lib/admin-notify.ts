import { env } from '../config/env';

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
  | 'domain.authcode_viewed';

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

  const rowsHtml = entries
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0;color:#111827;font-size:13px">${escapeHtml(String(v))}</td></tr>`,
    )
    .join('');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f9fafb;font-family:ui-sans-serif,system-ui,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
<p style="margin:0 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">Pushify Admin</p>
<h1 style="margin:0 0 16px;font-size:18px;color:#111827">${escapeHtml(title)}</h1>
<table style="border-collapse:collapse;width:100%">${rowsHtml}
<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px">Time</td><td style="padding:6px 0;color:#111827;font-size:13px">${when}</td></tr>
<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px">Event</td><td style="padding:6px 0;color:#6b7280;font-size:13px;font-family:ui-monospace,monospace">${event}</td></tr>
</table>
</div></body></html>`;

  const text =
    `${title}\n` +
    entries.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\nTime: ${when}\nEvent: ${event}`;

  return { subject: `[Pushify] ${title}`, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
