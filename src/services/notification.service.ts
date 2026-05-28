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
import { renderNotificationEmail } from '../lib/email-templates';
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

      const eventTitle = this.getEventTitle(payload.event);

      const mailOptions = {
        from: `"${env.GMAIL_FROM_NAME}" <${env.GMAIL_USER}>`,
        to: config.emails.join(', '),
        subject: `${this.getEventEmoji(payload.event)} Pushify — ${eventTitle} — ${payload.projectName}`,
        html: renderNotificationEmail(payload),
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
