import { describe, it, expect, vi } from 'vitest';
import {
  findSecretReferences,
  hasSecretReferences,
  resolveSecretReferences,
  SecretReferenceError,
} from './secret-references';
import { createLogMasker } from './log-masking';

describe('findSecretReferences', () => {
  it('finds whole-value and embedded references', () => {
    expect(
      findSecretReferences({
        STRIPE_KEY: '{{infisical.STRIPE_KEY}}',
        DATABASE_URL: 'postgres://app:{{ infisical.DB_PASSWORD }}@db:5432/app',
        PLAIN: 'hello',
      })
    ).toEqual([
      { envKey: 'STRIPE_KEY', provider: 'infisical', secretKey: 'STRIPE_KEY' },
      { envKey: 'DATABASE_URL', provider: 'infisical', secretKey: 'DB_PASSWORD' },
    ]);
  });

  it('ignores unknown providers and template-looking text', () => {
    expect(hasSecretReferences({ A: '{{vault.X}}', B: '{{ .Values.x }}', C: '${FOO}', D: '' })).toBe(false);
  });
});

describe('resolveSecretReferences', () => {
  it('returns the env untouched and never calls the provider without references', async () => {
    const load = vi.fn();
    const result = await resolveSecretReferences({ A: '1' }, load);
    expect(result).toEqual({ envVars: { A: '1' }, resolvedValues: [], resolvedKeys: [] });
    expect(load).not.toHaveBeenCalled();
  });

  it('replaces references, loads each provider once and does not mutate the input', async () => {
    const load = vi.fn().mockResolvedValue({ STRIPE_KEY: 'sk_live_abc123', DB_PASSWORD: 'p@ss$word' });
    const input = {
      STRIPE_KEY: '{{infisical.STRIPE_KEY}}',
      DATABASE_URL: 'postgres://app:{{infisical.DB_PASSWORD}}@db/app',
      NODE_ENV: 'production',
    };
    const result = await resolveSecretReferences(input, load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('infisical');
    expect(result.envVars).toEqual({
      STRIPE_KEY: 'sk_live_abc123',
      DATABASE_URL: 'postgres://app:p@ss$word@db/app',
      NODE_ENV: 'production',
    });
    expect(result.resolvedKeys).toEqual(['STRIPE_KEY', 'DATABASE_URL']);
    expect(result.resolvedValues.sort()).toEqual(['p@ss$word', 'sk_live_abc123']);
    expect(input.STRIPE_KEY).toBe('{{infisical.STRIPE_KEY}}');
  });

  it('fails with the variable and secret names, but no values, when a secret is missing', async () => {
    const load = vi.fn().mockResolvedValue({ OTHER: 'top-secret-value' });
    const err = await resolveSecretReferences({ API_KEY: '{{infisical.API_KEY}}' }, load).catch((e) => e);
    expect(err).toBeInstanceOf(SecretReferenceError);
    expect(err.message).toContain('API_KEY → {{infisical.API_KEY}}');
    expect(err.message).not.toContain('top-secret-value');
  });

  it('fails clearly when the provider cannot be loaded (no connection, auth, network)', async () => {
    const load = vi.fn().mockRejectedValue(new Error('no Infisical connection is set up'));
    await expect(
      resolveSecretReferences({ A: '{{infisical.A}}', B: '{{infisical.B}}' }, load)
    ).rejects.toThrow('Could not load secrets from Infisical for A, B: no Infisical connection is set up');
  });

  it('resolved values are masked by the existing log masker', async () => {
    const result = await resolveSecretReferences(
      { SHORT_FLAG: '{{infisical.FLAG}}' },
      async () => ({ FLAG: 'xyz9' })
    );
    const masker = createLogMasker(result.envVars);
    // Short value under a non-sensitive key: the heuristic alone would let it through.
    expect(masker.mask('flag=xyz9')).toBe('flag=xyz9');
    masker.addSecrets(result.resolvedValues);
    expect(masker.mask('flag=xyz9')).not.toContain('xyz9');
  });
});
