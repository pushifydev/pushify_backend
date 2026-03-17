import { Worker, Job } from 'bullmq';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { notificationRepository } from '../repositories/notification.repository';
import { decrypt } from '../lib/encryption';
import { QUEUE_NAMES, type NotificationJobData } from '../lib/queue';

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
function getRedisConnection() {
  if (!env.REDIS_URL) return null;

  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
  };
}

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
  const emoji = getEventEmoji(payload.event);
  const color = getEventColor(payload.event);

  const slackPayload = {
    attachments: [
      {
        color,
        pretext: `${emoji} ${getEventTitle(payload.event)}`,
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

// Send Email notification
async function sendEmailNotification(
  config: { emails: string[] },
  payload: NotificationJobData['payload']
): Promise<boolean> {
  const transporter = getGmailTransporter();
  if (!transporter) {
    throw new Error('Gmail SMTP not configured');
  }

  const emoji = getEventEmoji(payload.event);
  const eventTitle = getEventTitle(payload.event);

  await transporter.sendMail({
    from: `"${env.GMAIL_FROM_NAME}" <${env.GMAIL_USER}>`,
    to: config.emails.join(', '),
    subject: `${emoji} [Pushify] ${eventTitle} - ${payload.projectName}`,
    html: buildEmailHtml(payload),
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

// Build HTML email - Neo-Industrial Dark Theme
function buildEmailHtml(payload: NotificationJobData['payload']): string {
  const emoji = getEventEmoji(payload.event);
  const eventTitle = getEventTitle(payload.event);
  const colors = getEventColors(payload.event);
  const statusIcon = getStatusIcon(payload.event);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', 'Droid Sans Mono', monospace; line-height: 1.6; color: #f4f4f5; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #0c0c0e;">
      <!-- Main Container -->
      <div style="background: #141418; border: 1px solid #27272a; border-radius: 8px; overflow: hidden;">

        <!-- Header -->
        <div style="background: linear-gradient(135deg, ${colors.bg} 0%, #141418 100%); padding: 32px; border-bottom: 1px solid #27272a;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 48px; height: 48px; background: ${colors.primary}20; border: 1px solid ${colors.primary}40; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
              <span style="font-size: 24px; color: ${colors.primary};">${statusIcon}</span>
            </div>
            <div>
              <h1 style="color: #f4f4f5; margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em;">${eventTitle}</h1>
              <p style="color: #71717a; margin: 4px 0 0 0; font-size: 13px;">${emoji} Pushify Deployment Notification</p>
            </div>
          </div>
        </div>

        <!-- Content -->
        <div style="padding: 24px;">
          <!-- Info Grid -->
          <div style="background: #0c0c0e; border: 1px solid #27272a; border-radius: 6px; overflow: hidden;">
            <div style="padding: 16px; border-bottom: 1px solid #27272a;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="color: #71717a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Project</span>
                <span style="color: #22d3ee; font-weight: 500;">${payload.projectName}</span>
              </div>
            </div>
            ${payload.branch ? `
            <div style="padding: 16px; border-bottom: 1px solid #27272a;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="color: #71717a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Branch</span>
                <span style="color: #f4f4f5; font-family: monospace; background: #27272a; padding: 2px 8px; border-radius: 4px; font-size: 13px;">${payload.branch}</span>
              </div>
            </div>
            ` : ''}
            ${payload.commitHash ? `
            <div style="padding: 16px; border-bottom: 1px solid #27272a;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="color: #71717a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Commit</span>
                <span style="color: #a855f7; font-family: monospace; background: #27272a; padding: 2px 8px; border-radius: 4px; font-size: 13px;">${payload.commitHash.substring(0, 7)}</span>
              </div>
            </div>
            ` : ''}
            ${payload.status ? `
            <div style="padding: 16px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="color: #71717a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Status</span>
                <span style="color: ${colors.primary}; font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 0.05em;">${payload.status}</span>
              </div>
            </div>
            ` : ''}
          </div>

          ${payload.message ? `
          <!-- Message -->
          <div style="margin-top: 16px; padding: 16px; background: #0c0c0e; border: 1px solid #27272a; border-left: 3px solid ${colors.primary}; border-radius: 6px;">
            <p style="margin: 0; color: #a1a1aa; font-size: 14px; line-height: 1.6;">${payload.message}</p>
          </div>
          ` : ''}

          ${payload.url ? `
          <!-- CTA Button -->
          <div style="margin-top: 24px; text-align: center;">
            <a href="${payload.url}" style="display: inline-block; background: linear-gradient(135deg, ${colors.primary} 0%, ${colors.primary}cc 100%); color: #0c0c0e; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; letter-spacing: 0.02em; transition: all 0.2s;">
              View Deployment →
            </a>
          </div>
          ` : ''}
        </div>

        <!-- Footer -->
        <div style="padding: 20px 24px; border-top: 1px solid #27272a; background: #0c0c0e;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="color: #22d3ee; font-size: 16px; font-weight: 700;">◈</span>
              <span style="color: #71717a; font-size: 12px;">Pushify</span>
            </div>
            <span style="color: #52525b; font-size: 11px;">Automated deployment notification</span>
          </div>
        </div>
      </div>

      <!-- Bottom Text -->
      <div style="text-align: center; margin-top: 16px;">
        <p style="color: #52525b; font-size: 11px; margin: 0;">
          This email was sent by Pushify. If you didn't expect this, you can ignore it.
        </p>
      </div>
    </body>
    </html>
  `;
}

// Helper functions
function getEventEmoji(event: string): string {
  const emojis: Record<string, string> = {
    'deployment.started': '🚀',
    'deployment.success': '✅',
    'deployment.failed': '❌',
    'health.unhealthy': '🚨',
    'health.recovered': '💚',
    test: '🔔',
  };
  return emojis[event] || '📢';
}

function getEventColor(event: string): string {
  const colors: Record<string, string> = {
    'deployment.started': '#3498db',
    'deployment.success': '#22d3ee',
    'deployment.failed': '#ef4444',
    'health.unhealthy': '#ef4444',
    'health.recovered': '#22c55e',
    test: '#a855f7',
  };
  return colors[event] || '#71717a';
}

function getEventTitle(event: string): string {
  const titles: Record<string, string> = {
    'deployment.started': 'Deployment Started',
    'deployment.success': 'Deployment Successful',
    'deployment.failed': 'Deployment Failed',
    'health.unhealthy': 'Health Check Failed',
    'health.recovered': 'Health Check Recovered',
    test: 'Test Notification',
  };
  return titles[event] || event;
}

// Get status icon for email
function getStatusIcon(event: string): string {
  const icons: Record<string, string> = {
    'deployment.started': '◉',
    'deployment.success': '✓',
    'deployment.failed': '✕',
    'health.unhealthy': '!',
    'health.recovered': '♥',
    test: '◈',
  };
  return icons[event] || '•';
}

// Get event colors for email template
function getEventColors(event: string): { primary: string; bg: string; text: string } {
  const colorMap: Record<string, { primary: string; bg: string; text: string }> = {
    'deployment.started': { primary: '#22d3ee', bg: '#164e63', text: '#cffafe' },
    'deployment.success': { primary: '#22c55e', bg: '#166534', text: '#dcfce7' },
    'deployment.failed': { primary: '#ef4444', bg: '#7f1d1d', text: '#fecaca' },
    'health.unhealthy': { primary: '#ef4444', bg: '#7f1d1d', text: '#fecaca' },
    'health.recovered': { primary: '#22c55e', bg: '#166534', text: '#dcfce7' },
    test: { primary: '#a855f7', bg: '#581c87', text: '#f3e8ff' },
  };
  return colorMap[event] || { primary: '#71717a', bg: '#27272a', text: '#e4e4e7' };
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
