/**
 * Shared HTML email templates — Pushify's monochrome language (pushify.dev): hairlines, a black
 * "P" mark, bracketed mono eyebrows, one black pill button, colour only for status.
 *
 * Email constraints drive the markup: table layout, inline styles only, 560px max width with an
 * Outlook ghost table, VML pill button for Outlook, web-safe font stacks (no web fonts — Outlook
 * falls back to Times when it cannot resolve one). The body is deliberately LIGHT: forced dark
 * mode in Gmail/Outlook inverts light layouts cleanly, but mangles dark ones. Every element sets
 * both its colour and background so a partial inversion never leaves dark-on-dark text.
 */

const E = {
  page: '#f4f4f5',
  card: '#ffffff',
  inset: '#fafafa',
  hairline: '#e4e4e7',
  text: '#09090b',
  body: '#52525b',
  muted: '#71717a',
  faint: '#a1a1aa',
  btnBg: '#09090b',
  btnText: '#ffffff',
  font: "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
  mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace",
} as const;

/** Status colour — used only for the small dot next to the eyebrow. */
export type EmailTone = 'neutral' | 'success' | 'warning' | 'danger';

const TONE: Record<EmailTone, string> = {
  neutral: E.faint,
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
};

/** Marker inside the card where trailing blocks (e.g. an invoice link) can be appended. */
export const EMAIL_CONTENT_END = '<!--pushify:content-end-->';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Building blocks ───

/** `● [ DEPLOY FAILED ]` — mono uppercase label; the dot carries the status colour. */
function renderEyebrow(label: string, tone?: EmailTone): string {
  const dot = tone
    ? `<span style="color:${TONE[tone]};font-size:11px;line-height:16px;vertical-align:1px;">&#9679;</span>&nbsp;&nbsp;`
    : '';
  return `<p class="mono" style="margin:0 0 14px 0;font-family:${E.mono};font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:${E.muted};">${dot}[&nbsp;${escapeHtml(label)}&nbsp;]</p>`;
}

export interface EmailDetailRow {
  label: string;
  value: string;
}

/** Hairline-ruled mono key/value table (project, commit, time, IP …). Values are escaped. */
export function renderEmailDetails(rows: EmailDetailRow[]): string {
  if (rows.length === 0) return '';
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="mono" valign="top" width="176" style="width:176px;padding:10px 12px 10px 0;border-bottom:1px solid ${E.hairline};font-family:${E.mono};font-size:11px;line-height:18px;letter-spacing:0.06em;text-transform:uppercase;color:${E.muted};">${escapeHtml(r.label)}</td>
        <td class="mono" valign="top" style="padding:10px 0;border-bottom:1px solid ${E.hairline};font-family:${E.mono};font-size:13px;line-height:18px;color:${E.text};word-break:break-word;">${escapeHtml(r.value)}</td>
      </tr>`
    )
    .join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;border-collapse:collapse;border-top:1px solid ${E.hairline};">${body}
    </table>`;
}

/** Mono block for errors / log tails. Text is escaped. */
function renderCodeBlock(text: string, label?: string): string {
  const head = label
    ? `<p class="mono" style="margin:0 0 8px 0;font-family:${E.mono};font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:${E.muted};">[&nbsp;${escapeHtml(label)}&nbsp;]</p>`
    : '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;">
      <tr>
        <td style="padding:14px 16px;background-color:${E.inset};border:1px solid ${E.hairline};border-radius:8px;">
          ${head}<pre class="mono" style="margin:0;font-family:${E.mono};font-size:12px;line-height:1.55;color:${E.text};white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</pre>
        </td>
      </tr>
    </table>`;
}

/** Bulletproof black pill: VML roundrect for Outlook desktop, a padded link everywhere else. */
export function renderEmailButton(href: string, label: string): string {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  // VML needs a fixed width; approximate from label length (14px semi-bold ≈ 8px/char).
  const vmlWidth = Math.max(140, Math.round(label.length * 8.2) + 56);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0 0;">
      <tr>
        <td align="left">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeHref}" style="height:42px;v-text-anchor:middle;width:${vmlWidth}px;" arcsize="50%" stroke="f" fillcolor="${E.btnBg}">
            <w:anchorlock/>
            <center style="color:${E.btnText};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;">${safeLabel}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${safeHref}" target="_blank" style="display:inline-block;background-color:${E.btnBg};color:${E.btnText};font-family:${E.font};font-size:14px;font-weight:600;line-height:18px;text-decoration:none;padding:12px 24px;border-radius:999px;border:1px solid ${E.btnBg};mso-hide:all;">${safeLabel}</a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;
}

function renderUrlFallback(label: string, href: string): string {
  return `
    <p style="margin:0 0 6px 0;color:${E.muted};font-size:12px;line-height:1.5;">${escapeHtml(label)}</p>
    <p class="mono" style="margin:0;font-family:${E.mono};font-size:12px;line-height:1.5;word-break:break-all;">
      <a href="${escapeHtml(href)}" style="color:${E.body};text-decoration:underline;">${escapeHtml(href)}</a>
    </p>`;
}

// ─── Layout ───

/**
 * Outer shell: grey page, white hairline card with the "P" mark header, quiet footer.
 * `footerNote` is trusted HTML (why you got this / settings / unsubscribe).
 */
export function renderEmailLayout(content: string, footerNote?: string): string {
  const year = new Date().getFullYear();
  const note = footerNote
    ? `<p style="margin:0 0 10px 0;color:${E.muted};font-size:12px;line-height:1.6;">${footerNote}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Pushify</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <style>body,table,td,p,a,h1,span,center{font-family:Arial,Helvetica,sans-serif !important;} pre,.mono{font-family:Consolas,'Courier New',monospace !important;}</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;width:100%;background-color:${E.page};font-family:${E.font};color:${E.text};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${E.page};">
    <tr>
      <td align="center" style="padding:40px 16px;background-color:${E.page};">
        <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

          <tr>
            <td style="background-color:${E.card};border:1px solid ${E.hairline};border-radius:12px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:20px 32px;border-bottom:1px solid ${E.hairline};">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="24" height="24" align="center" valign="middle" style="width:24px;height:24px;background-color:${E.text};border-radius:6px;font-family:${E.font};font-size:14px;line-height:24px;font-weight:700;color:#ffffff;">P</td>
                        <td style="padding-left:10px;font-family:${E.font};font-size:15px;line-height:24px;font-weight:600;letter-spacing:-0.02em;color:${E.text};">Pushify</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:32px 32px 36px 32px;font-family:${E.font};">
                    ${content}
                    ${EMAIL_CONTENT_END}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 8px 0 8px;font-family:${E.font};">
              ${note}
              <p class="mono" style="margin:0;color:${E.faint};font-family:${E.mono};font-size:11px;line-height:1.6;letter-spacing:0.04em;">&copy; ${year} Pushify &nbsp;&middot;&nbsp; <a href="https://pushify.dev" style="color:${E.faint};text-decoration:none;">pushify.dev</a></p>
            </td>
          </tr>

        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Transactional emails ───

export interface TransactionalEmailContent {
  /** Mono uppercase label shown as `[ LABEL ]` above the title. */
  eyebrow?: string;
  /** Status dot colour next to the eyebrow. Omit for plain informational mail. */
  tone?: EmailTone;
  /** Omitted for short alert mails — the first paragraph is then set as the lead. */
  title?: string;
  greeting?: string;
  /** Plain text — escaped */
  body?: string;
  /** Trusted HTML from our templates; an array renders as separate paragraphs. */
  bodyHtml?: string | string[];
  /** Mono key/value rows (values escaped). */
  details?: EmailDetailRow[];
  /** Mono block for an error message or log excerpt (escaped). */
  code?: { text: string; label?: string };
  button?: { href: string; label: string };
  /** Trusted HTML snippets (expiry, disclaimers) */
  notes?: string[];
  urlFallback?: { label: string; href: string };
  /** Trusted HTML under the card: why you got this, settings, unsubscribe. */
  footerNote?: string;
}

/** Password reset, verification, invitation, billing, alerts */
export function renderTransactionalEmail(content: TransactionalEmailContent): string {
  const paragraphs: string[] = Array.isArray(content.bodyHtml)
    ? content.bodyHtml
    : content.bodyHtml
      ? [content.bodyHtml]
      : content.body
        ? [escapeHtml(content.body)]
        : [];

  const leadOnly = !content.title && !content.greeting;
  const bodyBlock = paragraphs
    .map((p, i) =>
      leadOnly && i === 0
        ? `<div style="margin:0 0 12px 0;color:${E.text};font-size:17px;line-height:1.55;font-weight:500;letter-spacing:-0.01em;">${p}</div>`
        : `<div style="margin:0 0 12px 0;color:${E.body};font-size:15px;line-height:1.65;">${p}</div>`
    )
    .join('');

  const notesHtml =
    content.notes && content.notes.length > 0
      ? content.notes
          .map(
            (n) =>
              `<p style="margin:0 0 10px 0;color:${E.muted};font-size:13px;line-height:1.6;">${n}</p>`
          )
          .join('')
      : '';

  const tail =
    notesHtml || content.urlFallback
      ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 0 0;">
      <tr><td style="padding:20px 0 0 0;border-top:1px solid ${E.hairline};">
        ${notesHtml}
        ${content.urlFallback ? `<div style="margin:${notesHtml ? '14px' : '0'} 0 0 0;">${renderUrlFallback(content.urlFallback.label, content.urlFallback.href)}</div>` : ''}
      </td></tr>
    </table>`
      : '';

  const inner = `
    ${content.eyebrow ? renderEyebrow(content.eyebrow, content.tone) : ''}
    ${content.title ? `<h1 style="margin:0 0 18px 0;color:${E.text};font-family:${E.font};font-size:24px;font-weight:600;letter-spacing:-0.025em;line-height:1.25;">${escapeHtml(content.title)}</h1>` : ''}
    ${content.greeting ? `<p style="margin:0 0 12px 0;color:${E.body};font-size:15px;line-height:1.65;">${escapeHtml(content.greeting)}</p>` : ''}
    ${bodyBlock}
    ${content.details ? renderEmailDetails(content.details) : ''}
    ${content.code ? renderCodeBlock(content.code.text, content.code.label) : ''}
    ${content.button ? renderEmailButton(content.button.href, content.button.label) : ''}
    ${tail}
  `;

  return renderEmailLayout(inner.trim(), content.footerNote);
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
  tone: EmailTone;
}

const EVENT_META: Record<string, EventMeta> = {
  'deployment.started': { title: 'Deployment started', tone: 'neutral' },
  'deployment.success': { title: 'Deployment successful', tone: 'success' },
  'deployment.failed': { title: 'Deployment failed', tone: 'danger' },
  'health.unhealthy': { title: 'Health check failed', tone: 'danger' },
  'health.recovered': { title: 'Health check recovered', tone: 'success' },
  test: { title: 'Test notification', tone: 'neutral' },
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
  return EVENT_META[event] ?? { title: event, tone: 'neutral' };
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

  const rows: EmailDetailRow[] = [{ label: 'Project', value: payload.projectName }];
  if (payload.branch) rows.push({ label: 'Branch', value: payload.branch });
  if (payload.commitHash) rows.push({ label: 'Commit', value: payload.commitHash.slice(0, 7) });
  if (payload.status) rows.push({ label: 'Status', value: payload.status });

  const html = renderTransactionalEmail({
    eyebrow: payload.event,
    tone: meta.tone,
    title: meta.title,
    body: payload.message,
    details: rows,
    code: payload.logTail ? { text: payload.logTail, label: 'Recent logs' } : undefined,
    button: payload.url ? { href: payload.url, label: ctaLabel } : undefined,
    footerNote,
  });
  return html;
}
