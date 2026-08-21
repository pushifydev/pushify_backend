import { Worker, Job } from 'bullmq';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { notificationRepository } from '../repositories/notification.repository';
import { QUEUE_NAMES, type NotificationJobData } from '../lib/queue';
import { getBullRedisConnection } from '../lib/redis-connection';
import {
  renderNotificationEmail,
  getNotificationEventEmoji,
  getNotificationEventTitle,
  getNotificationEventColor,
} from '../lib/email-templates';

// Gmail transporter
let gmailTransporter: nodemailer.Transporter | null = null;

function getGmailTransporter(): nodemailer.Transporter | null {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    return null;
  }

  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: env.GMAIL_USER,
        pass: env.GMAIL_APP_PASSWORD,
      },
    });
  }

  return gmailTransporter;
}

// Get Redis connection
// Honors the DB index in REDIS_URL so environments sharing a Redis host stay isolated
// (see lib/redis-connection.ts).
const getRedisConnection = getBullRedisConnection;

// Worker instance
let notificationWorker: Worker<NotificationJobData> | null = null;

// Process notification job
async function processNotificationJob(job: Job<NotificationJobData>): Promise<boolean> {
  const { type, channelId, payload, config } = job.data;

  logger.info(
    { jobId: job.id, type, channelId, event: payload.event },
    'Processing notification job'
  );

  let success = false;
  let errorMessage: string | null = null;

  try {
    switch (type) {
      case 'slack':
        success = await sendSlackNotification(config as { webhookUrl: string }, payload);
        break;
      case 'email':
        success = await sendEmailNotification(config as { emails: string[] }, payload);
        break;
      case 'webhook':
        success = await sendWebhookNotification(
          config as { url: string; secret?: string },
          payload
        );
        break;
      case 'discord':
        success = await sendDiscordNotification(config as { webhookUrl: string }, payload);
        break;
      default:
        throw new Error(`Unknown notification type: ${type}`);
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, jobId: job.id }, 'Notification job failed');
  }

  // Log the result
  try {
    await notificationRepository.createLog({
      channelId,
      deploymentId: payload.deploymentId,
      eventType: payload.event,
      status: success ? 'sent' : 'failed',
      errorMessage,
    });
  } catch (logError) {
    logger.error({ error: logError }, 'Failed to log notification result');
  }

  if (!success) {
    throw new Error(errorMessage || 'Notification failed');
  }

  return success;
}

// Send Slack notification
async function sendSlackNotification(
  config: { webhookUrl: string },
  payload: NotificationJobData['payload']
): Promise<boolean> {
  const emoji = getNotificationEventEmoji(payload.event);
  const color = getNotificationEventColor(payload.event);

  const slackPayload = {
    attachments: [
      {
        color,
        pretext: `${emoji} ${getNotificationEventTitle(payload.event)}`,
        fields: [
          {
            title: 'Project',
            value: payload.projectName,
            short: true,
          },
          ...(payload.branch
            ? [{ title: 'Branch', value: payload.branch, short: true }]
            : []),
          ...(payload.commitHash
            ? [{ title: 'Commit', value: payload.commitHash.substring(0, 7), short: true }]
            : []),
          ...(payload.status
            ? [{ title: 'Status', value: payload.status, short: true }]
            : []),
          ...(payload.message
            ? [{ title: 'Message', value: payload.message, short: false }]
            : []),
        ],
        actions: payload.url
          ? [{ type: 'button', text: 'View Details', url: payload.url }]
          : [],
        footer: 'Pushify',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slackPayload),
  });

  return response.ok;
}

// Send Discord notification (incoming webhook, embed format)
async function sendDiscordNotification(
  config: { webhookUrl: string },
  payload: NotificationJobData['payload']
): Promise<boolean> {
  const emoji = getNotificationEventEmoji(payload.event);
  // Discord wants a decimal color, our palette is hex strings.
  const color = parseInt(getNotificationEventColor(payload.event).replace('#', ''), 16);

  const discordPayload = {
    embeds: [
      {
        title: `${emoji} ${getNotificationEventTitle(payload.event)}`,
        ...(payload.url ? { url: payload.url } : {}),
        color,
        fields: [
          { name: 'Project', value: payload.projectName, inline: true },
          ...(payload.branch ? [{ name: 'Branch', value: payload.branch, inline: true }] : []),
          ...(payload.commitHash
            ? [{ name: 'Commit', value: payload.commitHash.substring(0, 7), inline: true }]
            : []),
          ...(payload.status ? [{ name: 'Status', value: payload.status, inline: true }] : []),
          ...(payload.message
            ? [{ name: 'Message', value: payload.message.slice(0, 1024), inline: false }]
            : []),
        ],
        footer: { text: 'Pushify' },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(discordPayload),
  });

  return response.ok;
}

// Send Email notification
async function sendEmailNotification(
  config: { emails: string[] },
  payload: NotificationJobData['payload']
): Promise<boolean> {
  const transporter = getGmailTransporter();
  if (!transporter) {
    throw new Error('Gmail SMTP not configured');
  }

  const eventTitle = getNotificationEventTitle(payload.event);

  await transporter.sendMail({
    from: `"${env.GMAIL_FROM_NAME}" <${env.GMAIL_USER}>`,
    to: config.emails.join(', '),
    subject: `${getNotificationEventEmoji(payload.event)} Pushify — ${eventTitle} — ${payload.projectName}`,
    html: renderNotificationEmail(payload),
  });

  return true;
}

// Send Webhook notification
async function sendWebhookNotification(
  config: { url: string; secret?: string },
  payload: NotificationJobData['payload']
): Promise<boolean> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Pushify-Webhook/1.0',
  };

  const body = JSON.stringify({
    event: payload.event,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  if (config.secret) {
    const signature = crypto
      .createHmac('sha256', config.secret)
      .update(body)
      .digest('hex');
    headers['X-Pushify-Signature'] = `sha256=${signature}`;
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body,
  });

  return response.ok;
}

// Start notification worker
export function startNotificationWorker(): Worker<NotificationJobData> | null {
  const connection = getRedisConnection();
  if (!connection) {
    logger.warn('Redis not configured, notification worker not started');
    return null;
  }

  if (notificationWorker) {
    return notificationWorker;
  }

  notificationWorker = new Worker<NotificationJobData>(
    QUEUE_NAMES.NOTIFICATIONS,
    processNotificationJob,
    {
      connection,
      concurrency: 5, // Process 5 notifications concurrently
      limiter: {
        max: 10, // Max 10 jobs per duration
        duration: 1000, // Per second (rate limiting)
      },
    }
  );

  // Event handlers
  notificationWorker.on('completed', (job) => {
    logger.info(
      { jobId: job.id, type: job.data.type, event: job.data.payload.event },
      'Notification job completed'
    );
  });

  notificationWorker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, error: error.message },
      'Notification job failed'
    );
  });

  notificationWorker.on('error', (error) => {
    logger.error({ error }, 'Notification worker error');
  });

  logger.info('Notification worker started');
  return notificationWorker;
}

// Stop notification worker
export async function stopNotificationWorker(): Promise<void> {
  if (notificationWorker) {
    await notificationWorker.close();
    notificationWorker = null;
    logger.info('Notification worker stopped');
  }
}

// Export for type checking
export type { NotificationJobData };
