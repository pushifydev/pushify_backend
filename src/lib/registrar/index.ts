import { env } from '../../config/env';
import { createNamecomAdapter } from './namecom';
import type { RegistrarAdapter } from './types';

export type { DnsRecordInput, DomainAvailability, RegisteredDomain, RegistrarAdapter } from './types';

let cached: RegistrarAdapter | null | undefined;

/** The configured registrar adapter, or null when domain sales are not set up. */
export function getRegistrar(): RegistrarAdapter | null {
  if (cached !== undefined) return cached;
  const provider = env.REGISTRAR_PROVIDER ?? (env.NAMECOM_USERNAME ? 'namecom' : undefined);
  if (provider === 'namecom' && env.NAMECOM_USERNAME && env.NAMECOM_TOKEN) {
    cached = createNamecomAdapter({
      username: env.NAMECOM_USERNAME,
      token: env.NAMECOM_TOKEN,
      apiUrl: env.NAMECOM_API_URL,
    });
  } else {
    cached = null;
  }
  return cached;
}

/** Test hook — drop the memoized adapter so env changes take effect. */
export function resetRegistrarCache(): void {
  cached = undefined;
}
