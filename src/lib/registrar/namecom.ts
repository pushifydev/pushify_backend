import type {
  DnsRecord,
  DnsRecordInput,
  DomainAvailability,
  EmailForwarding,
  RegisteredDomain,
  RegistrarAdapter,
  RegistrarDomainInfo,
  TransferStatus,
} from './types';

/**
 * Name.com Core API v4 adapter (reseller). Auth is HTTP Basic username:token.
 * Point NAMECOM_API_URL at https://api.dev.name.com to run against their test
 * environment (test creds use the `<username>-test` suffix).
 */

const DEFAULT_API_URL = 'https://api.name.com';
const REQUEST_TIMEOUT_MS = 15_000;

interface NamecomConfig {
  username: string;
  token: string;
  apiUrl?: string;
}

interface NamecomAvailabilityResult {
  domainName: string;
  purchasable?: boolean;
  premium?: boolean;
  purchasePrice?: number;
  renewalPrice?: number;
}

interface NamecomDomain {
  domainName: string;
  expireDate?: string;
  renewalPrice?: number;
  locked?: boolean;
  nameservers?: string[];
}

interface NamecomDnsRecord {
  id?: number;
  domainName?: string;
  host?: string;
  fqdn?: string;
  type?: string;
  answer?: string;
  ttl?: number;
  priority?: number;
}

function mapDnsRecord(domainName: string, r: NamecomDnsRecord): DnsRecord {
  return {
    id: String(r.id ?? ''),
    host: r.host ?? '',
    fqdn: r.fqdn ?? (r.host ? `${r.host}.${domainName}.` : `${domainName}.`),
    type: (r.type ?? 'A') as DnsRecord['type'],
    answer: r.answer ?? '',
    ttl: r.ttl,
    priority: r.priority,
  };
}

function dnsRecordBody(record: DnsRecordInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    host: record.host === '@' ? '' : record.host,
    type: record.type,
    answer: record.answer,
    ttl: record.ttl ?? 300,
  };
  if (record.type === 'MX' || record.type === 'SRV') {
    body.priority = record.priority ?? 10;
  }
  return body;
}

function dollarsToCents(value: number | undefined): number | null {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  return Math.round(value * 100);
}

function parseExpireDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

export function createNamecomAdapter(config: NamecomConfig): RegistrarAdapter {
  const baseUrl = (config.apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
  const authHeader = `Basic ${Buffer.from(`${config.username}:${config.token}`).toString('base64')}`;

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        // non-JSON error body — fall through with raw text in the error
      }
      if (!response.ok) {
        const detail = json?.message || json?.details || text.slice(0, 200) || response.statusText;
        throw new Error(`name.com ${method} ${path} failed (${response.status}): ${detail}`);
      }
      return json as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    id: 'namecom',

    async checkAvailability(domainNames: string[]): Promise<DomainAvailability[]> {
      if (domainNames.length === 0) return [];
      const result = await request<{ results?: NamecomAvailabilityResult[] }>(
        'POST',
        '/v4/domains:checkAvailability',
        { domainNames }
      );
      const byName = new Map(
        (result.results ?? []).map((r) => [r.domainName.toLowerCase(), r] as const)
      );
      return domainNames.map((name) => {
        const r = byName.get(name.toLowerCase());
        return {
          domainName: name,
          available: !!r?.purchasable,
          premium: !!r?.premium,
          wholesaleCents: r?.purchasable ? dollarsToCents(r.purchasePrice) : null,
          renewalWholesaleCents: r?.purchasable ? dollarsToCents(r.renewalPrice) : null,
        };
      });
    },

    async register(domainName, opts): Promise<RegisteredDomain> {
      const result = await request<{ domain?: NamecomDomain }>('POST', '/v4/domains', {
        domain: { domainName, privacyEnabled: true },
        purchasePrice: opts.wholesaleCents / 100,
        years: opts.years,
      });
      return {
        domainName,
        expiresAt: parseExpireDate(result.domain?.expireDate),
      };
    },

    async renew(domainName, opts): Promise<RegisteredDomain> {
      const result = await request<{ domain?: NamecomDomain }>(
        'POST',
        `/v4/domains/${encodeURIComponent(domainName)}:renew`,
        { purchasePrice: opts.wholesaleCents / 100, years: opts.years }
      );
      return {
        domainName,
        expiresAt: parseExpireDate(result.domain?.expireDate),
      };
    },

    async getRenewalWholesaleCents(domainName): Promise<number | null> {
      const result = await request<NamecomDomain>(
        'GET',
        `/v4/domains/${encodeURIComponent(domainName)}`
      );
      return dollarsToCents(result.renewalPrice);
    },

    // ── DNS ──

    async listDnsRecords(domainName): Promise<DnsRecord[]> {
      const result = await request<{ records?: NamecomDnsRecord[] }>(
        'GET',
        `/v4/domains/${encodeURIComponent(domainName)}/records?perPage=1000`
      );
      return (result.records ?? []).map((r) => mapDnsRecord(domainName, r));
    },

    async createDnsRecord(domainName, record: DnsRecordInput): Promise<DnsRecord> {
      const result = await request<NamecomDnsRecord>(
        'POST',
        `/v4/domains/${encodeURIComponent(domainName)}/records`,
        dnsRecordBody(record)
      );
      return mapDnsRecord(domainName, result);
    },

    async updateDnsRecord(domainName, recordId, record): Promise<DnsRecord> {
      const result = await request<NamecomDnsRecord>(
        'PUT',
        `/v4/domains/${encodeURIComponent(domainName)}/records/${encodeURIComponent(recordId)}`,
        dnsRecordBody(record)
      );
      return mapDnsRecord(domainName, result);
    },

    async deleteDnsRecord(domainName, recordId): Promise<void> {
      await request(
        'DELETE',
        `/v4/domains/${encodeURIComponent(domainName)}/records/${encodeURIComponent(recordId)}`
      );
    },

    async setNameservers(domainName, nameservers): Promise<void> {
      await request('POST', `/v4/domains/${encodeURIComponent(domainName)}:setNameservers`, {
        nameservers,
      });
    },

    // ── Ownership / transfer ──

    async getDomainInfo(domainName): Promise<RegistrarDomainInfo> {
      const result = await request<NamecomDomain>(
        'GET',
        `/v4/domains/${encodeURIComponent(domainName)}`
      );
      return {
        domainName,
        expiresAt: parseExpireDate(result.expireDate),
        locked: !!result.locked,
        nameservers: result.nameservers ?? [],
        renewalWholesaleCents: dollarsToCents(result.renewalPrice),
      };
    },

    async setLock(domainName, locked): Promise<void> {
      await request(
        'POST',
        `/v4/domains/${encodeURIComponent(domainName)}:${locked ? 'lock' : 'unlock'}`,
        {}
      );
    },

    async getAuthCode(domainName): Promise<string> {
      const result = await request<{ authCode?: string }>(
        'GET',
        `/v4/domains/${encodeURIComponent(domainName)}:getAuthCode`
      );
      if (!result.authCode) {
        throw new Error(`name.com returned no auth code for ${domainName}`);
      }
      return result.authCode;
    },

    async createTransfer(domainName, opts): Promise<void> {
      await request('POST', '/v4/transfers', {
        domainName,
        authCode: opts.authCode,
        purchasePrice: opts.wholesaleCents / 100,
      });
    },

    async getTransferStatus(domainName): Promise<TransferStatus> {
      const result = await request<{ status?: string }>(
        'GET',
        `/v4/transfers/${encodeURIComponent(domainName)}`
      );
      const status = (result.status ?? '').toLowerCase();
      if (status.includes('complete')) return 'completed';
      if (status.includes('cancel')) return 'cancelled';
      if (status.includes('fail') || status.includes('reject')) return 'failed';
      if (status) return 'pending';
      return 'unknown';
    },

    // ── Email forwarding ──

    async listEmailForwardings(domainName): Promise<EmailForwarding[]> {
      const result = await request<{
        emailForwardings?: Array<{ emailBox?: string; emailTo?: string }>;
      }>('GET', `/v4/domains/${encodeURIComponent(domainName)}/email/forwarding`);
      return (result.emailForwardings ?? []).map((f) => ({
        emailBox: f.emailBox ?? '',
        emailTo: f.emailTo ?? '',
      }));
    },

    async createEmailForwarding(domainName, forwarding): Promise<void> {
      await request('POST', `/v4/domains/${encodeURIComponent(domainName)}/email/forwarding`, {
        emailBox: forwarding.emailBox,
        emailTo: forwarding.emailTo,
      });
    },

    async deleteEmailForwarding(domainName, emailBox): Promise<void> {
      await request(
        'DELETE',
        `/v4/domains/${encodeURIComponent(domainName)}/email/forwarding/${encodeURIComponent(emailBox)}`
      );
    },
  };
}
