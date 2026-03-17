// Cloud Provider Interface
// This interface defines the contract for all cloud providers (Hetzner, DigitalOcean, AWS, etc.)

export type ServerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'custom';
export type ServerStatus = 'provisioning' | 'running' | 'stopped' | 'rebooting' | 'error' | 'deleting';

export interface ServerSpecs {
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  priceMonthly: number;
}

export interface ServerConfig {
  name: string;
  region: string;
  size: ServerSize;
  image: string;
  serverType?: string; // Provider-specific server type (e.g., "cx23" for Hetzner)
  sshKeyIds?: string[];
  userData?: string;
  labels?: Record<string, string>;
}

export interface ProviderServer {
  providerId: string;
  name: string;
  status: ServerStatus;
  ipv4: string | null;
  ipv6: string | null;
  privateIp: string | null;
  region: string;
  size: ServerSize;
  image: string;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  createdAt: Date;
  providerData: Record<string, unknown>;
}

export interface Region {
  id: string;
  name: string;
  country: string;
  city: string;
  available: boolean;
}

export interface Image {
  id: string;
  name: string;
  description: string;
  type: 'system' | 'app' | 'snapshot';
  status: string;
}

export interface SSHKey {
  id: string;
  name: string;
  fingerprint: string;
  publicKey: string;
}

export interface Snapshot {
  id: string;
  name: string;
  description?: string;
  sizeGb: number;
  status: string;
  createdAt: Date;
}

export interface FirewallRule {
  direction: 'in' | 'out';
  protocol: 'tcp' | 'udp' | 'icmp';
  port?: string;
  sourceIps: string[];
  description?: string;
}

// Raw server type from provider (e.g., Hetzner cx23, cpx11, etc.)
export interface ProviderServerType {
  id: string;
  name: string;
  description: string;
  cores: number;
  memory: number; // in GB
  disk: number; // in GB
  priceMonthly: number;
  priceHourly: number;
  cpuType: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  availableLocations: string[];
}

export interface ICloudProvider {
  readonly name: string;
  readonly id: string;

  // Server Operations
  createServer(config: ServerConfig): Promise<ProviderServer>;
  deleteServer(providerId: string): Promise<void>;
  getServer(providerId: string): Promise<ProviderServer>;
  listServers(): Promise<ProviderServer[]>;
  powerOn(providerId: string): Promise<void>;
  powerOff(providerId: string): Promise<void>;
  reboot(providerId: string): Promise<void>;
  resize(providerId: string, size: ServerSize): Promise<ProviderServer>;

  // Snapshot Operations
  createSnapshot(providerId: string, name: string, description?: string): Promise<Snapshot>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  listSnapshots(providerId?: string): Promise<Snapshot[]>;
  restoreSnapshot(providerId: string, snapshotId: string): Promise<void>;

  // SSH Key Operations
  uploadSSHKey(name: string, publicKey: string): Promise<SSHKey>;
  deleteSSHKey(keyId: string): Promise<void>;
  listSSHKeys(): Promise<SSHKey[]>;

  // Region & Image Operations
  listRegions(): Promise<Region[]>;
  listImages(): Promise<Image[]>;
  listSizes(): Promise<{ size: ServerSize; specs: ServerSpecs }[]>;
  listServerTypes(location?: string): Promise<ProviderServerType[]>;

  // Validation
  validateCredentials(): Promise<boolean>;
}

// Size mappings for different providers
export const SIZE_MAPPINGS: Record<string, Record<ServerSize, string>> = {
  hetzner: {
    xs: 'cx11',
    sm: 'cx21',
    md: 'cx31',
    lg: 'cx41',
    xl: 'cx51',
    custom: 'custom',
  },
  digitalocean: {
    xs: 's-1vcpu-1gb',
    sm: 's-1vcpu-2gb',
    md: 's-2vcpu-4gb',
    lg: 's-4vcpu-8gb',
    xl: 's-8vcpu-16gb',
    custom: 'custom',
  },
  aws: {
    xs: 't3.micro',
    sm: 't3.small',
    md: 't3.medium',
    lg: 't3.large',
    xl: 't3.xlarge',
    custom: 'custom',
  },
};
