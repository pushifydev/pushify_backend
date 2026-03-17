import { HTTPException } from 'hono/http-exception';
import { healthCheckRepository } from '../repositories/healthcheck.repository';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { notificationService } from './notification.service';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';
import type { HealthCheck, HealthCheckLog } from '../db/schema';

interface HealthCheckInput {
  endpoint?: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  unhealthyThreshold?: number;
  autoRestart?: boolean;
  isActive?: boolean;
}

export const healthCheckService = {
  /**
   * Get health check config for a project
   */
  async getConfig(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<HealthCheck | null> {
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

    const config = await healthCheckRepository.findByProjectId(projectId);
    return config || null;
  },

  /**
   * Create or update health check config
   */
  async upsertConfig(
    projectId: string,
    organizationId: string,
    userId: string,
    input: HealthCheckInput,
    locale: SupportedLocale = 'en'
  ): Promise<HealthCheck> {
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

    // Check if config already exists
    const existing = await healthCheckRepository.findByProjectId(projectId);

    if (existing) {
      const updated = await healthCheckRepository.update(projectId, input);
      if (!updated) {
        throw new HTTPException(500, { message: 'Failed to update health check config' });
      }
      logger.info({ projectId, userId }, 'Health check config updated');
      return updated;
    }

    const config = await healthCheckRepository.create({
      projectId,
      endpoint: input.endpoint || '/health',
      intervalSeconds: input.intervalSeconds || 30,
      timeoutSeconds: input.timeoutSeconds || 10,
      unhealthyThreshold: input.unhealthyThreshold || 3,
      autoRestart: input.autoRestart ?? true,
      isActive: input.isActive ?? true,
    });

    logger.info({ projectId, userId }, 'Health check config created');
    return config;
  },

  /**
   * Delete health check config
   */
  async deleteConfig(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<void> {
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

    await healthCheckRepository.delete(projectId);
    logger.info({ projectId, userId }, 'Health check config deleted');
  },

  /**
   * Get health check logs for a project
   */
  async getLogs(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<HealthCheckLog[]> {
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

    return healthCheckRepository.findLogsByProject(projectId);
  },

  /**
   * Perform health check for a project (called by worker)
   */
  async performHealthCheck(
    projectId: string,
    healthCheckUrl: string,
    timeoutSeconds: number
  ): Promise<{
    healthy: boolean;
    responseTimeMs: number;
    statusCode?: number;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

      const response = await fetch(healthCheckUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Pushify-HealthCheck/1.0',
        },
      });

      clearTimeout(timeout);
      const responseTimeMs = Date.now() - startTime;

      return {
        healthy: response.ok,
        responseTimeMs,
        statusCode: response.status,
      };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('abort')) {
        return {
          healthy: false,
          responseTimeMs,
          error: 'Timeout',
        };
      }

      return {
        healthy: false,
        responseTimeMs,
        error: errorMessage,
      };
    }
  },

  /**
   * Handle unhealthy status (called by worker)
   */
  async handleUnhealthy(
    projectId: string,
    consecutiveFailures: number,
    unhealthyThreshold: number,
    autoRestart: boolean,
    containerName?: string
  ): Promise<'none' | 'restarted' | 'notified'> {
    // Only take action if threshold is reached
    if (consecutiveFailures < unhealthyThreshold) {
      return 'none';
    }

    // Send notification
    await notificationService.sendNotifications(projectId, 'health.unhealthy', {
      status: 'unhealthy',
      message: `Health check failed ${consecutiveFailures} times`,
    });

    // Auto-restart if enabled
    if (autoRestart && containerName) {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        await execAsync(`docker restart ${containerName}`);
        logger.info({ projectId, containerName }, 'Container auto-restarted due to health check failure');
        return 'restarted';
      } catch (error) {
        logger.error({ error, projectId, containerName }, 'Failed to auto-restart container');
      }
    }

    return 'notified';
  },

  /**
   * Handle recovery (called by worker when healthy after being unhealthy)
   */
  async handleRecovery(projectId: string): Promise<void> {
    await notificationService.sendNotifications(projectId, 'health.recovered', {
      status: 'healthy',
      message: 'Health check recovered',
    });
  },
};
