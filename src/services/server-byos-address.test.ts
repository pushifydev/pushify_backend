import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * Adding a self-hosted (BYOS) server: the address must be an IPv4 or IPv6 literal. IPv6 may be
 * typed in URL form (`[2001:db8::1]`), which ssh2 would look up as a hostname, so it is stored and
 * connected to without the brackets. IPv4 is stored exactly as before.
 */
const mocks = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
}));

vi.mock('../db', () => {
  const select = { from: () => select, where: () => select, groupBy: async () => [] };
  return {
    db: {
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            mocks.inserted.push(values);
            return [{ id: 'srv-1', providerId: null, providerData: {}, ...values }];
          },
        }),
      }),
      select: () => select,
    },
  };
});
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: {
    findMember: async () => ({ role: 'owner' }),
    findById: async () => ({ id: 'org-1', plan: 'free' }),
  },
}));
vi.mock('./organization-billing.service', () => ({ assertOrganizationCanMutateResources: vi.fn(async () => undefined) }));
vi.mock('./plan-limits.service', () => ({ planLimitsService: { assertServersQuota: vi.fn(async () => undefined) } }));
vi.mock('../utils/ssh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/ssh')>()),
  generateSSHKeyPair: () => ({ privateKey: 'test-private-key', publicKey: 'ssh-rsa AAAA test' }),
}));

import { serverService } from './server.service';

const setup = vi.spyOn(serverService, 'setupBYOSServer').mockResolvedValue(undefined);

const addByos = (ipv4: string | undefined) =>
  serverService.createServer(
    'org-1',
    'user-1',
    { name: 'own', provider: 'self_hosted', region: 'custom', size: 'custom', image: 'custom', ipv4, rootPassword: 'pw' },
    'en'
  );

beforeEach(() => {
  mocks.inserted.length = 0;
  setup.mockClear();
});

describe('serverService.createServer (BYOS address)', () => {
  it('stores an IPv4 address unchanged and connects to it', async () => {
    const server = await addByos('203.0.113.7');

    expect(mocks.inserted[0]).toMatchObject({ provider: 'self_hosted', ipv4: '203.0.113.7' });
    expect(setup).toHaveBeenCalledWith('srv-1', expect.objectContaining({ ipv4: '203.0.113.7' }));
    expect(server.ipv4).toBe('203.0.113.7');
  });

  it('accepts an IPv6 address and drops the brackets before storing and connecting', async () => {
    await addByos('[2001:DB8::1]');

    expect(mocks.inserted[0]).toMatchObject({ ipv4: '2001:db8::1' });
    expect(setup).toHaveBeenCalledWith('srv-1', expect.objectContaining({ ipv4: '2001:db8::1' }));
  });

  it('accepts a bare IPv6 address', async () => {
    await addByos('2a01:4f8:c0c:1234::1');

    expect(mocks.inserted[0]).toMatchObject({ ipv4: '2a01:4f8:c0c:1234::1' });
  });

  it('rejects something that is not an IP address, before anything is stored', async () => {
    const err = await addByos('not an ip').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(400);
    expect(mocks.inserted).toHaveLength(0);
    expect(setup).not.toHaveBeenCalled();
  });

  it('still requires an address', async () => {
    const err = await addByos(undefined).catch((e: unknown) => e);

    expect((err as HTTPException).status).toBe(400);
    expect(mocks.inserted).toHaveLength(0);
  });
});
