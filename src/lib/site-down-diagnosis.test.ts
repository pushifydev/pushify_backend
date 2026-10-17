import { describe, it, expect } from 'vitest';
import { buildServerDiagnostics } from './app-health';
import { diagnoseSiteDown, withCauseCode, type SiteDownFacts } from './site-down-diagnosis';

const base: SiteDownFacts = { statusCode: null, error: 'fetch failed', hosting: 'managed', diagnostics: null, latestDeploy: null };
const checks = (o: Partial<Parameters<typeof buildServerDiagnostics>[0]>) =>
  buildServerDiagnostics({ ssh: 'ok', docker: 'ok', httpPort: 'ok', httpsPort: 'ok', ...o }, { managed: true });
const failedBuild = { status: 'failed', blame: 'project' as const, label: 'Docker build failed' };

describe('diagnoseSiteDown', () => {
  it('does not call a site with no HTTP answer a build failure just because the latest build failed', () => {
    const d = diagnoseSiteDown({ ...base, latestDeploy: failedBuild, diagnostics: checks({ ssh: 'timeout' }) });
    expect(d.kind).toBe('unreachable');
    expect(d.userSide).toBe(false);
    expect(d.summary).toContain('fetch failed');
  });

  it('is a build failure when the proxy answers with no app behind it after a project-side failed build', () => {
    expect(diagnoseSiteDown({ ...base, statusCode: 502, error: null, latestDeploy: failedBuild })).toMatchObject({
      kind: 'build_failed',
      userSide: true,
    });
    expect(diagnoseSiteDown({ ...base, statusCode: 502, error: null }).kind).toBe('container_not_running');
  });

  it('an HTTP error of the app itself is the app, user side', () => {
    expect(diagnoseSiteDown({ ...base, statusCode: 500, error: null })).toMatchObject({ kind: 'app_error', userSide: true });
  });

  it('reads DNS and TLS failures from the network error code', () => {
    expect(diagnoseSiteDown({ ...base, error: 'fetch failed (ENOTFOUND)' }).kind).toBe('dns_tls');
    expect(diagnoseSiteDown({ ...base, error: 'fetch failed (CERT_HAS_EXPIRED)' }).kind).toBe('dns_tls');
    expect(diagnoseSiteDown({ ...base, error: 'fetch failed (ERR_TLS_CERT_ALTNAME_INVALID)' }).kind).toBe('dns_tls');
  });

  it('uses the stored server checks to say which layer gives no answer', () => {
    expect(diagnoseSiteDown({ ...base, diagnostics: checks({ docker: 'failed' }) }).kind).toBe('container_not_running');
    expect(diagnoseSiteDown({ ...base, diagnostics: checks({ httpPort: 'refused' }) }).kind).toBe('container_not_running');
    expect(diagnoseSiteDown({ ...base, diagnostics: checks({ httpsPort: 'timeout' }) }).kind).toBe('unreachable');
    expect(diagnoseSiteDown({ ...base, diagnostics: checks({}) }).kind).toBe('container_not_running');
  });

  it('a customer-owned server that does not answer is user side; a Pushify one is not', () => {
    const down = checks({ ssh: 'timeout' });
    expect(diagnoseSiteDown({ ...base, hosting: 'byos', diagnostics: down }).userSide).toBe(true);
    expect(diagnoseSiteDown({ ...base, hosting: 'shared', diagnostics: down }).userSide).toBe(false);
  });

  it('keeps the network error code behind "fetch failed", never the host name', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND app.example.com'), { code: 'ENOTFOUND' }),
    });
    expect(withCauseCode(err.message, err)).toBe('fetch failed (ENOTFOUND)');
    expect(withCauseCode('Unknown error', 'not an error')).toBe('Unknown error');
    expect(withCauseCode('fetch failed', { cause: { code: 'not a code; rm -rf' } })).toBe('fetch failed');
  });

  it('without server checks it says so instead of guessing', () => {
    expect(diagnoseSiteDown(base)).toMatchObject({ kind: 'unreachable', userSide: null });
  });
});
