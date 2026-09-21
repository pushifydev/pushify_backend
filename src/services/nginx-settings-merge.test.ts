import { describe, it, expect } from 'vitest';
import { mergeNginxSettings } from './domain.service';

/**
 * The dashboard's Nginx settings: clearing a field has to remove it. A plain spread kept the
 * old value, so emptied "Custom location blocks" stayed in the host vhost and kept shadowing
 * the app (www.yeliapp.com served the host's "Welcome to nginx!" page for /).
 */
const existing = {
  proxyPort: 8080,
  clientMaxBodySize: '10m',
  customLocationBlocks: 'location = / { try_files /index.html =404; }',
  customHeaders: { 'X-Frame-Options': 'DENY' },
  rateLimit: { enabled: true, requestsPerSecond: 10, burst: 20 },
  caching: { enabled: true, maxAge: 60 },
};

describe('mergeNginxSettings', () => {
  it('removes fields sent as null, empty string or empty object', () => {
    const merged = mergeNginxSettings(existing, {
      proxyPort: null,
      customLocationBlocks: '',
      customHeaders: {},
      rateLimit: null,
      caching: null,
    });
    expect(merged).toEqual({ clientMaxBodySize: '10m' });
  });

  it('keeps fields that are left out', () => {
    expect(mergeNginxSettings(existing, { clientMaxBodySize: '50m' })).toEqual({
      ...existing,
      clientMaxBodySize: '50m',
    });
  });

  it('drops a feature that is switched off', () => {
    const merged = mergeNginxSettings(existing, { rateLimit: { enabled: false, requestsPerSecond: 10, burst: 20 } });
    expect(merged.rateLimit).toBeUndefined();
  });

  it('keeps false booleans (turning gzip off is a setting, not a removal)', () => {
    expect(mergeNginxSettings({}, { enableGzip: false, forceHttps: false })).toEqual({
      enableGzip: false,
      forceHttps: false,
    });
  });
});
