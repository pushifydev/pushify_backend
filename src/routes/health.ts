import { Hono } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';
import { healthService } from '../services/health.service';

export const healthRoutes = new Hono()
  /**
   * Liveness probe - checks if the service is running
   * Used by Kubernetes/Docker for liveness checks
   * Always returns 200 if the service is up
   */
  .get('/', (c) => {
    return c.json(healthService.getLivenessStatus());
  })

  /**
   * Readiness probe - checks if the service is ready to accept traffic
   * Used by Kubernetes/Docker for readiness checks
   * Returns 503 if critical services (database) are not available
   */
  .get('/ready', async (c) => {
    const status = await healthService.getReadinessStatus();
    const httpStatus = status.status === 'ready' ? 200 : 503;
    return c.json(status, httpStatus);
  })

  /**
   * Full health check - detailed status of all dependencies
   * Returns 200 if healthy, 503 if unhealthy, 207 if degraded
   */
  .get('/full', async (c) => {
    const status = await healthService.getFullStatus();

    let httpStatus: StatusCode;
    switch (status.status) {
      case 'healthy':
        httpStatus = 200;
        break;
      case 'degraded':
        httpStatus = 207; // Multi-Status
        break;
      case 'unhealthy':
      default:
        httpStatus = 503;
    }

    return c.json(status, httpStatus);
  })

  /**
   * Individual health checks
   */
  .get('/database', async (c) => {
    const result = await healthService.checkDatabase();
    const httpStatus = result.status === 'healthy' ? 200 : 503;
    return c.json(result, httpStatus);
  })

  .get('/docker', async (c) => {
    const result = await healthService.checkDocker();
    const httpStatus = result.status === 'healthy' ? 200 : 503;
    return c.json(result, httpStatus);
  })

  .get('/redis', async (c) => {
    const result = await healthService.checkRedis();
    const httpStatus = result.status === 'healthy' ? 200 : 503;
    return c.json(result, httpStatus);
  });
