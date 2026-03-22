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
  dockerImage: string;
  dockerCommand?: string;
  port: number;
  healthCheckPath: string;
  envVars: MarketplaceEnvVar[];
  minMemoryMb: number;
  minDiskGb: number;
  requiresDatabase?: { type: 'postgresql' | 'mysql' | 'mongodb' | 'redis'; version?: string };
  version: string;
  appVersion: string;
  featured: boolean;
  volumes?: string[];
}
