export type MarketplaceCategory = 'cms' | 'automation' | 'monitoring' | 'storage' | 'devtools' | 'analytics' | 'database';

export interface MarketplaceEnvVar {
  key: string;
  label: string;
  description: string;
  required: boolean;
  default?: string;
  type: 'text' | 'password' | 'number' | 'url' | 'email';
  generate?: 'password' | 'secret';
  hidden?: boolean;
}

export type DeploymentType = 'single-container' | 'docker-compose';

export interface MarketplaceTemplate {
  id: string;
  name: string;
  description: string;
  longDescription: string;
  icon: string;
  category: MarketplaceCategory;
  tags: string[];
  website: string;
  documentation: string;

  /** Deployment mechanism — defaults to single-container */
  deploymentType?: DeploymentType;

  /** For single-container apps */
  dockerImage?: string;
  dockerCommand?: string;
  port: number;
  healthCheckPath: string;

  /** For docker-compose apps — full compose YAML as string */
  composeFile?: string;
  /** Service in compose to map to public port */
  composePublicService?: string;
  /** Internal port the public service listens on */
  composePublicPort?: number;
  /** Extra files to upload alongside docker-compose.yml (e.g. kong.yml). Path is relative to project dir */
  extraFiles?: Record<string, string>;
  /**
   * Forward user env vars to compose services by key prefix (service name → prefixes).
   * Compose only injects vars listed under a service's `environment:` — a bare .env
   * entry never reaches a container, so e.g. GOTRUE_* tweaks need this passthrough.
   */
  envPassthrough?: Record<string, string[]>;
  /** SQL to run on the db container AFTER docker compose up. Uses ${VAR} substitution. Useful for fixing role passwords on images that override them. */
  postDeploySql?: string;
  /** Shell command(s) to run AFTER container/stack is up. For single-container apps, runs inside the main container. For compose, runs on the docker host. Uses ${VAR} substitution. */
  postDeployShell?: string;

  envVars: MarketplaceEnvVar[];
  minMemoryMb: number;
  minDiskGb: number;
  requiresDatabase?: { type: 'postgresql' | 'mysql' | 'mongodb' | 'redis'; version?: string };
  version: string;
  appVersion: string;
  featured: boolean;
  volumes?: string[];
}
