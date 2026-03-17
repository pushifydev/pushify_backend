import { sql } from 'drizzle-orm';
import { db } from '../db';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { execCommand } from '../workers/shell';

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  message?: string;
  responseTime?: number;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version: string;
  uptime: number;
  checks: {
    database: HealthCheckResult;
    redis: HealthCheckResult;
    docker: HealthCheckResult;
  };
}

const startTime = Date.now();

export const healthService = {
  /**
   * Check database connectivity
   */
  async checkDatabase(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // Run a simple query to verify database connection
      await db.execute(sql`SELECT 1`);
      const responseTime = Date.now() - start;

      return {
        status: 'healthy',
        message: 'Database connection successful',
        responseTime,
      };
    } catch (error) {
      logger.error({ error }, 'Database health check failed');
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Database connection failed',
        responseTime: Date.now() - start,
      };
    }
  },

  /**
   * Check Redis connectivity (if configured)
   */
  async checkRedis(): Promise<HealthCheckResult> {
    // Redis is optional - if not configured, return healthy with skip message
    if (!env.REDIS_URL) {
      return {
        status: 'healthy',
        message: 'Redis not configured (optional)',
      };
    }

    const start = Date.now();
    try {
      // For now, just check if the URL is valid
      // In production, you would use a Redis client to ping
      const url = new URL(env.REDIS_URL);
      if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
        throw new Error('Invalid Redis URL protocol');
      }

      return {
        status: 'healthy',
        message: 'Redis URL configured',
        responseTime: Date.now() - start,
      };
    } catch (error) {
      logger.error({ error }, 'Redis health check failed');
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Redis check failed',
        responseTime: Date.now() - start,
      };
    }
  },

  /**
   * Check Docker availability
   */
  async checkDocker(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await execCommand('docker info --format "{{.ServerVersion}}"', {
        timeout: 5000,
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || 'Docker daemon not responding');
      }

      const version = result.stdout.trim();
      return {
        status: 'healthy',
        message: `Docker ${version} available`,
        responseTime: Date.now() - start,
      };
    } catch (error) {
      logger.error({ error }, 'Docker health check failed');
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Docker not available',
        responseTime: Date.now() - start,
      };
    }
  },

  /**
   * Run all health checks
   */
  async getFullStatus(): Promise<HealthStatus> {
    const [database, redis, docker] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkDocker(),
    ]);

    const checks = { database, redis, docker };

    // Determine overall status
    const statuses = Object.values(checks).map((c) => c.status);
    let overallStatus: 'healthy' | 'unhealthy' | 'degraded';

    if (statuses.every((s) => s === 'healthy')) {
      overallStatus = 'healthy';
    } else if (statuses.includes('unhealthy')) {
      // Database is critical, others are degraded
      if (database.status === 'unhealthy') {
        overallStatus = 'unhealthy';
      } else {
        overallStatus = 'degraded';
      }
    } else {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '0.1.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks,
    };
  },

  /**
   * Quick liveness check (just checks if the service is running)
   */
  getLivenessStatus() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'pushify-api',
      version: process.env.npm_package_version || '0.1.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  },

  /**
   * Readiness check (checks if the service is ready to accept traffic)
   */
  async getReadinessStatus() {
    const database = await this.checkDatabase();

    // Service is ready if database is healthy
    const isReady = database.status === 'healthy';

    return {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        database: database.status === 'healthy',
      },
    };
  },
};
