import { describe, it, expect } from 'vitest';
import { buildServerDiagnostics } from './app-health';
import { diagnoseSiteDown, withCauseCode, type SiteDownFacts } from './site-down-diagnosis';
import { diagnoseContainer } from './container-down-cause';

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

  it('an inspected container with a cause is the diagnosis, before the proxy ports and the failed build', () => {
    const container = diagnoseContainer({
      inspection: {
        state: 'exited', name: 'pushify-app', exitCode: 137, restartCount: 2, oomKilled: true, finishedAt: null,
        publishedPort: 3000, listeningPorts: null, loopbackPorts: null, logTail: 'secret log line',
      },
    });
    const d = diagnoseSiteDown({
      ...base,
      error: 'fetch failed (ECONNREFUSED)',
      latestDeploy: failedBuild,
      diagnostics: { ...checks({ httpPort: 'refused' }), container },
    });
    expect(d).toMatchObject({ kind: 'container_not_running', cause: 'oom', userSide: true });
    expect(d.summary).toContain('OOM-killed');
    expect(d.summary).not.toMatch(/build|secret log line|pushify-app/i);
  });

  it('container-only diagnostics (no server checks) are not read as "everything works"', () => {
    const container = diagnoseContainer({ inspection: null, projectPort: 3000 });
    const d = diagnoseSiteDown({
      ...base,
      error: 'fetch failed (ECONNREFUSED)',
      diagnostics: { checks: [], failedCheck: null, container },
    });
    expect(d.kind).toBe('container_not_running');
    expect(d.cause).toBeUndefined();
    expect(d.summary).not.toContain('all work');
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

  it.each([
    ['ENOTFOUND', 'dns_tls', 'does not resolve'],
    ['EAI_AGAIN', 'dns_tls', 'does not resolve'],
    ['CERT_HAS_EXPIRED', 'dns_tls', 'TLS handshake or certificate'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'dns_tls', 'TLS handshake or certificate'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'dns_tls', 'TLS handshake or certificate'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'dns_tls', 'TLS handshake or certificate'],
    ['ECONNREFUSED', 'container_not_running', 'nothing listens on the port'],
    ['ETIMEDOUT', 'unreachable', 'timed out'],
    ['UND_ERR_CONNECT_TIMEOUT', 'unreachable', 'timed out'],
    ['ECONNRESET', 'unreachable', 'closed the connection'],
    ['EHOSTUNREACH', 'unreachable', 'no network route'],
  ])('"fetch failed (%s)" with statusCode null is %s, never a build failure', (code, kind, text) => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
    const error = withCauseCode(err.message, err);
    expect(error).toBe(`fetch failed (${code})`);
    const d = diagnoseSiteDown({ ...base, error, latestDeploy: failedBuild });
    expect(d.kind).toBe(kind);
    expect(d.kind).not.toBe('build_failed');
    expect(d.summary).toContain(code);
    expect(d.summary).toContain(text);
  });

  it('finds the code on a nested cause or an AggregateError of several addresses', () => {
    const nested = { cause: { message: 'wrapped', cause: { code: 'ECONNREFUSED' } } };
    expect(withCauseCode('fetch failed', nested)).toBe('fetch failed (ECONNREFUSED)');
    const aggregate = { cause: new AggregateError([Object.assign(new Error('a'), { code: 'ETIMEDOUT' })]) };
    expect(withCauseCode('fetch failed', aggregate)).toBe('fetch failed (ETIMEDOUT)');
    expect(withCauseCode('fetch failed', { cause: { cause: { cause: {} } } })).toBe('fetch failed');
  });

  it('a refused connection is the container layer: ours undecided, a customer server theirs', () => {
    const error = 'fetch failed (ECONNREFUSED)';
    expect(diagnoseSiteDown({ ...base, error, latestDeploy: failedBuild })).toMatchObject({ kind: 'container_not_running', userSide: null });
    expect(diagnoseSiteDown({ ...base, error, hosting: 'byos' })).toMatchObject({ kind: 'container_not_running', userSide: true });
    // Stored server checks still name the layer first.
    expect(diagnoseSiteDown({ ...base, error, diagnostics: checks({ ssh: 'timeout' }) }).kind).toBe('unreachable');
  });

  it('without server checks it says so instead of guessing', () => {
    expect(diagnoseSiteDown(base)).toMatchObject({ kind: 'unreachable', userSide: null });
  });

  it("a customer's own server that does not answer is user_server_unreachable; a Pushify one stays unreachable", () => {
    const byos = { ...base, hosting: 'byos' as const };
    expect(diagnoseSiteDown({ ...byos, diagnostics: checks({ ssh: 'timeout' }) })).toMatchObject({ kind: 'user_server_unreachable', userSide: true });
    expect(diagnoseSiteDown({ ...byos, diagnostics: checks({ httpsPort: 'timeout' }) })).toMatchObject({ kind: 'user_server_unreachable', userSide: true });
    expect(diagnoseSiteDown({ ...base, diagnostics: checks({ ssh: 'timeout' }) })).toMatchObject({ kind: 'unreachable', userSide: false });
    // Up but nothing listening is still the container layer, not an unreachable server.
    expect(diagnoseSiteDown({ ...byos, diagnostics: checks({ httpPort: 'refused' }) }).kind).toBe('container_not_running');
  });

  it('a powered-off or deleting server is user_server_unreachable, managed or not, with the known stop reason', () => {
    const stopped = diagnoseSiteDown({
      ...base,
      latestDeploy: failedBuild,
      diagnostics: checks({ ssh: 'timeout', httpPort: 'timeout', httpsPort: 'timeout' }),
      serverStatus: 'stopped',
      serverStatusMessage: 'infra_credits_stopped',
    });
    expect(stopped).toMatchObject({ kind: 'user_server_unreachable', userSide: true });
    expect(stopped.summary).toContain('powered off (status stopped, stopped when the infrastructure wallet ran out)');
    expect(stopped.summary).toContain('fetch failed');
    expect(diagnoseSiteDown({ ...base, hosting: 'byos', serverStatus: 'deleting' })).toMatchObject({ kind: 'user_server_unreachable', userSide: true });
    expect(diagnoseSiteDown({ ...base, error: 'fetch failed (ENOTFOUND)', serverStatus: 'stopped' }).kind).toBe('user_server_unreachable');
  });

  it('never echoes an unknown server status message, and ignores the server state when something answers', () => {
    const d = diagnoseSiteDown({ ...base, serverStatus: 'stopped', serverStatusMessage: 'Delete failed: token abc123' });
    expect(d.summary).toContain('(status stopped)');
    expect(d.summary).not.toContain('abc123');
    expect(diagnoseSiteDown({ ...base, serverStatus: 'stopped', serverStatusMessage: 'constructor' }).summary).toContain('(status stopped)');
    // An HTTP answer means the record is stale: the server runs.
    expect(diagnoseSiteDown({ ...base, statusCode: 500, error: null, serverStatus: 'stopped' }).kind).toBe('app_error');
    // A running server, or the shared runners (no server row), keep the usual diagnosis.
    expect(diagnoseSiteDown({ ...base, serverStatus: 'running' }).kind).toBe('unreachable');
    expect(diagnoseSiteDown({ ...base, hosting: 'shared', serverStatus: 'stopped' }).kind).toBe('unreachable');
  });
});
