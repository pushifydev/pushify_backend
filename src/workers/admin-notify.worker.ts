import { Worker, type Job } from 'bullmq';
import { QUEUE_NAMES, type AdminNotifyJobData } from '../lib/queue';
import { getBullRedisConnection } from '../lib/redis-connection';
import { sendAdminNotificationEmail } from '../lib/email';
import { logger } from '../lib/logger';

let adminNotifyWorker: Worker<AdminNotifyJobData> | null = null;

async function processAdminNotifyJob(job: Job<AdminNotifyJobData>): Promise<void> {
  const { emails, subject, html, text } = job.data;
  await sendAdminNotificationEmail(emails, subject, html, text);
}

export function startAdminNotifyWorker(): Worker<AdminNotifyJobData> | null {
  const connection = getBullRedisConnection();
  if (!connection) return null;

  if (!adminNotifyWorker) {
    adminNotifyWorker = new Worker<AdminNotifyJobData>(
      QUEUE_NAMES.ADMIN_NOTIFY,
      processAdminNotifyJob,
      { connection, concurrency: 2 },
    );
    adminNotifyWorker.on('failed', (job, err) => {
      logger.warn({ jobId: job?.id, err }, 'Admin notify job failed');
    });
  }

  return adminNotifyWorker;
}

export async function stopAdminNotifyWorker(): Promise<void> {
  if (adminNotifyWorker) {
    await adminNotifyWorker.close();
    adminNotifyWorker = null;
  }
}
