import { describe, it, expect } from 'vitest';
import {
  estimateVolumeDowntimeSeconds,
  evaluateTransferPreflight,
  projectTransferOf,
  requiredTargetFreeBytes,
  type TransferFacts,
} from './project-transfer';

const facts = (over: Partial<TransferFacts> = {}, project: Partial<TransferFacts['project']> = {}): TransferFacts => ({
  project: {
    organizationId: 'org-1',
    status: 'active',
    suspended: false,
    serverId: 'srv-old',
    staticSite: false,
    composeStack: false,
    ...project,
  },
  targetServerId: 'srv-new',
  target: {
    id: 'srv-new',
    organizationId: 'org-1',
    name: 'hetzner-2',
    status: 'running',
    setupStatus: 'completed',
    ipv4: '203.0.113.9',
    ipv6: null,
    hasSshKey: true,
  },
  hasSuccessfulDeployment: true,
  deploymentInProgress: false,
  volumes: [],
  targetFreeBytes: null,
  sourceDatabases: [],
  quotaProblem: null,
  customDomains: [],
  cloudflareConnected: false,
  ...over,
});

const GiB = 1024 ** 3;

const statusOf = (result: ReturnType<typeof evaluateTransferPreflight>, id: string) =>
  result.checks.find((c) => c.id === id)?.status;

describe('evaluateTransferPreflight', () => {
  it('lets a stateless app on a server of its own move to a ready server of the same org', () => {
    const result = evaluateTransferPreflight(facts());
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.fromServerId).toBe('srv-old');
    expect(result.toServerId).toBe('srv-new');
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it.each([
    [
      'a volume whose size could not be measured',
      facts({ volumes: [{ name: 'uploads', sizeBytes: null }], targetFreeBytes: 50 * GiB }),
      'volumes',
      /size of persistent volume "uploads" .* could not be measured/,
    ],
    [
      'volumes when free disk on the target is unknown',
      facts({ volumes: [{ name: 'uploads', sizeBytes: GiB }], targetFreeBytes: null }),
      'volumes',
      /Free disk space on the target server could not be measured/,
    ],
    [
      'volumes that do not fit on the target',
      facts({ volumes: [{ name: 'uploads', sizeBytes: 10 * GiB }], targetFreeBytes: 10 * GiB }),
      'volumes',
      /Not enough disk on the target server .*"uploads".*10\.0 GB free, 11\.0 GB needed/,
    ],
    [
      'a linked database on the source server',
      facts({ sourceDatabases: ['main-db'] }),
      'databases',
      /"main-db" runs on the current server .* private network/,
    ],
    ['a target in another organization', facts({ target: { ...facts().target!, organizationId: 'org-2' } }), 'target_server', /not found in this organization/],
    ['an unknown target', facts({ target: null }), 'target_server', /not found in this organization/],
    ['the server it already runs on', facts({ target: { ...facts().target!, id: 'srv-old' }, targetServerId: 'srv-old' }), 'target_server', /already runs on this server/],
    ['a target still being set up', facts({ target: { ...facts().target!, setupStatus: 'running' } }), 'target_server', /not ready for deployments/],
    ['a stopped target', facts({ target: { ...facts().target!, status: 'stopped' } }), 'target_server', /not ready for deployments/],
    ['a target without SSH key', facts({ target: { ...facts().target!, hasSshKey: false } }), 'target_server', /no IP address or SSH key/],
    ['an exhausted plan', facts({ quotaProblem: 'Monthly deployment limit reached' }), 'plan_quota', /Monthly deployment limit reached/],
    ['no successful deployment', facts({ hasSuccessfulDeployment: false }), 'deployment', /no successful production deployment/],
    ['a deployment in progress', facts({ deploymentInProgress: true }), 'deployment', /in progress/],
    ['a paused project', facts({}, { status: 'paused' }), 'project', /paused/],
    ['a suspended project', facts({}, { suspended: true }), 'project', /suspended/],
    ['a project on the shared runner', facts({}, { serverId: null }), 'source_server', /shared build server/],
    ['a compose or marketplace stack', facts({}, { composeStack: true }), 'app_type', /Compose and marketplace stacks/],
    ['a static site', facts({}, { staticSite: true }), 'app_type', /static sites/],
  ])('blocks %s with a reason', (_label, input, checkId, message) => {
    const result = evaluateTransferPreflight(input);
    expect(result.ok).toBe(false);
    expect(statusOf(result, checkId)).toBe('block');
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toMatch(message);
  });

  it('lists every blocker, not just the first', () => {
    const result = evaluateTransferPreflight(
      facts({ volumes: [{ name: 'data', sizeBytes: null }], sourceDatabases: ['pg'], quotaProblem: 'Limit' })
    );
    expect(result.ok).toBe(false);
    expect(result.blockers).toHaveLength(3);
  });

  it('moves persistent volumes that fit on the target, reporting their size and the downtime', () => {
    const result = evaluateTransferPreflight(
      facts({
        volumes: [
          { name: 'uploads', sizeBytes: 2 * GiB },
          { name: 'cache', sizeBytes: 0 },
        ],
        targetFreeBytes: 40 * GiB,
      })
    );
    expect(result.ok).toBe(true);
    expect(statusOf(result, 'volumes')).toBe('warn');
    expect(result.checks.find((c) => c.id === 'volumes')?.message).toMatch(
      /"uploads", "cache" \(2\.0 GB\) are copied .* stopped on the current server .* about 4 minutes of downtime/
    );
    expect(result.volumes).toEqual({
      items: [
        { name: 'uploads', sizeBytes: 2 * GiB },
        { name: 'cache', sizeBytes: 0 },
      ],
      totalBytes: 2 * GiB,
      requiredFreeBytes: 3 * GiB,
      targetFreeBytes: 40 * GiB,
      estimatedDowntimeSeconds: estimateVolumeDowntimeSeconds(2 * GiB),
    });
  });

  it('reports no downtime and no disk need without volumes', () => {
    const result = evaluateTransferPreflight(facts());
    expect(result.volumes).toEqual({
      items: [],
      totalBytes: 0,
      requiredFreeBytes: null,
      targetFreeBytes: null,
      estimatedDowntimeSeconds: 0,
    });
  });

  it('returns the new IP for custom domains and marks them for automatic update when Cloudflare is connected', () => {
    const result = evaluateTransferPreflight(
      facts({ customDomains: ['app.example.com'], cloudflareConnected: true, target: { ...facts().target!, ipv6: '2001:db8::9' } })
    );
    expect(result.ok).toBe(true);
    expect(statusOf(result, 'dns')).toBe('warn');
    expect(result.dns).toEqual({
      targetIpv4: '203.0.113.9',
      targetIpv6: '2001:db8::9',
      cloudflareConnected: true,
      domains: [{ domain: 'app.example.com', autoUpdate: true }],
    });
  });

  it('asks for a manual DNS change without Cloudflare — a warning, not a blocker', () => {
    const result = evaluateTransferPreflight(facts({ customDomains: ['app.example.com'] }));
    expect(result.ok).toBe(true);
    expect(result.dns.domains).toEqual([{ domain: 'app.example.com', autoUpdate: false }]);
    expect(result.checks.find((c) => c.id === 'dns')?.message).toMatch(/point the DNS records of "app.example.com" at 203.0.113.9/);
  });

  it('never reveals the address of a server in another organization', () => {
    const result = evaluateTransferPreflight(facts({ target: { ...facts().target!, organizationId: 'org-2' } }));
    expect(result.dns.targetIpv4).toBeNull();
  });
});

describe('projectTransferOf', () => {
  it('reads the move a deployment carries', () => {
    expect(projectTransferOf({ transfer: { fromServerId: 'a', toServerId: 'b' } })).toEqual({ fromServerId: 'a', toServerId: 'b' });
  });

  it('is null for ordinary deployments', () => {
    expect(projectTransferOf(null)).toBeNull();
    expect(projectTransferOf({ forceBuild: true })).toBeNull();
  });
});

describe('volume sizing', () => {
  it('asks the target for the data plus 10% headroom, at least 1 GiB', () => {
    expect(requiredTargetFreeBytes(0)).toBe(GiB);
    expect(requiredTargetFreeBytes(2 * GiB)).toBe(3 * GiB);
    expect(requiredTargetFreeBytes(20 * GiB)).toBe(22 * GiB);
  });

  it('estimates downtime from a fixed restart plus copy and checksum time', () => {
    expect(estimateVolumeDowntimeSeconds(0)).toBe(60);
    // 1 GiB: 51.2 s copying at 20 MiB/s, 10.24 s checksumming at 100 MiB/s
    expect(estimateVolumeDowntimeSeconds(GiB)).toBe(122);
  });
});
