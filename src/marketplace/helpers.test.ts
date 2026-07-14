import { describe, expect, it } from 'vitest';
import { buildComposeEnvOverride } from './helpers';
import { supabaseTemplate } from './templates/supabase';

describe('buildComposeEnvOverride', () => {
  it('forwards prefix-matching user vars to the mapped service', () => {
    const result = buildComposeEnvOverride(
      {
        GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK: 'true',
        POSTGRES_PASSWORD: 'secret',
        SITE_URL: 'https://app.example.com',
      },
      { auth: ['GOTRUE_'] }
    );
    expect(result).not.toBeNull();
    expect(result!.forwarded).toEqual({ auth: ['GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK'] });
    expect(result!.yaml).toBe(
      'services:\n' +
        '  auth:\n' +
        '    environment:\n' +
        '      GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK: ${GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK}\n'
    );
  });

  it('groups keys per service and sorts them', () => {
    const result = buildComposeEnvOverride(
      {
        PGRST_DB_MAX_ROWS: '1000',
        GOTRUE_SMTP_MAX_FREQUENCY: '1s',
        GOTRUE_EXTERNAL_APPLE_SKIP_NONCE_CHECK: 'true',
      },
      { auth: ['GOTRUE_'], rest: ['PGRST_'] }
    );
    expect(result!.forwarded).toEqual({
      auth: ['GOTRUE_EXTERNAL_APPLE_SKIP_NONCE_CHECK', 'GOTRUE_SMTP_MAX_FREQUENCY'],
      rest: ['PGRST_DB_MAX_ROWS'],
    });
    expect(result!.yaml).toContain('  auth:\n    environment:\n');
    expect(result!.yaml).toContain('  rest:\n    environment:\n      PGRST_DB_MAX_ROWS: ${PGRST_DB_MAX_ROWS}');
  });

  it('returns null when no vars match or passthrough is undefined', () => {
    expect(buildComposeEnvOverride({ POSTGRES_PASSWORD: 'x' }, { auth: ['GOTRUE_'] })).toBeNull();
    expect(buildComposeEnvOverride({ GOTRUE_A: 'x' }, undefined)).toBeNull();
  });

  it('skips keys that are not valid env identifiers', () => {
    const result = buildComposeEnvOverride(
      { 'GOTRUE_BAD-KEY': 'x', 'GOTRUE_$(rm -rf /)': 'y', GOTRUE_OK: 'z' },
      { auth: ['GOTRUE_'] }
    );
    expect(result!.forwarded).toEqual({ auth: ['GOTRUE_OK'] });
  });

  it('supabase template forwards GOTRUE_* to auth and PGRST_* to rest', () => {
    const result = buildComposeEnvOverride(
      { GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK: 'true', PGRST_DB_MAX_ROWS: '500' },
      supabaseTemplate.envPassthrough
    );
    expect(result!.forwarded).toEqual({
      auth: ['GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK'],
      rest: ['PGRST_DB_MAX_ROWS'],
    });
  });
});
