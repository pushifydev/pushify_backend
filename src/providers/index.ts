export * from './cloud-provider.interface';
export { HetznerProvider } from './hetzner.provider';

import type { ICloudProvider } from './cloud-provider.interface';
import { HetznerProvider } from './hetzner.provider';

export type ProviderType = 'hetzner' | 'digitalocean' | 'aws' | 'gcp' | 'self_hosted';

export function createProvider(
  type: ProviderType,
  apiToken: string
): ICloudProvider {
  switch (type) {
    case 'hetzner':
      return new HetznerProvider(apiToken);
    // Future providers can be added here
    // case 'digitalocean':
    //   return new DigitalOceanProvider(apiToken);
    // case 'aws':
    //   return new AWSProvider(apiToken);
    default:
      throw new Error(`Provider ${type} is not supported yet`);
  }
}
