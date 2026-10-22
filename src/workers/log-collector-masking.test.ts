import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Runtime logs: the stored env holds `{{infisical.KEY}}`-style references, the running app holds
 * their values. The masker for persisted and streamed container logs must know those values too.
 */

const state: {
  envRows: Array<{ id: string; key: string; valueEncrypted: string; isSecret: boolean }>;
  project: { organizationId: string } | undefined;
} = { envRows: [], project: undefined };

vi.mock('../db', () => ({
  db: {
    select: (fields?: unknown) => ({
      from: () => ({
        where: () => {
          // The env query is awaited after where(); the project query adds limit(1).
          const rows = fields ? (state.project ? [state.project] : []) : state.envRows;
          const result = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
          result.limit = async () => rows;
          return result;
        },
      }),
    }),
  },
}));
vi.mock('../lib/encryption', () => ({ decrypt: (value: string) => value }));
vi.mock('../services/secret-provider.service', () => ({
  secretProviderService: { referencedValuesForMasking: vi.fn() },
}));

const { getProjectLogMasker } = await import('./log-collector');
const { secretProviderService } = await import('../services/secret-provider.service');
const referencedValuesForMasking = vi.mocked(secretProviderService.referencedValuesForMasking);

beforeEach(() => {
  referencedValuesForMasking.mockReset();
  state.envRows = [];
  state.project = { organizationId: 'org-1' };
});

describe('getProjectLogMasker with secret manager references', () => {
  it('masks the values behind the references in runtime logs', async () => {
    state.envRows = [
      { id: 'row-1', key: 'STRIPE_KEY', valueEncrypted: '{{infisical.STRIPE_KEY}}', isSecret: false },
      { id: 'row-2', key: 'DATABASE_URL', valueEncrypted: 'pg://u:{{infisical.DB_PW}}@db/app', isSecret: false },
    ];
    referencedValuesForMasking.mockResolvedValue(['sk_live_runtime1', 'pw-runtime']);

    const masker = await getProjectLogMasker('proj-refs');
    const line = masker.mask('boot key=sk_live_runtime1 url=pg://u:pw-runtime@db/app');

    expect(line).toBe('boot key=•••••• url=pg://u:••••••@db/app');
    expect(referencedValuesForMasking).toHaveBeenCalledWith('org-1', 'proj-refs', {
      'row-1': '{{infisical.STRIPE_KEY}}',
      'row-2': 'pg://u:{{infisical.DB_PW}}@db/app',
    });
  });

  it('passes the same key from every environment, not only the last one read', async () => {
    state.envRows = [
      { id: 'row-prod', key: 'API_KEY', valueEncrypted: '{{infisical.API_KEY}}', isSecret: false },
      { id: 'row-preview', key: 'API_KEY', valueEncrypted: '{{infisical.API_KEY_PREVIEW}}', isSecret: false },
    ];
    referencedValuesForMasking.mockResolvedValue([]);

    await getProjectLogMasker('proj-envs');

    expect(referencedValuesForMasking.mock.calls[0][2]).toEqual({
      'row-prod': '{{infisical.API_KEY}}',
      'row-preview': '{{infisical.API_KEY_PREVIEW}}',
    });
  });

  it('does not ask the secret manager when nothing references it', async () => {
    state.envRows = [{ id: 'row-1', key: 'API_KEY', valueEncrypted: 'sk_plain_value', isSecret: false }];

    const masker = await getProjectLogMasker('proj-plain');

    expect(masker.mask('key sk_plain_value')).toBe('key ••••••');
    expect(referencedValuesForMasking).not.toHaveBeenCalled();
  });

  it('throws without caching when the values cannot be loaded, and retries on the next call', async () => {
    state.envRows = [{ id: 'row-1', key: 'TOKEN', valueEncrypted: '{{infisical.TOKEN}}', isSecret: false }];
    referencedValuesForMasking.mockRejectedValueOnce(new Error('Infisical could not be reached'));

    await expect(getProjectLogMasker('proj-down')).rejects.toThrow('Infisical could not be reached');

    referencedValuesForMasking.mockResolvedValueOnce(['tok-after-retry']);
    const masker = await getProjectLogMasker('proj-down');
    expect(masker.mask('tok-after-retry')).toBe('••••••');
    expect(referencedValuesForMasking).toHaveBeenCalledTimes(2);
  });
});
