import { addAdminNotifyJob } from '../lib/queue';
import {
  buildAdminEmailContent,
  parseAdminNotifyEmails,
  type AdminEvent,
} from '../lib/admin-notify';
import { sendAdminNotificationEmail } from '../lib/email';
import { logger } from '../lib/logger';

/**
 * Notify the operator(s) in ADMIN_NOTIFY_EMAILS about a significant platform event.
 *
 * Fire-and-forget by design: call sites must never fail or slow down because an admin
 * email couldn't be produced. Delivery is queued through BullMQ when Redis is available
 * (retried with backoff by the admin-notify worker) and sent directly otherwise.
 */
export function adminNotify(
  event: AdminEvent,
  fields: Record<string, string | number | null | undefined>,
): void {
  const emails = parseAdminNotifyEmails();
  if (emails.length === 0) return;

  const { subject, html, text } = buildAdminEmailContent(event, fields);

  void (async () => {
    try {
      const queued = await addAdminNotifyJob({ emails, subject, html, text });
      if (!queued) {
        await sendAdminNotificationEmail(emails, subject, html, text);
      }
    } catch (error) {
      logger.warn({ error, event }, 'Admin notification failed');
    }
  })();
}
