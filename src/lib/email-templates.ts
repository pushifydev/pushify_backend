/**
 * Shared HTML email templates — minimal monochrome, aligned with Pushify dashboard/landing.
 * Table-based layout for broad client support (Gmail, Apple Mail, Outlook).
 */

// Light "Clean Pro" palette — mirrors the dashboard light theme (app/globals.css html.light).
const E = {
  bg: '#f9fafb',
  card: '#ffffff',
  inset: '#f3f4f6',
  border: '#e4e4e7',
  borderSubtle: '#f0f0f1',
  text: '#09090b',
  textSecondary: '#3f3f46',
  textMuted: '#71717a',
  btnBg: '#6366f1',
  btnText: '#ffffff',
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  fontMono: "ui-monospace,'SF Mono',Menlo,Monaco,Consolas,monospace",
  radius: '12px',
  radiusSm: '8px',
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Outer shell: logo + card + footer */
export function renderEmailLayout(content: string, footerNote?: string): string {
  const year = new Date().getFullYear();
  const note = footerNote
    ? `<p style="margin:12px 0 0 0;color:${E.textMuted};font-size:11px;line-height:1.5;">${footerNote}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Pushify</title>
</head>
<body style="margin:0;padding:0;background-color:${E.bg};font-family:${E.font};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${E.bg};min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <tr>
            <td align="center" style="padding:0 0 28px 0;">
              <span style="font-size:18px;font-weight:700;letter-spacing:-0.04em;color:${E.text};">Pushify</span>
            </td>
          </tr>

          <tr>
            <td style="background-color:${E.card};border:1px solid ${E.border};border-radius:${E.radius};padding:36px 32px;">
              ${content}
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:24px 8px 0 8px;">
              <p style="margin:0;color:${E.textMuted};font-size:12px;">&copy; ${year} Pushify</p>
              ${note}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderEmailButton(href: string, label: string): string {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 8px 0;">
      <tr>
        <td align="center">
          <a href="${safeHref}"
             style="display:inline-block;background-color:${E.btnBg};color:${E.btnText};text-decoration:none;font-size:14px;font-weight:600;padding:13px 28px;border-radius:${E.radiusSm};letter-spacing:-0.01em;">
            ${safeLabel}
          </a>
        </td>
      </tr>
    </table>`;
}

function renderDivider(): string {
  return `<hr style="border:none;border-top:1px solid ${E.borderSubtle};margin:28px 0;" />`;
}

function renderUrlFallback(label: string, href: string): string {
  return `
    <p style="margin:0 0 8px 0;color:${E.textMuted};font-size:12px;line-height:1.5;">${escapeHtml(label)}</p>
    <p style="margin:0;word-break:break-all;">
      <a href="${escapeHtml(href)}" style="color:${E.textSecondary};font-size:12px;text-decoration:underline;">${escapeHtml(href)}</a>
    </p>`;
}

export interface TransactionalEmailContent {
  title: string;
  greeting: string;
  /** Plain text — escaped */
  body?: string;
  /** Trusted HTML from our templates (invitation, billing) */
  bodyHtml?: string;
  button?: { href: string; label: string };
  /** Trusted HTML snippets (expiry, disclaimers) */
  notes?: string[];
  urlFallback?: { label: string; href: string };
}

/** Password reset, verification, invitation, billing */
export function renderTransactionalEmail(content: TransactionalEmailContent): string {
  const notesHtml =
    content.notes && content.notes.length > 0
      ? content.notes
          .map(
            (n) =>
              `<p style="margin:0 0 12px 0;color:${E.textMuted};font-size:13px;line-height:1.6;">${n}</p>`
          )
          .join('')
      : '';

  const bodyBlock = content.bodyHtml
    ? `<p style="margin:0 0 8px 0;color:${E.textSecondary};font-size:15px;line-height:1.6;">${content.bodyHtml}</p>`
    : content.body
      ? `<p style="margin:0 0 8px 0;color:${E.textSecondary};font-size:15px;line-height:1.6;">${escapeHtml(content.body)}</p>`
      : '';

  const inner = `
    <h1 style="margin:0 0 16px 0;color:${E.text};font-size:22px;font-weight:700;letter-spacing:-0.03em;line-height:1.25;">${escapeHtml(content.title)}</h1>
    <p style="margin:0 0 12px 0;color:${E.textSecondary};font-size:15px;line-height:1.6;">${escapeHtml(content.greeting)}</p>
    ${bodyBlock}
    ${content.button ? renderEmailButton(content.button.href, content.button.label) : ''}
    ${notesHtml || content.urlFallback ? renderDivider() : ''}
    ${notesHtml}
    ${content.urlFallback ? renderUrlFallback(content.urlFallback.label, content.urlFallback.href) : ''}
  `;

  return renderEmailLayout(inner.trim());
}

// ─── Notification (deployment / health) emails ───

export interface NotificationEmailPayload {
  event: string;
  projectName: string;
  branch?: string;
  commitHash?: string;
  status?: string;
  message?: string;
  logTail?: string;
  url?: string;
}

interface EventMeta {
  title: string;
  accent: string;
  emoji: string;
}

const EVENT_META: Record<string, EventMeta> = {
  'deployment.started': { title: 'Deployment started', accent: '#a3a3a3', emoji: '○' },
  'deployment.success': { title: 'Deployment successful', accent: '#22c55e', emoji: '✓' },
  'deployment.failed': { title: 'Deployment failed', accent: '#ef4444', emoji: '✕' },
  'health.unhealthy': { title: 'Health check failed', accent: '#ef4444', emoji: '!' },
  'health.recovered': { title: 'Health check recovered', accent: '#22c55e', emoji: '✓' },
  test: { title: 'Test notification', accent: '#a78bfa', emoji: '◇' },
};

export function getNotificationEventTitle(event: string): string {
  return EVENT_META[event]?.title ?? event;
}

export function getNotificationEventEmoji(event: string): string {
  const map: Record<string, string> = {
    'deployment.started': '🚀',
    'deployment.success': '✅',
    'deployment.failed': '❌',
    'health.unhealthy': '🚨',
    'health.recovered': '💚',
    test: '🔔',
  };
  return map[event] ?? '📢';
}

/** Slack attachment sidebar color */
export function getNotificationEventColor(event: string): string {
  const map: Record<string, string> = {
    'deployment.started': '#737373',
    'deployment.success': '#22c55e',
    'deployment.failed': '#ef4444',
    'health.unhealthy': '#ef4444',
    'health.recovered': '#22c55e',
    test: '#a78bfa',
  };
  return map[event] ?? '#737373';
}

function getEventMeta(event: string): EventMeta {
  return EVENT_META[event] ?? { title: event, accent: E.textMuted, emoji: '•' };
}

function renderDetailRow(label: string, value: string, mono = false): string {
  return `
    <tr>
      <td style="padding:12px 16px;border-top:1px solid ${E.borderSubtle};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:11px;color:${E.textMuted};text-transform:uppercase;letter-spacing:0.06em;vertical-align:top;">${escapeHtml(label)}</td>
            <td align="right" style="font-size:14px;color:${E.text};font-weight:500;${mono ? `font-family:${E.fontMono};` : ''}vertical-align:top;padding-left:16px;">${escapeHtml(value)}</td>
          </tr>
        </table>
      </td>
    </tr>`;
}

export function renderNotificationEmail(
  payload: NotificationEmailPayload,
  locale: 'en' | 'tr' = 'en'
): string {
  const meta = getEventMeta(payload.event);
  const ctaLabel = locale === 'tr' ? 'Dağıtımı görüntüle' : 'View deployment';
  const footerNote =
    locale === 'tr'
      ? 'Bu e-postayı proje bildirimleri açık olduğu için aldınız.'
      : 'You received this email because notifications are enabled for this project.';

  const rows: string[] = [renderDetailRow('Project', payload.projectName)];
  if (payload.branch) rows.push(renderDetailRow('Branch', payload.branch, true));
  if (payload.commitHash) rows.push(renderDetailRow('Commit', payload.commitHash.slice(0, 7), true));
  if (payload.status) rows.push(renderDetailRow('Status', payload.status));

  const messageBlock = payload.message
    ? `
      <div style="margin-top:20px;padding:14px 16px;background-color:${E.inset};border-left:3px solid ${meta.accent};border-radius:0 ${E.radiusSm} ${E.radiusSm} 0;">
        <p style="margin:0;color:${E.textSecondary};font-size:14px;line-height:1.6;">${escapeHtml(payload.message)}</p>
      </div>`
    : '';

  const logTailBlock = payload.logTail
    ? `
      <div style="margin-top:16px;padding:12px 14px;background-color:${E.inset};border:1px solid ${E.borderSubtle};border-radius:${E.radiusSm};">
        <p style="margin:0 0 8px 0;font-size:11px;color:${E.textMuted};text-transform:uppercase;letter-spacing:0.06em;">Recent logs</p>
        <pre style="margin:0;font-family:${E.fontMono};font-size:11px;line-height:1.45;color:${E.textSecondary};white-space:pre-wrap;word-break:break-word;">${escapeHtml(payload.logTail)}</pre>
      </div>`
    : '';

  const inner = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td>
          <span style="display:inline-block;padding:6px 12px;border-radius:999px;background-color:${E.inset};border:1px solid ${E.borderSubtle};font-size:12px;font-weight:600;color:${meta.accent};letter-spacing:0.02em;">
            ${meta.emoji}&nbsp; ${escapeHtml(meta.title)}
          </span>
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${E.inset};border:1px solid ${E.borderSubtle};border-radius:${E.radiusSm};overflow:hidden;">
      ${rows.join('')}
    </table>

    ${messageBlock}
    ${logTailBlock}
    ${payload.url ? renderEmailButton(payload.url, ctaLabel) : ''}
  `;

  return renderEmailLayout(inner.trim(), footerNote);
}
