/**
 * Email the operators in ADMIN_NOTIFY_EMAILS, for shell scripts that fail outside the app (the
 * nightly control-plane backup). The body is read from stdin, e.g. the tail of a log:
 *
 *   tail -n 40 /var/log/pushify-backup.log | npm run --silent notify:admin -- "Control-plane backup failed"
 *
 * Run from the backend directory so it picks up .env (Gmail credentials and ADMIN_NOTIFY_EMAILS).
 * Exits non-zero when nothing could be sent, so cron's own mail still reports the failure.
 */
import { parseAdminNotifyEmails } from '../src/lib/admin-notify';
import { renderTransactionalEmail } from '../src/lib/email-templates';
import { sendAdminNotificationEmail } from '../src/lib/email';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').slice(-20_000);
}

const subject = process.argv.slice(2).join(' ').trim() || 'Pushify alert';
const body = await readStdin();
const to = parseAdminNotifyEmails();
if (to.length === 0) {
  console.error('ADMIN_NOTIFY_EMAILS is empty — nothing sent');
  process.exit(1);
}
const html = renderTransactionalEmail({
  eyebrow: 'Alert',
  tone: 'danger',
  title: subject,
  code: body ? { text: body, label: 'Output' } : undefined,
});
const sent = await sendAdminNotificationEmail(to, `[Pushify] ${subject}`, html, `${subject}\n\n${body}`);
if (!sent) {
  console.error('could not send (is Gmail configured in .env?)');
  process.exit(1);
}
console.log(`sent to ${to.length} recipient(s): ${subject}`);
process.exit(0);
