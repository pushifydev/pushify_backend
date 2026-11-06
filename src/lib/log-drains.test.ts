import { describe, it, expect } from 'vitest';
import {
  buildDrainTestRequest,
  buildVectorConfig,
  installLogAgentCommand,
  LOG_AGENT_CONTAINER,
  normalizeLogDrainSettings,
  parseLogAgentOutput,
  removeLogAgentCommand,
  scrubSecrets,
  signS3Request,
  validateLogDrainSecret,
  type AgentContext,
  type AgentDrain,
} from './log-drains';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';

function drain(over: Partial<AgentDrain> = {}): AgentDrain {
  return {
    id: 'd1',
    type: 'http',
    endpoint: 'https://logs.example.com/ingest',
    options: {},
    sendLogs: true,
    sendMetrics: false,
    projectSlug: null,
    secret: null,
    ...over,
  };
}

function ctx(drains: AgentDrain[]): AgentContext {
  return {
    serverId: SERVER_ID,
    serverName: 'web 1 (prod)',
    projects: [
      { id: 'p-web', slug: 'web', workerNames: ['email'] },
      { id: 'p-api', slug: 'api', workerNames: [] },
    ],
    drains,
  };
}

/** What Vector reads after its own `$$` → `$` unescaping. */
function parsed(config: string) {
  expect(config).not.toMatch(/(^|[^$])\$([^$]|$)/); // every $ is doubled
  return JSON.parse(config.replace(/\$\$/g, '$'));
}

describe('normalizeLogDrainSettings', () => {
  it('requires an endpoint for URL drains and rejects credentials in it', () => {
    expect(normalizeLogDrainSettings({ type: 'loki' })).toEqual({ problem: 'endpoint is required for loki drains' });
    expect(normalizeLogDrainSettings({ type: 'http', endpoint: 'ftp://x' })).toHaveProperty('problem');
    expect(normalizeLogDrainSettings({ type: 'http', endpoint: 'https://u:p@x.example.com' })).toHaveProperty('problem');
    expect(normalizeLogDrainSettings({ type: 'loki', endpoint: 'https://loki.example.com/' })).toEqual({
      settings: { type: 'loki', endpoint: 'https://loki.example.com', options: {}, sendLogs: true, sendMetrics: false },
    });
  });

  it('defaults the Datadog site and refuses anything that is not one', () => {
    const ok = normalizeLogDrainSettings({ type: 'datadog' });
    expect(ok).toMatchObject({ settings: { endpoint: null, options: { site: 'datadoghq.com' } } });
    expect(normalizeLogDrainSettings({ type: 'datadog', options: { site: 'us5.datadoghq.com' } })).toHaveProperty('settings');
    expect(normalizeLogDrainSettings({ type: 'datadog', options: { site: 'evil.example.com' } })).toHaveProperty('problem');
    expect(normalizeLogDrainSettings({ type: 'datadog', endpoint: 'https://x.example.com' })).toHaveProperty('problem');
  });

  it('checks S3 bucket, region and access key, defaults the prefix and drops unknown options', () => {
    expect(normalizeLogDrainSettings({ type: 's3', options: { region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLE1' } })).toHaveProperty('problem');
    const ok = normalizeLogDrainSettings({
      type: 's3',
      options: { bucket: 'my-logs', region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLE1', index: 'ignored' },
    });
    expect(ok).toEqual({
      settings: {
        type: 's3',
        endpoint: null,
        options: { bucket: 'my-logs', region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLE1', prefix: 'pushify/' },
        sendLogs: true,
        sendMetrics: false,
      },
    });
  });

  it('needs at least one of logs and metrics', () => {
    expect(normalizeLogDrainSettings({ type: 'http', endpoint: 'https://x.example.com', sendLogs: false })).toEqual({
      problem: 'enable at least one of sendLogs and sendMetrics',
    });
  });
});

describe('secrets', () => {
  it('must fit on one line', () => {
    expect(validateLogDrainSecret('abc\ndef')).toMatch(/line breaks/);
    expect(validateLogDrainSecret('')).toMatch(/empty/);
    expect(validateLogDrainSecret('glc_eyJvIjoi$x"y\\z=')).toBeNull();
  });

  it('are scrubbed from text, also in base64', () => {
    const secret = 's3cr3t-token';
    const text = `failed: Bearer ${secret} / ${Buffer.from(secret).toString('base64')}`;
    expect(scrubSecrets(text, [secret, null])).toBe('failed: Bearer *** / ***');
  });
});

describe('buildVectorConfig', () => {
  it('ships logs of every Pushify container to an organization-wide drain, labelled by project', () => {
    const config = parsed(buildVectorConfig(ctx([drain({ secret: 'tok$en' })])));
    expect(config.sources.pushify_container_logs).toEqual({
      type: 'docker_logs',
      include_containers: ['pushify-'],
      exclude_containers: [LOG_AGENT_CONTAINER],
    });
    const vrl: string = config.transforms.pushify_logs.source;
    // Known projects by their exact container names, then any pushify-<slug>…
    expect(vrl).toContain(`match(name, r'^pushify-web(-staging|-pr-[0-9]+)?(-(blue|green)(-[0-9]+)?)?$|`);
    expect(vrl).toContain('worker-(email)');
    expect(vrl).toContain('project_id = "p-api"');
    expect(vrl).toContain('"server": "web-1--prod-"');
    expect(vrl).toContain(`"server_id": "${SERVER_ID}"`);
    expect(config.sinks.drain_1).toMatchObject({
      type: 'http',
      inputs: ['pushify_logs'],
      uri: 'https://logs.example.com/ingest',
      auth: { strategy: 'bearer', token: 'tok$en' },
    });
    expect(config.sources.pushify_host_metrics).toBeUndefined();
    expect(config.sources.pushify_container_stats_file).toBeUndefined();
  });

  it('filters a project drain to its project and never gives it host metrics', () => {
    const config = parsed(
      buildVectorConfig(ctx([drain({ type: 'loki', endpoint: 'https://loki.example.com', projectSlug: 'api', sendMetrics: true })]))
    );
    expect(config.transforms.drain_1_logs).toEqual({ type: 'filter', inputs: ['pushify_logs'], condition: '.pushify.project == "api"' });
    expect(config.transforms.drain_1_stats.condition).toBe('.pushify.project == "api"');
    expect(config.sinks.drain_1.inputs).toEqual(['drain_1_logs', 'drain_1_stats']);
    expect(config.sinks.drain_1.labels.project).toBe('{{ pushify.project }}');
    expect(config.sources.pushify_host_metrics).toBeUndefined();
  });

  it('sends Datadog metrics as metrics and the rest as log events', () => {
    const config = parsed(
      buildVectorConfig(
        ctx([
          drain({ id: 'dd', type: 'datadog', endpoint: null, options: { site: 'datadoghq.eu' }, secret: 'ddkey', sendMetrics: true }),
          drain({ id: 'es', type: 'elastic', endpoint: 'https://es.example.com:9200', options: { index: 'apps' }, secret: 'k', sendLogs: false, sendMetrics: true }),
        ])
      )
    );
    expect(config.sinks.drain_1).toMatchObject({ type: 'datadog_logs', default_api_key: 'ddkey', site: 'datadoghq.eu' });
    expect(config.sinks.drain_1_metrics).toMatchObject({
      type: 'datadog_metrics',
      inputs: ['drain_1_container_metrics', 'pushify_host_metrics_tagged'],
    });
    expect(config.transforms.drain_1_container_metrics.type).toBe('log_to_metric');
    expect(config.sinks.drain_2).toMatchObject({
      type: 'elasticsearch',
      inputs: ['pushify_container_stats', 'pushify_host_metrics_logs'],
      bulk: { index: 'apps' },
      request: { headers: { Authorization: 'ApiKey k' } },
    });
    expect(config.sources.pushify_host_metrics.type).toBe('host_metrics');
    expect(config.transforms.pushify_host_metrics_as_logs.type).toBe('metric_to_log');
    // every input refers to a component that exists
    const names = new Set([...Object.keys(config.sources), ...Object.keys(config.transforms)]);
    for (const c of [...Object.values(config.transforms), ...Object.values(config.sinks)] as Array<{ inputs: string[] }>) {
      for (const input of c.inputs) expect(names.has(input)).toBe(true);
    }
  });
});

describe('agent commands', () => {
  it('validates a new configuration before it replaces the running agent, without the secret in clear', () => {
    const config = buildVectorConfig(ctx([drain({ secret: 'very-secret-token' })]));
    const command = installLogAgentCommand(config, true);
    expect(command).not.toContain('very-secret-token');
    expect(command).toContain(Buffer.from(config).toString('base64'));
    expect(command.indexOf('validate --no-environment')).toBeLessThan(command.indexOf(`docker run -d --name ${LOG_AGENT_CONTAINER}`));
    expect(command).toContain('-v /var/run/docker.sock:/var/run/docker.sock:ro');
    expect(command).toContain('pushify-log-agent-stats.service');
    expect(LOG_AGENT_CONTAINER.startsWith('pushify-')).toBe(false);
    expect(installLogAgentCommand(config, false)).toContain('systemctl disable --now pushify-log-agent-stats.service');
    expect(removeLogAgentCommand()).toContain(`docker rm -f ${LOG_AGENT_CONTAINER}`);
  });

  it('reads the outcome markers', () => {
    expect(parseLogAgentOutput('x\nPUSHIFY_LOG_AGENT status=installed\n')).toEqual({ status: 'installed', error: null, notes: [] });
    expect(parseLogAgentOutput('PUSHIFY_LOG_AGENT error=invalid-config\nboom')).toMatchObject({ status: 'failed', error: 'invalid-config' });
    expect(parseLogAgentOutput('PUSHIFY_LOG_AGENT note=no-systemd-no-container-metrics\nPUSHIFY_LOG_AGENT status=unchanged').notes).toEqual([
      'no-systemd-no-container-metrics',
    ]);
    expect(parseLogAgentOutput('nothing').status).toBeNull();
  });
});

describe('connection test request', () => {
  const now = new Date('2026-11-06T12:00:00.000Z');

  it('uses each destination’s own ingest API and auth', () => {
    const dd = buildDrainTestRequest({ type: 'datadog', endpoint: null, options: { site: 'datadoghq.eu' }, sendLogs: true, sendMetrics: false }, 'k1', now);
    expect(dd.url).toBe('https://http-intake.logs.datadoghq.eu/api/v2/logs');
    expect(dd.headers['DD-API-KEY']).toBe('k1');

    const loki = buildDrainTestRequest({ type: 'loki', endpoint: 'https://loki.example.com', options: { username: '123' }, sendLogs: true, sendMetrics: false }, 'pw', now);
    expect(loki.url).toBe('https://loki.example.com/loki/api/v1/push');
    expect(loki.headers.Authorization).toBe(`Basic ${Buffer.from('123:pw').toString('base64')}`);
    expect(JSON.parse(loki.body).streams[0].values[0][0]).toBe(`${now.getTime()}000000`);

    const es = buildDrainTestRequest({ type: 'elastic', endpoint: 'https://es.example.com', options: { index: 'apps' }, sendLogs: true, sendMetrics: false }, 'key', now);
    expect(es.url).toBe('https://es.example.com/apps/_doc');
    expect(es.headers.Authorization).toBe('ApiKey key');

    const http = buildDrainTestRequest({ type: 'http', endpoint: 'https://x.example.com/in', options: {}, sendLogs: true, sendMetrics: false }, null, now);
    expect(http.headers.Authorization).toBeUndefined();

    const s3 = buildDrainTestRequest(
      { type: 's3', endpoint: null, options: { bucket: 'b1', region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLE1', prefix: 'logs/' }, sendLogs: true, sendMetrics: false },
      'secret',
      now
    );
    expect(s3.method).toBe('PUT');
    expect(s3.url).toBe('https://b1.s3.eu-central-1.amazonaws.com/logs/pushify-connection-test.json');
    expect(s3.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE1\/20261106\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it('signs S3 requests like AWS’s own SigV4 example (GET Object)', () => {
    const url = new URL('https://examplebucket.s3.amazonaws.com/test.txt');
    const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const authorization = signS3Request({
      method: 'GET',
      url,
      headers: { host: url.host, range: 'bytes=0-9', 'x-amz-content-sha256': emptyHash, 'x-amz-date': '20130524T000000Z' },
      payloadHash: emptyHash,
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00.000Z'),
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
  });
});
