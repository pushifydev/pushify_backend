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

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS';

export interface DnsRecordInput {
  /** Subdomain part relative to the domain ('' or '@' for apex, 'www', …) */
  host: string;
  type: DnsRecordType;
  answer: string;
  ttl?: number;
  /** MX/SRV priority */
  priority?: number;
}

export interface DnsRecord extends DnsRecordInput {
  id: string;
  fqdn: string;
}

export interface RegistrarDomainInfo {
  domainName: string;
  expiresAt: Date | null;
  locked: boolean;
  nameservers: string[];
  renewalWholesaleCents: number | null;
}

export type TransferStatus = 'pending' | 'completed' | 'cancelled' | 'failed' | 'unknown';

export interface EmailForwarding {
  /** Local part, e.g. `info` for info@domain */
  emailBox: string;
  emailTo: string;
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

  // ── DNS ──
  listDnsRecords(domainName: string): Promise<DnsRecord[]>;
  createDnsRecord(domainName: string, record: DnsRecordInput): Promise<DnsRecord>;
  updateDnsRecord(domainName: string, recordId: string, record: DnsRecordInput): Promise<DnsRecord>;
  deleteDnsRecord(domainName: string, recordId: string): Promise<void>;
  setNameservers(domainName: string, nameservers: string[]): Promise<void>;

  // ── Ownership / transfer ──
  getDomainInfo(domainName: string): Promise<RegistrarDomainInfo>;
  setLock(domainName: string, locked: boolean): Promise<void>;
  getAuthCode(domainName: string): Promise<string>;
  createTransfer(
    domainName: string,
    opts: { authCode: string; wholesaleCents: number }
  ): Promise<void>;
  getTransferStatus(domainName: string): Promise<TransferStatus>;

  // ── Email forwarding ──
  listEmailForwardings(domainName: string): Promise<EmailForwarding[]>;
  createEmailForwarding(domainName: string, forwarding: EmailForwarding): Promise<void>;
  deleteEmailForwarding(domainName: string, emailBox: string): Promise<void>;
}
