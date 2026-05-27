import { eq, and, desc, gte } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import {
  notificationChannels,
  notificationLogs,
  type NotificationChannel,
  type NewNotificationChannel,
  type NotificationLog,
  type NewNotificationLog,
} from '../db/schema';

export const notificationRepository = {
  // ============ Channels ============

  async findChannelsByOrganization(organizationId: string) {
    return db
      .select({
        id: notificationChannels.id,
        projectId: notificationChannels.projectId,
        projectName: projects.name,
        projectSlug: projects.slug,
        type: notificationChannels.type,
        name: notificationChannels.name,
        events: notificationChannels.events,
        isActive: notificationChannels.isActive,
        createdAt: notificationChannels.createdAt,
        updatedAt: notificationChannels.updatedAt,
      })
      .from(notificationChannels)
      .innerJoin(projects, eq(notificationChannels.projectId, projects.id))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          eq(projects.status, 'active')
        )
      )
      .orderBy(desc(notificationChannels.updatedAt));
  },

  async findRecentLogsByOrganization(organizationId: string, limit = 30) {
    return db
      .select({
        id: notificationLogs.id,
        channelId: notificationLogs.channelId,
        channelName: notificationChannels.name,
        channelType: notificationChannels.type,
        projectId: projects.id,
        projectName: projects.name,
        eventType: notificationLogs.eventType,
        status: notificationLogs.status,
        errorMessage: notificationLogs.errorMessage,
        sentAt: notificationLogs.sentAt,
      })
      .from(notificationLogs)
      .innerJoin(notificationChannels, eq(notificationLogs.channelId, notificationChannels.id))
      .innerJoin(projects, eq(notificationChannels.projectId, projects.id))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(desc(notificationLogs.sentAt))
      .limit(limit);
  },

  async countFailedLogsSince(organizationId: string, since: Date): Promise<number> {
    const rows = await db
      .select({ id: notificationLogs.id })
      .from(notificationLogs)
      .innerJoin(notificationChannels, eq(notificationLogs.channelId, notificationChannels.id))
      .innerJoin(projects, eq(notificationChannels.projectId, projects.id))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          eq(notificationLogs.status, 'failed'),
          gte(notificationLogs.sentAt, since)
        )
      );
    return rows.length;
  },

  // Find all channels for a project
  async findChannelsByProject(projectId: string): Promise<NotificationChannel[]> {
    return db.query.notificationChannels.findMany({
      where: eq(notificationChannels.projectId, projectId),
      orderBy: [desc(notificationChannels.createdAt)],
    });
  },

  // Find active channels for a project that listen to a specific event
  async findActiveChannelsForEvent(projectId: string, event: string): Promise<NotificationChannel[]> {
    const channels = await db.query.notificationChannels.findMany({
      where: and(
        eq(notificationChannels.projectId, projectId),
        eq(notificationChannels.isActive, true)
      ),
    });

    // Filter channels that have this event in their events array
    return channels.filter((channel) => channel.events.includes(event));
  },

  // Find channel by ID
  async findChannelById(id: string): Promise<NotificationChannel | undefined> {
    return db.query.notificationChannels.findFirst({
      where: eq(notificationChannels.id, id),
    });
  },

  // Create channel
  async createChannel(data: NewNotificationChannel): Promise<NotificationChannel> {
    const [channel] = await db
      .insert(notificationChannels)
      .values(data)
      .returning();

    return channel;
  },

  // Update channel
  async updateChannel(
    id: string,
    data: Partial<Omit<NewNotificationChannel, 'id' | 'projectId'>>
  ): Promise<NotificationChannel | undefined> {
    const [channel] = await db
      .update(notificationChannels)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(notificationChannels.id, id))
      .returning();

    return channel;
  },

  // Delete channel
  async deleteChannel(id: string): Promise<void> {
    await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
  },

  // ============ Logs ============

  // Find logs by channel
  async findLogsByChannel(channelId: string, limit = 50): Promise<NotificationLog[]> {
    return db.query.notificationLogs.findMany({
      where: eq(notificationLogs.channelId, channelId),
      orderBy: [desc(notificationLogs.sentAt)],
      limit,
    });
  },

  // Find logs by deployment
  async findLogsByDeployment(deploymentId: string): Promise<NotificationLog[]> {
    return db.query.notificationLogs.findMany({
      where: eq(notificationLogs.deploymentId, deploymentId),
      orderBy: [desc(notificationLogs.sentAt)],
    });
  },

  // Create log
  async createLog(data: NewNotificationLog): Promise<NotificationLog> {
    const [log] = await db
      .insert(notificationLogs)
      .values(data)
      .returning();

    return log;
  },
};
