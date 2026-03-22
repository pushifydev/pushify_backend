import type { OpenAPIHono } from '@hono/zod-openapi';
import { healthRoutes } from './health';
import { authRoutes } from './auth';
import { projectRoutes } from './projects';
import { envVarRoutes } from './envvars';
import { domainRoutes } from './domains';
import { deploymentRoutes } from './deployments';
import { githubRoutes } from './github';
import { webhookRoutes } from './webhooks';
import { notificationRoutes } from './notifications';
import { healthCheckRoutes } from './healthchecks';
import { previewRoutes } from './previews';
import { metricsRoutes } from './metrics';
import { apiKeyRoutes } from './apikeys';
import { activityRoutes } from './activity';
import { twoFactorRoutes } from './twoFactor';
import { organizationRoutes } from './organizations';
import { billingRoutes } from './billing';
import { serverRoutes } from './servers';
import { databaseRoutes } from './databases';
import { aiRoutes } from './ai';
import { cliAuthRoutes } from './cli-auth';
import { marketplaceRoutes } from './marketplace';

export function registerRoutes(app: OpenAPIHono<any>) {
  // API v1 routes
  app.route('/api/v1/health', healthRoutes);
  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1/auth/2fa', twoFactorRoutes);
  app.route('/api/v1/api-keys', apiKeyRoutes);
  // Sub-routers with specific paths must be registered BEFORE the generic
  // project router, otherwise /{projectId} catches /overview, etc.
  app.route('/api/v1/projects', metricsRoutes);
  app.route('/api/v1/projects', notificationRoutes);
  app.route('/api/v1/projects', healthCheckRoutes);
  app.route('/api/v1/projects', previewRoutes);
  app.route('/api/v1/projects', projectRoutes);
  app.route('/api/v1/projects/:projectId/env', envVarRoutes);
  app.route('/api/v1/projects/:projectId/domains', domainRoutes);
  app.route('/api/v1/projects/:projectId/deployments', deploymentRoutes);
  app.route('/api/v1/activity', activityRoutes);
  app.route('/api/v1/organizations', organizationRoutes);
  app.route('/api/v1/billing', billingRoutes);
  app.route('/api/v1/servers', serverRoutes);
  app.route('/api/v1/databases', databaseRoutes);
  app.route('/api/v1/integrations/github', githubRoutes);

  app.route('/api/v1/ai', aiRoutes);
  app.route('/api/v1/auth/cli', cliAuthRoutes);
  app.route('/api/v1/marketplace', marketplaceRoutes);

  // Webhook routes (no auth required - verified by signature)
  app.route('/api/v1/webhooks', webhookRoutes);
}
