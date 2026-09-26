import type {
  ICloudProvider,
  ServerConfig,
  ProviderServer,
  ServerSize,
  ServerStatus,
  ServerSpecs,
  Region,
  Image,
  SSHKey,
  Snapshot,
  ProviderServerType,
} from './cloud-provider.interface';

const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';

// Hetzner API Response Types
interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net: {
    ipv4: { ip: string } | null;
    ipv6: { ip: string } | null;
  };
  private_net: Array<{ ip: string }>;
  server_type: {
    id: number;
    name: string;
    description: string;
    cores: number;
    memory: number;
    disk: number;
    deprecated: boolean;
    prices: Array<{
      location: string;
      price_hourly: { gross: string };
      price_monthly: { gross: string };
    }>;
    storage_type: string;
    cpu_type: string;
    architecture: string;
  };
  datacenter: {
    id: number;
    name: string;
    description: string;
    location: {
      id: number;
      name: string;
      description: string;
      country: string;
      city: string;
      latitude: number;
      longitude: number;
      network_zone: string;
    };
  };
  image: {
    id: number;
    name: string;
    description: string;
    type: string;
    os_flavor: string;
    os_version: string;
    architecture: string;
  } | null;
  created: string;
  labels: Record<string, string>;
  volumes: number[];
  load_balancers: number[];
  outgoing_traffic: number | null;
  ingoing_traffic: number | null;
  included_traffic: number;
  protection: { delete: boolean; rebuild: boolean };
}

interface HetznerLocation {
  id: number;
  name: string;
  description: string;
  country: string;
  city: string;
  latitude: number;
  longitude: number;
  network_zone: string;
}

interface HetznerImage {
  id: number;
  name: string;
  description: string;
  type: string;
  status: string;
  os_flavor: string;
  os_version: string;
  architecture: string;
  disk_size: number;
  rapid_deploy: boolean;
}

interface HetznerSSHKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
  created: string;
  labels: Record<string, string>;
}

interface HetznerSnapshot {
  id: number;
  description: string;
  image_size: number;
  disk_size: number;
  created: string;
  status: string;
  type: string;
  os_flavor: string;
}

interface HetznerAction {
  id: number;
  status: string;
  progress: number;
  command: string;
}

interface HetznerServerType {
  id: number;
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  deprecated: boolean;
  prices: Array<{
    location: string;
    price_hourly: { gross: string; net: string };
    price_monthly: { gross: string; net: string };
  }>;
  storage_type: string;
  cpu_type: string;
  architecture: string;
}

// Dynamically determine size tier based on specs
function getServerSizeTier(cores: number, memoryGb: number): ServerSize {
  if (cores <= 2 && memoryGb <= 4) return 'xs';
  if (cores <= 2 && memoryGb <= 8) return 'sm';
  if (cores <= 4 && memoryGb <= 16) return 'md';
  if (cores <= 8 && memoryGb <= 32) return 'lg';
  if (cores <= 16 && memoryGb <= 64) return 'xl';
  return 'custom';
}

interface HetznerDatacenter {
  name: string;
  location: { name: string };
  server_types: { available: number[]; supported: number[] };
}

/**
 * Size tiers, in vCPU and GB of memory. One definition for listing, quoting, creating and
 * resizing — if they disagree, the server a customer is billed for is not the one that runs.
 */
const TIER_SPECS: Record<Exclude<ServerSize, 'custom'>, { minCores: number; minMem: number; maxCores: number; maxMem: number }> = {
  xs: { minCores: 1, minMem: 2, maxCores: 2, maxMem: 4 },
  sm: { minCores: 2, minMem: 4, maxCores: 2, maxMem: 8 },
  md: { minCores: 4, minMem: 8, maxCores: 4, maxMem: 16 },
  lg: { minCores: 8, minMem: 16, maxCores: 8, maxMem: 32 },
  xl: { minCores: 16, minMem: 32, maxCores: 32, maxMem: 128 },
};
const TIERS = Object.keys(TIER_SPECS) as Exclude<ServerSize, 'custom'>[];

export interface Catalogue {
  types: HetznerServerType[];
  /** location name → names of server types Hetzner can actually provision there right now */
  inStock: Map<string, Set<string>>;
}

/** Hetzner's catalogue changes rarely; one fetch serves every size/quote/create for a few minutes. */
const CATALOGUE_TTL_MS = 5 * 60 * 1000;
const catalogueCache = new Map<string, { at: number; value: Catalogue }>();

interface ResolvedType {
  type: HetznerServerType;
  location: string;
  priceMonthly: number;
  priceHourly: number;
}

function priceIn(t: HetznerServerType, location: string) {
  const p = t.prices.find((x) => x.location === location);
  return p
    ? { monthly: parseFloat(p.price_monthly.gross), hourly: parseFloat(p.price_hourly.gross) }
    : null;
}

/**
 * The cheapest shared-CPU type for a tier that is in stock — in `location` if given, otherwise
 * in whichever location is cheapest. Hetzner lists prices for types it has sold out of, so
 * availability comes from /datacenters, not /server_types.
 */
export function resolveTier(
  cat: Catalogue,
  size: ServerSize,
  location?: string,
  architecture: string = 'x86',
): ResolvedType | undefined {
  const spec = TIER_SPECS[size as Exclude<ServerSize, 'custom'>] ?? TIER_SPECS.sm;
  const locations = location ? [location] : [...cat.inStock.keys()];
  let best: ResolvedType | undefined;
  for (const t of cat.types) {
    if (t.deprecated || t.cpu_type !== 'shared' || t.architecture !== architecture) continue;
    if (t.cores < spec.minCores || t.memory < spec.minMem) continue;
    if (t.cores > spec.maxCores || t.memory > spec.maxMem) continue;
    for (const loc of locations) {
      if (!cat.inStock.get(loc)?.has(t.name)) continue;
      const price = priceIn(t, loc);
      if (!price) continue;
      if (!best || price.monthly < best.priceMonthly) {
        best = { type: t, location: loc, priceMonthly: price.monthly, priceHourly: price.hourly };
      }
    }
  }
  return best;
}

export class HetznerProvider implements ICloudProvider {
  readonly name = 'Hetzner Cloud';
  readonly id = 'hetzner';
  private apiToken: string;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

  private async catalogue(): Promise<Catalogue> {
    const hit = catalogueCache.get(this.apiToken);
    if (hit && Date.now() - hit.at < CATALOGUE_TTL_MS) return hit.value;

    const [typesRes, dcRes] = await Promise.all([
      this.request<{ server_types: HetznerServerType[] }>('/server_types?per_page=50'),
      this.request<{ datacenters: HetznerDatacenter[] }>('/datacenters?per_page=50'),
    ]);
    const byId = new Map(typesRes.server_types.map((t) => [t.id, t.name]));
    const inStock = new Map<string, Set<string>>();
    for (const dc of dcRes.datacenters) {
      const set = inStock.get(dc.location.name) ?? new Set<string>();
      for (const id of dc.server_types.available) {
        const name = byId.get(id);
        if (name) set.add(name);
      }
      inStock.set(dc.location.name, set);
    }
    const value = { types: typesRes.server_types, inStock };
    catalogueCache.set(this.apiToken, { at: Date.now(), value });
    return value;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${HETZNER_API_URL}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        `Hetzner API error: ${response.status} - ${error.error?.message || response.statusText}`
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }

  private mapStatus(hetznerStatus: string): ServerStatus {
    const statusMap: Record<string, ServerStatus> = {
      initializing: 'provisioning',
      starting: 'provisioning',
      running: 'running',
      stopping: 'stopped',
      off: 'stopped',
      deleting: 'deleting',
      migrating: 'rebooting',
      rebuilding: 'rebooting',
      unknown: 'error',
    };
    return statusMap[hetznerStatus] || 'error';
  }

  private mapServer(server: HetznerServer): ProviderServer {
    return {
      providerId: server.id.toString(),
      name: server.name,
      status: this.mapStatus(server.status),
      ipv4: server.public_net.ipv4?.ip || null,
      ipv6: server.public_net.ipv6?.ip || null,
      privateIp: server.private_net[0]?.ip || null,
      region: server.datacenter.location.name,
      size: getServerSizeTier(server.server_type.cores, server.server_type.memory),
      image: server.image?.name || 'unknown',
      vcpus: server.server_type.cores,
      memoryMb: server.server_type.memory * 1024,
      diskGb: server.server_type.disk,
      createdAt: new Date(server.created),
      providerData: {
        hetznerServerId: server.id,
        datacenter: server.datacenter.name,
        datacenterDescription: server.datacenter.description,
        location: server.datacenter.location,
        serverType: {
          id: server.server_type.id,
          name: server.server_type.name,
          description: server.server_type.description,
          cpuType: server.server_type.cpu_type,
          architecture: server.server_type.architecture,
          storageType: server.server_type.storage_type,
        },
        image: server.image ? {
          id: server.image.id,
          name: server.image.name,
          description: server.image.description,
          osFamily: server.image.os_flavor,
          osVersion: server.image.os_version,
          architecture: server.image.architecture,
        } : null,
        traffic: {
          outgoing: server.outgoing_traffic,
          ingoing: server.ingoing_traffic,
          included: server.included_traffic,
        },
        volumes: server.volumes,
        loadBalancers: server.load_balancers,
        labels: server.labels,
        protection: server.protection,
      },
    };
  }

  async createServer(config: ServerConfig): Promise<ProviderServer> {
    // If serverType is provided, use it directly; otherwise find one based on size
    let serverTypeName = config.serverType;

    if (!serverTypeName) {
      // Get image info to determine architecture
      let imageArchitecture = 'x86'; // Default to x86

      // Try to get the image to determine its architecture
      try {
        const imageId = /^\d+$/.test(config.image) ? config.image : null;
        if (imageId) {
          const imageResponse = await this.request<{ image: HetznerImage }>(`/images/${imageId}`);
          imageArchitecture = imageResponse.image.architecture;
        } else {
          // For image names like "ubuntu-22.04", get all images and find by name
          const imagesResponse = await this.request<{ images: HetznerImage[] }>('/images?type=system&status=available');
          const image = imagesResponse.images.find(img => img.name === config.image);
          if (image) {
            imageArchitecture = image.architecture;
          }
        }
      } catch {
        // If we can't get image info, default to x86
        imageArchitecture = 'x86';
      }

      const resolved = resolveTier(await this.catalogue(), config.size, config.region, imageArchitecture);
      if (!resolved) {
        throw new Error(`No server type in stock for size "${config.size}" in location "${config.region}" with architecture "${imageArchitecture}"`);
      }
      const serverType = resolved.type;

      serverTypeName = serverType.name;
    }

    // Build request body according to Hetzner API spec
    const body: Record<string, unknown> = {
      name: config.name,
      server_type: serverTypeName,
      location: config.region,
      image: /^\d+$/.test(config.image)
        ? parseInt(config.image, 10)
        : config.image,
      start_after_create: true,
    };

    if (config.sshKeyIds?.length) {
      body.ssh_keys = config.sshKeyIds.map((id) =>
        /^\d+$/.test(id) ? parseInt(id, 10) : id
      );
    }

    if (config.userData) {
      body.user_data = config.userData;
    }

    if (config.labels) {
      body.labels = config.labels;
    }

    const response = await this.request<{ server: HetznerServer; action: unknown }>('/servers', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return this.mapServer(response.server);
  }

  async deleteServer(providerId: string): Promise<void> {
    await this.request(`/servers/${providerId}`, {
      method: 'DELETE',
    });
  }

  async getServer(providerId: string): Promise<ProviderServer> {
    const response = await this.request<{ server: HetznerServer }>(
      `/servers/${providerId}`
    );
    return this.mapServer(response.server);
  }

  async listServers(): Promise<ProviderServer[]> {
    const response = await this.request<{ servers: HetznerServer[] }>('/servers');
    return response.servers.map((s) => this.mapServer(s));
  }

  async powerOn(providerId: string): Promise<void> {
    await this.request(`/servers/${providerId}/actions/poweron`, {
      method: 'POST',
    });
  }

  async powerOff(providerId: string): Promise<void> {
    await this.request(`/servers/${providerId}/actions/poweroff`, {
      method: 'POST',
    });
  }

  async reboot(providerId: string): Promise<void> {
    await this.request(`/servers/${providerId}/actions/reboot`, {
      method: 'POST',
    });
  }

  async resize(providerId: string, size: ServerSize): Promise<ProviderServer> {
    // Get current server to find its location and architecture
    const currentServer = await this.getServer(providerId);
    const currentArchitecture = (currentServer.providerData as { serverType?: { architecture?: string } })?.serverType?.architecture || 'x86';

    const serverType = resolveTier(await this.catalogue(), size, currentServer.region, currentArchitecture)?.type;

    if (!serverType) {
      throw new Error(`No server type available for size "${size}" in location "${currentServer.region}" with architecture "${currentArchitecture}"`);
    }

    await this.request(`/servers/${providerId}/actions/change_type`, {
      method: 'POST',
      body: JSON.stringify({
        server_type: serverType.name,
        upgrade_disk: true,
      }),
    });

    return this.getServer(providerId);
  }

  async createSnapshot(
    providerId: string,
    name: string,
    description?: string
  ): Promise<Snapshot> {
    const response = await this.request<{ image: HetznerSnapshot; action: unknown }>(
      `/servers/${providerId}/actions/create_image`,
      {
        method: 'POST',
        body: JSON.stringify({
          description: description || name,
          type: 'snapshot',
        }),
      }
    );

    const action = response.action as HetznerAction | undefined;

    return {
      id: response.image.id.toString(),
      name,
      description: response.image.description,
      sizeGb: Math.ceil(response.image.image_size || response.image.disk_size),
      status: response.image.status,
      progress: action?.progress ?? null,
      createdAt: new Date(response.image.created),
    };
  }

  private async getSnapshotProgress(imageId: string): Promise<number | null> {
    try {
      const response = await this.request<{ actions: HetznerAction[] }>(
        `/images/${imageId}/actions?status=running`
      );
      const action =
        response.actions.find((a) => a.command === 'create_image') ?? response.actions[0];
      return action?.progress ?? null;
    } catch {
      return null;
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.request(`/images/${snapshotId}`, {
      method: 'DELETE',
    });
  }

  async listSnapshots(providerId?: string): Promise<Snapshot[]> {
    const endpoint = providerId
      ? `/images?type=snapshot&bound_to=${providerId}`
      : '/images?type=snapshot';

    const response = await this.request<{ images: HetznerSnapshot[] }>(endpoint);

    const snapshots = await Promise.all(
      response.images.map(async (snap) => {
        const progress =
          snap.status === 'creating' ? await this.getSnapshotProgress(snap.id.toString()) : null;

        return {
          id: snap.id.toString(),
          name: snap.description || `Snapshot ${snap.id}`,
          description: snap.description,
          sizeGb: Math.ceil(snap.image_size || snap.disk_size),
          status: snap.status,
          progress,
          createdAt: new Date(snap.created),
        };
      })
    );

    return snapshots;
  }

  async restoreSnapshot(providerId: string, snapshotId: string): Promise<void> {
    await this.request(`/servers/${providerId}/actions/rebuild`, {
      method: 'POST',
      body: JSON.stringify({
        image: parseInt(snapshotId, 10),
      }),
    });
  }

  async uploadSSHKey(name: string, publicKey: string): Promise<SSHKey> {
    const response = await this.request<{ ssh_key: HetznerSSHKey }>('/ssh_keys', {
      method: 'POST',
      body: JSON.stringify({
        name,
        public_key: publicKey,
      }),
    });

    return {
      id: response.ssh_key.id.toString(),
      name: response.ssh_key.name,
      fingerprint: response.ssh_key.fingerprint,
      publicKey: response.ssh_key.public_key,
    };
  }

  async deleteSSHKey(keyId: string): Promise<void> {
    await this.request(`/ssh_keys/${keyId}`, {
      method: 'DELETE',
    });
  }

  async listSSHKeys(): Promise<SSHKey[]> {
    const response = await this.request<{ ssh_keys: HetznerSSHKey[] }>('/ssh_keys');

    return response.ssh_keys.map((key) => ({
      id: key.id.toString(),
      name: key.name,
      fingerprint: key.fingerprint,
      publicKey: key.public_key,
    }));
  }

  async listRegions(): Promise<Region[]> {
    const response = await this.request<{ locations: HetznerLocation[] }>(
      '/locations'
    );

    const cat = await this.catalogue();
    return response.locations.map((loc) => ({
      id: loc.name,
      name: `${loc.city} (${loc.name})`,
      country: loc.country,
      city: loc.city,
      // Only where at least one managed size can be provisioned right now.
      available: TIERS.some((size) => resolveTier(cat, size, loc.name) !== undefined),
    }));
  }

  async listImages(): Promise<Image[]> {
    const response = await this.request<{ images: HetznerImage[] }>(
      '/images?type=system&status=available&architecture=x86&per_page=50'
    );

    // Every system image exists once per architecture. Managed sizes are x86, so offer the x86
    // build only — listing both showed each OS twice with nothing to tell them apart.
    const seen = new Set<string>();
    return response.images
      .filter((img) => img.architecture === 'x86' && !seen.has(img.name) && seen.add(img.name))
      .map((img) => ({
        id: img.id.toString(),
        name: img.name,
        description: img.description,
        type: img.type === 'snapshot' ? 'snapshot' : 'system',
        status: img.status,
        architecture: 'x86' as const,
      }));
  }

  async listSizes(location?: string): Promise<{ size: ServerSize; specs: ServerSpecs }[]> {
    const cat = await this.catalogue();
    const sizes: { size: ServerSize; specs: ServerSpecs }[] = [];
    const used = new Set<string>();

    for (const size of TIERS) {
      const resolved = resolveTier(cat, size, location);
      // Two tiers can land on the same type (e.g. cx23 is both the smallest 2 GB+ and the
      // smallest 4 GB box); list it once, under the smaller tier.
      if (!resolved || used.has(resolved.type.name)) continue;
      used.add(resolved.type.name);
      sizes.push({
        size,
        specs: {
          vcpus: resolved.type.cores,
          memoryMb: resolved.type.memory * 1024,
          diskGb: resolved.type.disk,
          priceMonthly: resolved.priceMonthly,
          serverType: resolved.type.name,
        },
      });
    }

    return sizes;
  }

  async listServerTypes(location?: string): Promise<ProviderServerType[]> {
    const response = await this.request<{ server_types: HetznerServerType[] }>(
      '/server_types'
    );

    return response.server_types
      .filter(t => {
        // Skip deprecated types
        if (t.deprecated) return false;

        // If location specified, filter by availability
        if (location) {
          return t.prices.some(p => p.location === location);
        }

        return true;
      })
      .map(t => {
        // Get price for the specified location or first available
        const priceEntry = location
          ? t.prices.find(p => p.location === location)
          : t.prices[0];

        return {
          id: t.id.toString(),
          name: t.name,
          description: t.description,
          cores: t.cores,
          memory: t.memory,
          disk: t.disk,
          priceMonthly: parseFloat(priceEntry?.price_monthly?.gross || '0'),
          priceHourly: parseFloat(priceEntry?.price_hourly?.gross || '0'),
          cpuType: t.cpu_type as 'shared' | 'dedicated',
          architecture: t.architecture as 'x86' | 'arm',
          availableLocations: t.prices.map(p => p.location),
        };
      })
      .sort((a, b) => a.priceMonthly - b.priceMonthly);
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.request('/locations');
      return true;
    } catch {
      return false;
    }
  }
}