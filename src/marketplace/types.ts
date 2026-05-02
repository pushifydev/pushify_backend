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

  envVars: MarketplaceEnvVar[];
  minMemoryMb: number;
  minDiskGb: number;
  requiresDatabase?: { type: 'postgresql' | 'mysql' | 'mongodb' | 'redis'; version?: string };
  version: string;
  appVersion: string;
  featured: boolean;
  volumes?: string[];
}
