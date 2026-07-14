import { getTemplateById } from './templates';

/** Shape passed to deployToRemoteServer for marketplace apps */
export interface MarketplaceDeployConfig {
  id: string;
  deploymentType?: 'single-container' | 'docker-compose';
  dockerImage?: string;
  dockerCommand?: string;
  composeFile?: string;
  composePublicService?: string;
  composePublicPort?: number;
  extraFiles?: Record<string, string>;
  envPassthrough?: Record<string, string[]>;
  postDeploySql?: string;
  postDeployShell?: string;
  volumes?: string[];
  requiresDatabase?: { type: string; version?: string };
}

/**
 * Always use the latest marketplace template from code — not a frozen copy in project.settings.
 * Fixes redeploys after template fixes (e.g. Cal.com compose / env).
 */
export function buildMarketplaceDeployConfig(
  templateId: string,
  projectSettings?: Record<string, unknown> | null
): MarketplaceDeployConfig | undefined {
  const fresh = getTemplateById(templateId);
  if (!fresh) return undefined;

  const ps = projectSettings ?? {};

  return {
    id: fresh.id,
    deploymentType: fresh.deploymentType || 'single-container',
    dockerImage: fresh.dockerImage,
    dockerCommand: fresh.dockerCommand ?? (ps.dockerCommand as string | undefined),
    composeFile: fresh.composeFile,
    composePublicService: fresh.composePublicService,
    composePublicPort: fresh.composePublicPort,
    extraFiles: fresh.extraFiles ?? (ps.extraFiles as Record<string, string> | undefined),
    envPassthrough: fresh.envPassthrough,
    postDeploySql:
      (fresh as { postDeploySql?: string }).postDeploySql ??
      (ps.postDeploySql as string | undefined),
    postDeployShell:
      (fresh as { postDeployShell?: string }).postDeployShell ??
      (ps.postDeployShell as string | undefined),
    volumes: fresh.volumes ?? (ps.volumes as string[] | undefined),
    requiresDatabase:
      fresh.requiresDatabase ??
      (ps.requiresDatabase as { type: string; version?: string } | undefined),
  };
}
