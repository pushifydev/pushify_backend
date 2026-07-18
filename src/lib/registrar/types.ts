/** Registrar adapter contract — one implementation per upstream reseller API. */

export interface DomainAvailability {
  domainName: string;
  available: boolean;
  premium: boolean;
  /** Provider (wholesale) price in USD cents; null when not purchasable */
  wholesaleCents: number | null;
  /** Provider renewal price in USD cents, when the API reports it */
  renewalWholesaleCents: number | null;
}

export interface RegisteredDomain {
  domainName: string;
  expiresAt: Date | null;
}

export interface DnsRecordInput {
  /** Subdomain part relative to the domain ('' or '@' for apex, 'www', …) */
  host: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT';
  answer: string;
  ttl?: number;
}

export interface RegistrarAdapter {
  readonly id: string;
  checkAvailability(domainNames: string[]): Promise<DomainAvailability[]>;
  register(
    domainName: string,
    opts: { years: number; wholesaleCents: number }
  ): Promise<RegisteredDomain>;
  renew(
    domainName: string,
    opts: { years: number; wholesaleCents: number }
  ): Promise<RegisteredDomain>;
  /** Current renewal price for an owned domain, if the provider exposes it */
  getRenewalWholesaleCents(domainName: string): Promise<number | null>;
  createDnsRecord(domainName: string, record: DnsRecordInput): Promise<void>;
}
