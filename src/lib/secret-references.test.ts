import { describe, it, expect, vi } from 'vitest';
import {
  findSecretReferences,
  hasSecretReferences,
  referencedSecretValues,
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
    expect(hasSecretReferences({ A: '{{aws.X}}', B: '{{ .Values.x }}', C: '${FOO}', D: '' })).toBe(false);
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

  it('resolves Doppler references, loading each provider separately', async () => {
    const load = vi.fn(
      async (provider: string): Promise<Record<string, string>> =>
        provider === 'doppler' ? { API_TOKEN: 'dop-value-1' } : { DB_PASSWORD: 'inf-value-2' }
    );
    const result = await resolveSecretReferences(
      { API_TOKEN: '{{doppler.API_TOKEN}}', DATABASE_URL: 'pg://u:{{infisical.DB_PASSWORD}}@db/app' },
      load
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.envVars).toEqual({ API_TOKEN: 'dop-value-1', DATABASE_URL: 'pg://u:inf-value-2@db/app' });
    const masker = createLogMasker({});
    masker.addSecrets(result.resolvedValues);
    expect(masker.mask('token=dop-value-1')).not.toContain('dop-value-1');
  });

  it('fails clearly when the Doppler token is rejected', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Doppler rejected the token (HTTP 401)'));
    await expect(resolveSecretReferences({ A: '{{doppler.A}}' }, load)).rejects.toThrow(
      'Could not load secrets from Doppler for A: Doppler rejected the token (HTTP 401)'
    );
  });

  it('resolves Vault references and masks their values', async () => {
    const load = vi.fn(async (provider: string): Promise<Record<string, string>> =>
      provider === 'vault' ? { DB_PASSWORD: 'vault-pw-123' } : {}
    );
    const result = await resolveSecretReferences(
      { DATABASE_URL: 'pg://u:{{ vault.DB_PASSWORD }}@db/app', NODE_ENV: 'production' },
      load
    );
    expect(load).toHaveBeenCalledWith('vault');
    expect(result.envVars.DATABASE_URL).toBe('pg://u:vault-pw-123@db/app');
    const masker = createLogMasker({});
    masker.addSecrets(result.resolvedValues);
    expect(masker.mask('pw=vault-pw-123')).not.toContain('vault-pw-123');
  });

  it('fails clearly when Vault cannot be reached', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Vault could not be reached'));
    await expect(resolveSecretReferences({ A: '{{vault.A}}' }, load)).rejects.toThrow(
      'Could not load secrets from Vault for A: Vault could not be reached'
    );
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

/** The deploy worker's choke point: resolved values registered first, then the env heuristic. */
async function buildLogFor(envVars: Record<string, string>, secrets: Record<string, string>) {
  const masker = createLogMasker();
  const resolved = await resolveSecretReferences(envVars, async () => secrets);
  masker.addSecrets(resolved.resolvedValues);
  masker.addEnvVars(resolved.envVars);
  return { env: resolved.envVars, log: (output: string) => masker.mask(output) };
}

describe('a build step that echoes a resolved secret', () => {
  it('logs only the masked value', async () => {
    const { env, log } = await buildLogFor({ STRIPE_KEY: '{{infisical.STRIPE_KEY}}' }, { STRIPE_KEY: 'sk_live_51Hx9' });
    const output = log(`$ echo $STRIPE_KEY\n${env.STRIPE_KEY}\nSTRIPE_KEY=${env.STRIPE_KEY}`);
    expect(output).toBe('$ echo $STRIPE_KEY\n••••••\nSTRIPE_KEY=••••••');
    expect(output).not.toContain('sk_live_51Hx9');
  });

  it('masks a secret embedded in a longer value', async () => {
    const { env, log } = await buildLogFor(
      { DATABASE_URL: 'postgres://app:{{infisical.DB_PASSWORD}}@db/app' },
      { DB_PASSWORD: 'Zq8-pass' }
    );
    expect(log(`connecting to ${env.DATABASE_URL}`)).not.toContain('Zq8-pass');
  });

  it('masks every line of a multi-line value, echoed raw or JSON-escaped', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\nAQEFAASCBKcwggSjAgEAAoIB\n-----END PRIVATE KEY-----';
    const { env, log } = await buildLogFor({ SIGNING_KEY: '{{infisical.SIGNING_KEY}}' }, { SIGNING_KEY: pem });
    const raw = log(env.SIGNING_KEY);
    const escaped = log(JSON.stringify({ SIGNING_KEY: env.SIGNING_KEY }));
    for (const output of [raw, escaped]) {
      expect(output).not.toContain('MIIEvQIBADANBgkqhkiG9w0B');
      expect(output).not.toContain('AQEFAASCBKcwggSjAgEAAoIB');
    }
    expect(raw.split('\n')).toEqual(['••••••', '••••••', '••••••', '••••••']);
  });

  it('masks a short value from four characters on', async () => {
    const { log } = await buildLogFor({ PIN: '{{infisical.PIN}}' }, { PIN: 'k7Qz' });
    expect(log('pin=k7Qz')).toBe('pin=••••••');
  });

  it('leaves values under four characters and common words readable, as for every other secret', async () => {
    const { log } = await buildLogFor(
      { REGION: '{{infisical.REGION}}', DEBUG: '{{infisical.DEBUG}}' },
      { REGION: 'eu1', DEBUG: 'true' }
    );
    // Masking these would replace every "eu1" / "true" in the build output.
    expect(log('region=eu1 debug=true')).toBe('region=eu1 debug=true');
  });
});

describe('referencedSecretValues', () => {
  it('returns the referenced values, loading each provider once', async () => {
    const load = vi.fn(async (provider: string): Promise<Record<string, string>> =>
      provider === 'doppler' ? { TOKEN: 'dop-tok-1' } : { A: 'inf-a-1', B: 'inf-b-2', UNUSED: 'not-referenced' }
    );
    const values = await referencedSecretValues(
      { r1: '{{infisical.A}}', r2: 'x-{{infisical.B}}-y', r3: '{{doppler.TOKEN}}', r4: 'plain' },
      load
    );
    expect(values.sort()).toEqual(['dop-tok-1', 'inf-a-1', 'inf-b-2']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('skips a secret the provider no longer has', async () => {
    const values = await referencedSecretValues(
      { r1: '{{vault.GONE}}', r2: '{{vault.KEPT}}' },
      async () => ({ KEPT: 'kept-value' })
    );
    expect(values).toEqual(['kept-value']);
  });

  it('throws when a provider cannot be loaded', async () => {
    await expect(
      referencedSecretValues({ r1: '{{infisical.A}}' }, async () => {
        throw new Error('Infisical could not be reached');
      })
    ).rejects.toThrow('Infisical could not be reached');
  });
});
