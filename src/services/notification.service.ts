import { HTTPException } from 'hono/http-exception';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { notificationRepository } from '../repositories/notification.repository';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { encrypt, decrypt } from '../lib/encryption';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';
import { env } from '../config/env';
import { addNotificationJob, isQueueAvailable } from '../lib/queue';
import type { NotificationChannel } from '../db/schema';

// Gmail SMTP transporter (lazy initialized)
let gmailTransporter: Transporter | null = null;

function getGmailTransporter(): Transporter | null {
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

// Channel config types
interface SlackConfig {
  webhookUrl: string;
}

interface EmailConfig {
  emails: string[];
}

interface WebhookConfig {
  url: string;
  secret?: string;
}

type ChannelConfig = SlackConfig | EmailConfig | WebhookConfig;

// Notification payload
interface NotificationPayload {
  event: string;
  projectId: string;
  projectName: string;
  deploymentId?: string;
  commitHash?: string;
  branch?: string;
  status?: string;
  message?: string;
  url?: string;
}

export const notificationService = {
  /**
   * Get all notification channels for a project
   */
  async getChannels(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify project belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    const channels = await notificationRepository.findChannelsByProject(projectId);

    // Don't return encrypted config, just indicate it exists
    return channels.map((channel) => ({
      id: channel.id,
      projectId: channel.projectId,
      type: channel.type,
      name: channel.name,
      events: channel.events,
      isActive: channel.isActive,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    }));
  },

  /**
   * Create a notification channel
   */
  async createChannel(
    projectId: string,
    organizationId: string,
    userId: string,
    input: {
      type: 'slack' | 'email' | 'webhook';
      name: string;
      config: ChannelConfig;
      events: string[];
    },
    locale: SupportedLocale = 'en'
  ) {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify project belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    // Encrypt the config
    const configEncrypted = encrypt(JSON.stringify(input.config));

    const channel = await notificationRepository.createChannel({
      projectId,
      type: input.type,
      name: input.name,
      configEncrypted,
      events: input.events,
    });

    logger.info({ channelId: channel.id, projectId, userId }, 'Notification channel created');

    return {
      id: channel.id,
      projectId: channel.projectId,
      type: channel.type,
      name: channel.name,
      events: channel.events,
      isActive: channel.isActive,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
  },

  /**
   * Update a notification channel
   */
  async updateChannel(
    channelId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    input: {
      name?: string;
      config?: ChannelConfig;
      events?: string[];
      isActive?: boolean;
    },
    locale: SupportedLocale = 'en'
  ) {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify channel exists and belongs to project
    const channel = await notificationRepository.findChannelById(channelId);
    if (!channel || channel.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'notifications', 'notFound') });
    }

    const updateData: Record<string, unknown> = {};

    if (input.name !== undefined) updateData.name = input.name;
    if (input.events !== undefined) updateData.events = input.events;
    if (input.isActive !== undefined) updateData.isActive = input.isActive;
    if (input.config !== undefined) {
      updateData.configEncrypted = encrypt(JSON.stringify(input.config));
    }

    const updated = await notificationRepository.updateChannel(channelId, updateData);

    logger.info({ channelId, projectId, userId }, 'Notification channel updated');

    return updated ? {
      id: updated.id,
      projectId: updated.projectId,
      type: updated.type,
      name: updated.name,
      events: updated.events,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    } : null;
  },

  /**
   * Delete a notification channel
   */
  async deleteChannel(
    channelId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify channel exists and belongs to project
    const channel = await notificationRepository.findChannelById(channelId);
    if (!channel || channel.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'notifications', 'notFound') });
    }

    await notificationRepository.deleteChannel(channelId);

    logger.info({ channelId, projectId, userId }, 'Notification channel deleted');
  },

  /**
   * Test a notification channel
   */
  async testChannel(
    channelId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify channel exists and belongs to project
    const channel = await notificationRepository.findChannelById(channelId);
    if (!channel || channel.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'notifications', 'notFound') });
    }

    // Get project name
    const project = await projectRepository.findById(projectId);
    if (!project) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    // Send test notification
    const testPayload: NotificationPayload = {
      event: 'test',
      projectId,
      projectName: project.name,
      message: 'This is a test notification from Pushify',
      url: `${env.FRONTEND_URL}/dashboard/projects/${projectId}`,
    };

    const success = await this.sendToChannel(channel, testPayload);

    if (!success) {
      throw new HTTPException(500, { message: t(locale, 'notifications', 'testFailed') });
    }

    logger.info({ channelId, projectId, userId }, 'Test notification sent');
  },

  /**
   * Get notification logs for a channel
   */
  async getChannelLogs(
    channelId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify channel exists and belongs to project
    const channel = await notificationRepository.findChannelById(channelId);
    if (!channel || channel.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'notifications', 'notFound') });
    }

    return notificationRepository.findLogsByChannel(channelId);
  },

  /**
   * Send notifications for an event (called internally by deployment worker, etc.)
   * Uses queue when Redis is available, falls back to synchronous sending
   */
  async sendNotifications(projectId: string, event: string, payload: Omit<NotificationPayload, 'event' | 'projectId' | 'projectName'>) {
    try {
      // Get project name
      const project = await projectRepository.findById(projectId);
      if (!project) {
        logger.warn({ projectId, event }, 'Cannot send notifications: project not found');
        return;
      }

      // Find active channels for this event
      const channels = await notificationRepository.findActiveChannelsForEvent(projectId, event);

      if (channels.length === 0) {
        logger.debug({ projectId, event }, 'No active channels for event');
        return;
      }

      const fullPayload: NotificationPayload = {
        event,
        projectId,
        projectName: project.name,
        ...payload,
      };

      // Check if queue is available
      const useQueue = isQueueAvailable();

      // Send to all channels
      for (const channel of channels) {
        if (useQueue) {
          // Queue the notification for async processing
          const config = JSON.parse(decrypt(channel.configEncrypted));
          await addNotificationJob({
            type: channel.type,
            channelId: channel.id,
            payload: fullPayload,
            config,
          });
          logger.debug(
            { channelId: channel.id, type: channel.type, event },
            'Notification queued'
          );
        } else {
          // Fallback: send synchronously
          const success = await this.sendToChannel(channel, fullPayload);

          // Log the result
          await notificationRepository.createLog({
            channelId: channel.id,
            deploymentId: payload.deploymentId,
            eventType: event,
            status: success ? 'sent' : 'failed',
            errorMessage: success ? null : 'Failed to send notification',
          });
        }
      }
    } catch (error) {
      logger.error({ error, projectId, event }, 'Error sending notifications');
    }
  },

  /**
   * Send notification to a specific channel
   */
  async sendToChannel(channel: NotificationChannel, payload: NotificationPayload): Promise<boolean> {
    try {
      const config = JSON.parse(decrypt(channel.configEncrypted)) as ChannelConfig;

      switch (channel.type) {
        case 'slack':
          return this.sendSlackNotification(config as SlackConfig, payload);
        case 'email':
          return this.sendEmailNotification(config as EmailConfig, payload);
        case 'webhook':
          return this.sendWebhookNotification(config as WebhookConfig, payload);
        default:
          logger.warn({ channelType: channel.type }, 'Unknown channel type');
          return false;
      }
    } catch (error) {
      logger.error({ error, channelId: channel.id, channelType: channel.type }, 'Error sending to channel');
      return false;
    }
  },

  /**
   * Send Slack notification
   */
  async sendSlackNotification(config: SlackConfig, payload: NotificationPayload): Promise<boolean> {
    try {
      const emoji = this.getEventEmoji(payload.event);
      const color = this.getEventColor(payload.event);

      const slackPayload = {
        attachments: [
          {
            color,
            pretext: `${emoji} ${this.getEventTitle(payload.event)}`,
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
    } catch (error) {
      logger.error({ error }, 'Error sending Slack notification');
      return false;
    }
  },

  /**
   * Send Email notification via Gmail SMTP
   */
  async sendEmailNotification(config: EmailConfig, payload: NotificationPayload): Promise<boolean> {
    try {
      const transporter = getGmailTransporter();

      if (!transporter) {
        logger.warn('Gmail SMTP not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD env vars.');
        return false;
      }

      const emoji = this.getEventEmoji(payload.event);
      const eventTitle = this.getEventTitle(payload.event);

      const mailOptions = {
        from: `"${env.GMAIL_FROM_NAME}" <${env.GMAIL_USER}>`,
        to: config.emails.join(', '),
        subject: `${emoji} [Pushify] ${eventTitle} - ${payload.projectName}`,
        html: this.buildEmailHtml(payload),
      };

      await transporter.sendMail(mailOptions);

      logger.info(
        { emails: config.emails, event: payload.event, project: payload.projectName },
        'Email notification sent via Gmail'
      );

      return true;
    } catch (error) {
      logger.error({ error }, 'Error sending email notification via Gmail');
      return false;
    }
  },

  /**
   * Build HTML email template - Pushify Neo-Industrial Dark Theme
   */
  buildEmailHtml(payload: NotificationPayload): string {
    const eventTitle = this.getEventTitle(payload.event);
    const { accent, glow } = this.getEventColors(payload.event);
    const statusIcon = this.getStatusIcon(payload.event);

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${eventTitle}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0c0c0e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0c0c0e; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width: 600px; width: 100%;">

          <!-- Logo Header -->
          <tr>
            <td style="padding: 0 0 30px 0; text-align: center;">
              <div style="display: inline-block; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); -webkit-background-clip: text; background-clip: text;">
                <span style="font-size: 28px; font-weight: 800; color: #22d3ee; letter-spacing: -1px;">PUSHIFY</span>
              </div>
            </td>
          </tr>

          <!-- Main Card -->
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #141418; border-radius: 16px; border: 1px solid #27272a; overflow: hidden;">

                <!-- Status Header -->
                <tr>
                  <td style="padding: 32px 32px 24px 32px; border-bottom: 1px solid #27272a;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td width="56" valign="top">
                          <div style="width: 48px; height: 48px; background: ${accent}15; border-radius: 12px; display: flex; align-items: center; justify-content: center; text-align: center; line-height: 48px;">
                            ${statusIcon}
                          </div>
                        </td>
                        <td style="padding-left: 16px;" valign="middle">
                          <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #f4f4f5; letter-spacing: -0.5px;">
                            ${eventTitle}
                          </h1>
                          <p style="margin: 4px 0 0 0; font-size: 14px; color: #71717a;">
                            ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Details Section -->
                <tr>
                  <td style="padding: 24px 32px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">

                      <!-- Project -->
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #1a1a1f;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr>
                              <td style="font-size: 13px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">Project</td>
                              <td style="text-align: right; font-size: 15px; color: #f4f4f5; font-weight: 600;">${payload.projectName}</td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      ${payload.branch ? `
                      <!-- Branch -->
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #1a1a1f;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr>
                              <td style="font-size: 13px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">Branch</td>
                              <td style="text-align: right;">
                                <span style="display: inline-block; background: #222228; padding: 4px 10px; border-radius: 6px; font-size: 13px; color: #22d3ee; font-family: 'JetBrains Mono', monospace;">${payload.branch}</span>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      ` : ''}

                      ${payload.commitHash ? `
                      <!-- Commit -->
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #1a1a1f;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr>
                              <td style="font-size: 13px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">Commit</td>
                              <td style="text-align: right;">
                                <code style="display: inline-block; background: #222228; padding: 4px 10px; border-radius: 6px; font-size: 13px; color: #a1a1aa; font-family: 'JetBrains Mono', monospace;">${payload.commitHash.substring(0, 7)}</code>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      ` : ''}

                      ${payload.status ? `
                      <!-- Status -->
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #1a1a1f;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr>
                              <td style="font-size: 13px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">Status</td>
                              <td style="text-align: right;">
                                <span style="display: inline-block; background: ${accent}20; color: ${accent}; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase;">${payload.status}</span>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      ` : ''}

                    </table>
                  </td>
                </tr>

                ${payload.message ? `
                <!-- Message Box -->
                <tr>
                  <td style="padding: 0 32px 24px 32px;">
                    <div style="background: #1a1a1f; border-left: 3px solid ${accent}; padding: 16px 20px; border-radius: 0 8px 8px 0;">
                      <p style="margin: 0; font-size: 14px; color: #a1a1aa; line-height: 1.6;">${payload.message}</p>
                    </div>
                  </td>
                </tr>
                ` : ''}

                ${payload.url ? `
                <!-- CTA Button -->
                <tr>
                  <td style="padding: 8px 32px 32px 32px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td align="center">
                          <a href="${payload.url}" style="display: inline-block; background: linear-gradient(135deg, ${accent} 0%, ${accent}cc 100%); color: #0c0c0e; padding: 14px 32px; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; box-shadow: 0 4px 14px ${accent}40;">
                            View Details
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ` : ''}

              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 32px 0; text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 12px; color: #52525b;">
                Sent by <span style="color: #22d3ee; font-weight: 600;">Pushify</span> - Open Source Deployment Platform
              </p>
              <p style="margin: 0; font-size: 11px; color: #3f3f46;">
                You received this email because you enabled notifications for this project.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;
  },

  /**
   * Get accent colors for event type - Pushify theme
   */
  getEventColors(event: string): { accent: string; glow: string } {
    const colors: Record<string, { accent: string; glow: string }> = {
      'deployment.started': { accent: '#3b82f6', glow: 'rgba(59, 130, 246, 0.3)' },
      'deployment.success': { accent: '#22c55e', glow: 'rgba(34, 197, 94, 0.3)' },
      'deployment.failed': { accent: '#ef4444', glow: 'rgba(239, 68, 68, 0.3)' },
      'health.unhealthy': { accent: '#ef4444', glow: 'rgba(239, 68, 68, 0.3)' },
      'health.recovered': { accent: '#22c55e', glow: 'rgba(34, 197, 94, 0.3)' },
      test: { accent: '#a78bfa', glow: 'rgba(167, 139, 250, 0.3)' },
    };
    return colors[event] || { accent: '#22d3ee', glow: 'rgba(34, 211, 238, 0.3)' };
  },

  /**
   * Get status icon SVG for email
   */
  getStatusIcon(event: string): string {
    const icons: Record<string, string> = {
      'deployment.started': '<span style="font-size: 24px;">&#128640;</span>',
      'deployment.success': '<span style="font-size: 24px;">&#9989;</span>',
      'deployment.failed': '<span style="font-size: 24px;">&#10060;</span>',
      'health.unhealthy': '<span style="font-size: 24px;">&#128680;</span>',
      'health.recovered': '<span style="font-size: 24px;">&#128154;</span>',
      test: '<span style="font-size: 24px;">&#128276;</span>',
    };
    return icons[event] || '<span style="font-size: 24px;">&#128227;</span>';
  },

  /**
   * Send Webhook notification
   */
  async sendWebhookNotification(config: WebhookConfig, payload: NotificationPayload): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Pushify-Webhook/1.0',
      };

      // Add signature if secret is configured
      if (config.secret) {
        const crypto = await import('crypto');
        const signature = crypto
          .createHmac('sha256', config.secret)
          .update(JSON.stringify(payload))
          .digest('hex');
        headers['X-Pushify-Signature'] = `sha256=${signature}`;
      }

      const response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event: payload.event,
          timestamp: new Date().toISOString(),
          data: payload,
        }),
      });

      return response.ok;
    } catch (error) {
      logger.error({ error }, 'Error sending webhook notification');
      return false;
    }
  },

  // Helper methods
  getEventEmoji(event: string): string {
    const emojis: Record<string, string> = {
      'deployment.started': '🚀',
      'deployment.success': '✅',
      'deployment.failed': '❌',
      'health.unhealthy': '🚨',
      'health.recovered': '💚',
      test: '🔔',
    };
    return emojis[event] || '📢';
  },

  getEventColor(event: string): string {
    const colors: Record<string, string> = {
      'deployment.started': '#3498db',
      'deployment.success': '#2ecc71',
      'deployment.failed': '#e74c3c',
      'health.unhealthy': '#e74c3c',
      'health.recovered': '#2ecc71',
      test: '#9b59b6',
    };
    return colors[event] || '#95a5a6';
  },

  getEventTitle(event: string): string {
    const titles: Record<string, string> = {
      'deployment.started': 'Deployment Started',
      'deployment.success': 'Deployment Successful',
      'deployment.failed': 'Deployment Failed',
      'health.unhealthy': 'Health Check Failed',
      'health.recovered': 'Health Check Recovered',
      test: 'Test Notification',
    };
    return titles[event] || event;
  },
};
