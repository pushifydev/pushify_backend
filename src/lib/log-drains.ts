import { createHash, createHmac } from 'crypto';
import { projectContainerPattern } from './project-containers';

/**
 * Log and metric drains: a Vector agent (https://vector.dev) on each of an organization's own
 * servers ships its containers' logs — and, when asked, container and host metrics — to the
 * organization's tools (any HTTP endpoint, Grafana Loki, Datadog, Elasticsearch, S3).
 *
 * Every event carries `pushify.project` (slug), `pushify.project_id` (when the project is known at
 * sync time), `pushify.environment` (production | staging | preview), `pushify.service`
 * (app | worker:<name> | database) and `pushify.server` / `pushify.server_id`.
 *
 * - Only the organization's own servers get the agent. Shared runners host many organizations and
 *   are never touched (the caller filters them out).
 * - The agent is the container `pushify_log_agent` (no `pushify-` prefix, so the orphan scan and
 *   the log source itself leave it alone), configured by /opt/pushify/log-agent/vector.json (mode
 *   600: it holds the drains' credentials). The sync command validates a new configuration with
 *   `vector validate` before it replaces the running one.
 * - Container metrics come from `docker stats`, sampled by a small systemd service into a file the
 *   agent reads; host metrics from Vector's `host_metrics` source (org-wide drains only).
 * - Logs are shipped as the containers write them: the secret masking Pushify applies to the logs
 *   it stores itself does not apply to drains.
 */

export const LOG_DRAIN_TYPES = ['http', 'loki', 'datadog', 'elastic', 's3'] as const;
export type LogDrainType = (typeof LOG_DRAIN_TYPES)[number];

export const LOG_AGENT_IMAGE = 'timberio/vector:0.42.0-alpine';
export const LOG_AGENT_CONTAINER = 'pushify_log_agent';
export const LOG_AGENT_DIR = '/opt/pushify/log-agent';
export const LOG_AGENT_STATS_DIR = '/var/lib/pushify-log-agent';
export const LOG_AGENT_STATS_FILE = `${LOG_AGENT_STATS_DIR}/container-stats.log`;
export const LOG_AGENT_MARKER = 'PUSHIFY_LOG_AGENT';
const STATS_UNIT = 'pushify-log-agent-stats.service';
const STATS_SCRIPT = `${LOG_AGENT_DIR}/container-stats.sh`;
const STATS_INTERVAL_SECONDS = 30;
const HOST_METRICS_INTERVAL_SECONDS = 30;

export const DEFAULT_DATADOG_SITE = 'datadoghq.com';
export const DEFAULT_ELASTIC_INDEX = 'pushify-logs';
export const DEFAULT_S3_PREFIX = 'pushify/';
const MAX_SECRET_LENGTH = 4096;

/** Non-secret, per-type settings (stored as JSON). */
export interface LogDrainOptions {
  /** http / loki / elastic: basic auth user; the secret is then the password */
  username?: string;
  /** datadog: site, e.g. datadoghq.com (default), datadoghq.eu, us5.datadoghq.com */
  site?: string;
  /** elastic: index (default pushify-logs) */
  index?: string;
  /** s3: bucket, region, key prefix (default pushify/) and access key id */
  bucket?: string;
  region?: string;
  prefix?: string;
  accessKeyId?: string;
}

const OPTION_KEYS: Record<LogDrainType, (keyof LogDrainOptions)[]> = {
  http: ['username'],
  loki: ['username'],
  datadog: ['site'],
  elastic: ['username', 'index'],
  s3: ['bucket', 'region', 'prefix', 'accessKeyId'],
};

export function isLogDrainType(value: unknown): value is LogDrainType {
  return typeof value === 'string' && (LOG_DRAIN_TYPES as readonly string[]).includes(value);
}

/** The settings a drain is stored and used with (secret excluded). */
export interface LogDrainSettings {
  type: LogDrainType;
  endpoint: string | null;
  options: LogDrainOptions;
  sendLogs: boolean;
  sendMetrics: boolean;
}

function validUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'endpoint must be a valid http(s) URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'endpoint must be a valid http(s) URL';
  if (url.username || url.password) return 'endpoint must not contain credentials; put them in secret (and options.username)';
  return null;
}

/**
 * Normalise the non-secret settings of a drain; returns the problem as a readable message
 * (no values echoed) or the settings. Unknown option keys are dropped.
 */
export function normalizeLogDrainSettings(input: {
  type: LogDrainType;
  endpoint?: string | null;
  options?: Record<string, unknown> | null;
  sendLogs?: boolean;
  sendMetrics?: boolean;
}): { settings: LogDrainSettings } | { problem: string } {
  const { type } = input;
  const options: LogDrainOptions = {};
  const rawOptions = input.options && typeof input.options === 'object' ? input.options : {};
  for (const key of OPTION_KEYS[type]) {
    const value = rawOptions[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') return { problem: `options.${key} must be a string` };
    options[key] = value.trim();
  }

  const sendLogs = input.sendLogs ?? true;
  const sendMetrics = input.sendMetrics ?? false;
  if (typeof sendLogs !== 'boolean' || typeof sendMetrics !== 'boolean') {
    return { problem: 'sendLogs and sendMetrics must be booleans' };
  }
  if (!sendLogs && !sendMetrics) return { problem: 'enable at least one of sendLogs and sendMetrics' };

  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim().replace(/\/+$/, '') : '';
  if (input.endpoint != null && typeof input.endpoint !== 'string') return { problem: 'endpoint must be a string' };
  if (endpoint.length > 500) return { problem: 'endpoint must be at most 500 characters' };

  if (options.username !== undefined && !/^[^\s:"\\]{1,200}$/.test(options.username)) {
    return { problem: 'options.username must be 1-200 characters without spaces, colons, quotes or backslashes' };
  }

  if (type === 'datadog') {
    if (endpoint) return { problem: 'datadog drains take options.site, not an endpoint' };
    options.site = (options.site ?? DEFAULT_DATADOG_SITE).toLowerCase();
    if (!/^([a-z0-9]+\.)?(datadoghq\.(com|eu)|ddog-gov\.com)$/.test(options.site)) {
      return { problem: 'options.site must be a Datadog site such as datadoghq.com or datadoghq.eu' };
    }
    return { settings: { type, endpoint: null, options, sendLogs, sendMetrics } };
  }

  if (type === 's3') {
    if (endpoint) {
      const problem = validUrl(endpoint);
      if (problem) return { problem };
    }
    if (!options.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      return { problem: 'options.bucket must be a valid S3 bucket name' };
    }
    if (!options.region || !/^[a-z0-9-]{2,32}$/.test(options.region)) {
      return { problem: 'options.region is required (e.g. eu-central-1, or auto for R2)' };
    }
    if (!options.accessKeyId || !/^[A-Za-z0-9]{8,128}$/.test(options.accessKeyId)) {
      return { problem: 'options.accessKeyId is required' };
    }
    options.prefix = options.prefix ?? DEFAULT_S3_PREFIX;
    if (!/^[A-Za-z0-9_./-]{0,200}$/.test(options.prefix)) {
      return { problem: 'options.prefix may only contain letters, digits, _ . / -' };
    }
    return { settings: { type, endpoint: endpoint || null, options, sendLogs, sendMetrics } };
  }

  if (!endpoint) return { problem: `endpoint is required for ${type} drains` };
  const problem = validUrl(endpoint);
  if (problem) return { problem };
  if (type === 'elastic') {
    options.index = options.index ?? DEFAULT_ELASTIC_INDEX;
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(options.index)) {
      return { problem: 'options.index must be a lowercase Elasticsearch index name' };
    }
  }
  return { settings: { type, endpoint, options, sendLogs, sendMetrics } };
}

/** Whether a drain of this type cannot work without a secret. */
export function secretRequired(type: LogDrainType): boolean {
  return type === 'datadog' || type === 's3';
}

/** A secret must fit on one line of a configuration file. Returns the problem or null. */
export function validateLogDrainSecret(secret: string): string | null {
  if (secret.length === 0) return 'secret must not be empty';
  if (secret.length > MAX_SECRET_LENGTH) return `secret must be at most ${MAX_SECRET_LENGTH} characters`;
  if (/[\x00-\x1f\x7f]/.test(secret)) return 'secret must not contain line breaks or control characters';
  return null;
}

/** Replace every occurrence of the given secrets (and their base64 form) in a text with `***`. */
export function scrubSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    for (const form of [secret, Buffer.from(secret).toString('base64')]) {
      out = out.split(form).join('***');
    }
  }
  return out;
}

// ── Agent configuration ──────────────────────────────────────────────────────

export interface AgentProject {
  id: string;
  slug: string;
  workerNames: string[];
}

export interface AgentDrain extends LogDrainSettings {
  id: string;
  /** Slug of the drain's project; null for an organization-wide drain */
  projectSlug: string | null;
  /** Decrypted secret, or null */
  secret: string | null;
}

export interface AgentContext {
  serverId: string;
  serverName: string;
  projects: AgentProject[];
  drains: AgentDrain[];
}

const SAFE_SLUG = /^[a-z0-9-]+$/;

/** A label value that is safe inside a VRL string literal. */
function labelValue(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63) || 'server';
}

/**
 * VRL that resolves the container named by the local `name` into `labels`: the known projects of
 * the server by their exact container names (lib/project-containers.ts), then — for projects
 * created after the last sync — any `pushify-<slug>…` name. Aborts for anything else.
 */
function labelVrl(ctx: AgentContext): string {
  const lines: string[] = ['slug = ""', 'project_id = ""'];
  const projects = ctx.projects.filter((p) => SAFE_SLUG.test(p.slug)).sort((a, b) => b.slug.length - a.slug.length);
  projects.forEach((p, i) => {
    const kw = i === 0 ? 'if' : '} else if';
    lines.push(`${kw} match(name, r'${projectContainerPattern(p.slug, p.workerNames)}') {`);
    lines.push(`  slug = "${p.slug}"`, `  project_id = "${p.id}"`);
  });
  if (projects.length) lines.push('}');
  lines.push(
    'if slug == "" {',
    "  parsed, err = parse_regex(name, r'^pushify-(?:preview-)?(?P<slug>[a-z0-9-]+?)(?:-staging|-pr-[0-9]+)?(?:-(?:blue|green)(?:-[0-9]+)?|-db|(?:-staging)?-worker-[a-z0-9-]+)?$')",
    '  if err == null { slug = string(parsed.slug) ?? "" }',
    '}',
    'if slug == "" { abort }',
    'prefix = "pushify-" + slug',
    'environment = "production"',
    'if starts_with(name, "pushify-preview-") {',
    '  prefix = "pushify-preview-" + slug',
    '  environment = "preview"',
    '}',
    'rest = slice(name, strlen(prefix)) ?? ""',
    'service = "app"',
    "worker, err = parse_regex(rest, r'^(?:-staging)?-worker-(?P<name>[a-z0-9-]+)$')",
    'if err == null {',
    '  service = "worker:" + (string(worker.name) ?? "")',
    '  if starts_with(rest, "-staging-") { environment = "staging" }',
    '} else if rest == "-db" {',
    '  service = "database"',
    '} else if starts_with(rest, "-staging") {',
    '  environment = "staging"',
    '} else if starts_with(rest, "-pr-") {',
    '  environment = "preview"',
    '}',
    'labels = {',
    '  "project": slug,',
    '  "project_id": project_id,',
    '  "environment": environment,',
    '  "service": service,',
    `  "server": "${labelValue(ctx.serverName)}",`,
    `  "server_id": "${ctx.serverId}",`,
    '  "kind": kind',
    '}'
  );
  return lines.join('\n');
}

function logsVrl(ctx: AgentContext): string {
  return [
    'name = replace(string(.container_name) ?? "", r\'^/\', "")',
    'kind = "log"',
    labelVrl(ctx),
    '.pushify = labels',
    'del(.label)',
  ].join('\n');
}

function statsVrl(ctx: AgentContext): string {
  return [
    'stats = object(parse_json(string(.message) ?? "{}") ?? {}) ?? {}',
    'name = string(stats.Name) ?? ""',
    'kind = "container_metrics"',
    labelVrl(ctx),
    '. = {',
    '  "pushify": labels,',
    '  "container": name,',
    '  "cpu_percent": to_float(replace(string(stats.CPUPerc) ?? "", "%", "")) ?? 0.0,',
    '  "memory_percent": to_float(replace(string(stats.MemPerc) ?? "", "%", "")) ?? 0.0,',
    '  "pids": to_int(string(stats.PIDs) ?? "") ?? 0,',
    '  "timestamp": now()',
    '}',
  ].join('\n');
}

function hostMetricLabelsVrl(ctx: AgentContext): string {
  return [`.tags.server = "${labelValue(ctx.serverName)}"`, `.tags.server_id = "${ctx.serverId}"`, '.tags.source = "pushify"'].join('\n');
}

function hostMetricLogVrl(ctx: AgentContext): string {
  return [
    '.pushify = {',
    '  "project": "",',
    '  "project_id": "",',
    '  "environment": "",',
    '  "service": "host",',
    `  "server": "${labelValue(ctx.serverName)}",`,
    `  "server_id": "${ctx.serverId}",`,
    '  "kind": "host_metrics"',
    '}',
  ].join('\n');
}

function basicOrBearer(drain: AgentDrain): Record<string, unknown> | undefined {
  if (!drain.secret) return undefined;
  if (drain.options.username) return { strategy: 'basic', user: drain.options.username, password: drain.secret };
  return { strategy: 'bearer', token: drain.secret };
}

function logSink(drain: AgentDrain, inputs: string[]): Record<string, unknown> {
  switch (drain.type) {
    case 'http':
      return {
        type: 'http',
        inputs,
        uri: drain.endpoint,
        method: 'post',
        encoding: { codec: 'json' },
        ...(basicOrBearer(drain) ? { auth: basicOrBearer(drain) } : {}),
      };
    case 'loki':
      return {
        type: 'loki',
        inputs,
        endpoint: drain.endpoint,
        encoding: { codec: 'json' },
        out_of_order_action: 'accept',
        labels: {
          source: 'pushify',
          kind: '{{ pushify.kind }}',
          project: '{{ pushify.project }}',
          environment: '{{ pushify.environment }}',
          service: '{{ pushify.service }}',
          server: '{{ pushify.server }}',
        },
        ...(basicOrBearer(drain) ? { auth: basicOrBearer(drain) } : {}),
      };
    case 'elastic': {
      const auth = drain.secret && drain.options.username
        ? { auth: { strategy: 'basic', user: drain.options.username, password: drain.secret } }
        : drain.secret
          ? { request: { headers: { Authorization: `ApiKey ${drain.secret}` } } }
          : {};
      return {
        type: 'elasticsearch',
        inputs,
        endpoints: [drain.endpoint],
        bulk: { index: drain.options.index ?? DEFAULT_ELASTIC_INDEX },
        ...auth,
      };
    }
    case 'datadog':
      return { type: 'datadog_logs', inputs, default_api_key: drain.secret, site: drain.options.site ?? DEFAULT_DATADOG_SITE };
    case 's3':
      return {
        type: 'aws_s3',
        inputs,
        bucket: drain.options.bucket,
        region: drain.options.region,
        ...(drain.endpoint ? { endpoint: drain.endpoint } : {}),
        key_prefix: `${drain.options.prefix ?? DEFAULT_S3_PREFIX}%Y/%m/%d/`,
        compression: 'gzip',
        encoding: { codec: 'json' },
        framing: { method: 'newline_delimited' },
        auth: { access_key_id: drain.options.accessKeyId, secret_access_key: drain.secret },
      };
  }
}

/** Whether this server's agent needs the container metrics sampler. */
export function agentNeedsContainerStats(drains: AgentDrain[]): boolean {
  return drains.some((d) => d.sendMetrics);
}

/**
 * The agent's Vector configuration (JSON) for one server. Every `$` is doubled: Vector would
 * otherwise read `$NAME` / `${NAME}` anywhere in the file — a credential or a regex included —
 * as an environment variable.
 */
export function buildVectorConfig(ctx: AgentContext): string {
  const drains = ctx.drains;
  const sources: Record<string, unknown> = {};
  const transforms: Record<string, unknown> = {};
  const sinks: Record<string, unknown> = {};

  const wantsLogs = drains.some((d) => d.sendLogs);
  const wantsContainerStats = agentNeedsContainerStats(drains);
  const wantsHostMetrics = drains.some((d) => d.sendMetrics && d.projectSlug === null);

  if (wantsLogs) {
    sources.pushify_container_logs = { type: 'docker_logs', include_containers: ['pushify-'], exclude_containers: [LOG_AGENT_CONTAINER] };
    transforms.pushify_logs = { type: 'remap', inputs: ['pushify_container_logs'], source: logsVrl(ctx), drop_on_abort: true, drop_on_error: true };
  }
  if (wantsContainerStats) {
    sources.pushify_container_stats_file = {
      type: 'file',
      include: [LOG_AGENT_STATS_FILE],
      read_from: 'end',
      fingerprint: { strategy: 'device_and_inode' },
    };
    transforms.pushify_container_stats = {
      type: 'remap',
      inputs: ['pushify_container_stats_file'],
      source: statsVrl(ctx),
      drop_on_abort: true,
      drop_on_error: true,
    };
  }
  if (wantsHostMetrics) {
    sources.pushify_host_metrics = {
      type: 'host_metrics',
      scrape_interval_secs: HOST_METRICS_INTERVAL_SECONDS,
      collectors: ['cpu', 'memory', 'load', 'network', 'disk', 'host'],
    };
    transforms.pushify_host_metrics_tagged = { type: 'remap', inputs: ['pushify_host_metrics'], source: hostMetricLabelsVrl(ctx) };
    if (drains.some((d) => d.sendMetrics && d.projectSlug === null && d.type !== 'datadog')) {
      transforms.pushify_host_metrics_as_logs = { type: 'metric_to_log', inputs: ['pushify_host_metrics_tagged'] };
      transforms.pushify_host_metrics_logs = { type: 'remap', inputs: ['pushify_host_metrics_as_logs'], source: hostMetricLogVrl(ctx) };
    }
  }

  drains.forEach((drain, i) => {
    const id = `drain_${i + 1}`;
    const onlyProject = (input: string, kind: 'logs' | 'stats'): string => {
      if (drain.projectSlug === null) return input;
      const name = `${id}_${kind}`;
      transforms[name] = { type: 'filter', inputs: [input], condition: `.pushify.project == "${drain.projectSlug}"` };
      return name;
    };

    const logInputs: string[] = [];
    if (drain.sendLogs) logInputs.push(onlyProject('pushify_logs', 'logs'));

    if (drain.sendMetrics && drain.type === 'datadog') {
      const stats = onlyProject('pushify_container_stats', 'stats');
      const metricsName = `${id}_container_metrics`;
      const tags = {
        project: '{{ pushify.project }}',
        environment: '{{ pushify.environment }}',
        service: '{{ pushify.service }}',
        server: '{{ pushify.server }}',
        container: '{{ container }}',
      };
      transforms[metricsName] = {
        type: 'log_to_metric',
        inputs: [stats],
        metrics: [
          { type: 'gauge', field: 'cpu_percent', name: 'container_cpu_percent', namespace: 'pushify', tags },
          { type: 'gauge', field: 'memory_percent', name: 'container_memory_percent', namespace: 'pushify', tags },
          { type: 'gauge', field: 'pids', name: 'container_pids', namespace: 'pushify', tags },
        ],
      };
      const metricInputs = [metricsName];
      if (drain.projectSlug === null) metricInputs.push('pushify_host_metrics_tagged');
      sinks[`${id}_metrics`] = {
        type: 'datadog_metrics',
        inputs: metricInputs,
        default_api_key: drain.secret,
        site: drain.options.site ?? DEFAULT_DATADOG_SITE,
      };
    } else if (drain.sendMetrics) {
      logInputs.push(onlyProject('pushify_container_stats', 'stats'));
      if (drain.projectSlug === null) logInputs.push('pushify_host_metrics_logs');
    }

    if (logInputs.length) sinks[id] = logSink(drain, logInputs);
  });

  const config = {
    data_dir: '/var/lib/vector',
    api: { enabled: false },
    sources,
    transforms,
    sinks,
  };
  return JSON.stringify(config, null, 2).replace(/\$/g, '$$$$');
}

// ── Commands run on the server ───────────────────────────────────────────────

function containerStatsScript(): string {
  return `#!/bin/sh
# Pushify log agent — samples docker stats of the Pushify containers for the agent. Generated.
OUT=${LOG_AGENT_STATS_FILE}
mkdir -p ${LOG_AGENT_STATS_DIR}
while true; do
  docker stats --no-stream --format '{{json .}}' 2>/dev/null | grep '"Name":"pushify-' >> "$OUT" || true
  if [ "$(wc -c < "$OUT" 2>/dev/null || echo 0)" -gt 5242880 ]; then mv -f "$OUT" "$OUT.1"; fi
  sleep ${STATS_INTERVAL_SECONDS}
done
`;
}

function containerStatsUnit(): string {
  return `[Unit]
Description=Pushify log agent container stats
After=docker.service
Wants=docker.service

[Service]
ExecStart=${STATS_SCRIPT}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

function removeStatsSampler(): string[] {
  return [
    `if [ -d /run/systemd/system ] && [ -f /etc/systemd/system/${STATS_UNIT} ]; then systemctl disable --now ${STATS_UNIT} >/dev/null 2>&1 || true; rm -f /etc/systemd/system/${STATS_UNIT}; systemctl daemon-reload; fi`,
    `rm -f ${STATS_SCRIPT}`,
  ];
}

/**
 * One shell command that installs or updates the agent: writes the new configuration to a
 * temporary directory, validates it with the agent image, and only then replaces the current one
 * and (re)starts the container — an invalid configuration leaves the running agent alone. File
 * content goes through base64, so nothing in it is read by the remote shell. Prints
 * `PUSHIFY_LOG_AGENT status=installed|unchanged` or `PUSHIFY_LOG_AGENT error=<code>`.
 */
export function installLogAgentCommand(config: string, withContainerStats: boolean): string {
  const lines = [
    'set -e',
    `command -v docker >/dev/null 2>&1 || { echo "${LOG_AGENT_MARKER} error=docker-missing"; exit 1; }`,
    `mkdir -p ${LOG_AGENT_DIR} ${LOG_AGENT_STATS_DIR}`,
    `chmod 700 ${LOG_AGENT_DIR}`,
    `exec 9>${LOG_AGENT_DIR}/.lock`,
    'command -v flock >/dev/null 2>&1 && flock -w 300 9 || true',
    'umask 077',
    `TMP=$(mktemp -d ${LOG_AGENT_DIR}/.new.XXXXXX)`,
    `echo ${b64(config)} | base64 -d > "$TMP/vector.json"`,
    `docker image inspect ${LOG_AGENT_IMAGE} >/dev/null 2>&1 || docker pull -q ${LOG_AGENT_IMAGE} >/dev/null 2>&1 || { rm -rf "$TMP"; echo "${LOG_AGENT_MARKER} error=image-pull-failed"; exit 1; }`,
    `if ! OUT=$(docker run --rm -v "$TMP/vector.json:/etc/vector/vector.json:ro" ${LOG_AGENT_IMAGE} validate --no-environment /etc/vector/vector.json 2>&1); then rm -rf "$TMP"; echo "${LOG_AGENT_MARKER} error=invalid-config"; printf '%s\\n' "$OUT" | tail -n 20; exit 1; fi`,
    'CHANGED=no',
    `cmp -s "$TMP/vector.json" ${LOG_AGENT_DIR}/vector.json || CHANGED=yes`,
    `mv -f "$TMP/vector.json" ${LOG_AGENT_DIR}/vector.json`,
    'rm -rf "$TMP"',
  ];
  if (withContainerStats) {
    lines.push(
      `echo ${b64(containerStatsScript())} | base64 -d > ${STATS_SCRIPT}`,
      `chmod 700 ${STATS_SCRIPT}`,
      `if [ -d /run/systemd/system ]; then echo ${b64(containerStatsUnit())} | base64 -d > /etc/systemd/system/${STATS_UNIT} && systemctl daemon-reload && systemctl enable ${STATS_UNIT} >/dev/null 2>&1 && systemctl restart ${STATS_UNIT}; else echo "${LOG_AGENT_MARKER} note=no-systemd-no-container-metrics"; fi`
    );
  } else {
    lines.push(...removeStatsSampler());
  }
  lines.push(
    `RUNNING=$(docker inspect -f '{{.State.Running}}' ${LOG_AGENT_CONTAINER} 2>/dev/null || echo false)`,
    'if [ "$CHANGED" = yes ] || [ "$RUNNING" != true ]; then',
    `  docker rm -f ${LOG_AGENT_CONTAINER} >/dev/null 2>&1 || true`,
    [
      `  docker run -d --name ${LOG_AGENT_CONTAINER} --restart unless-stopped --network host`,
      '-v /var/run/docker.sock:/var/run/docker.sock:ro',
      '-v /proc:/host/proc:ro -v /sys:/host/sys:ro -e PROCFS_ROOT=/host/proc -e SYSFS_ROOT=/host/sys',
      `-v ${LOG_AGENT_DIR}/vector.json:/etc/vector/vector.json:ro`,
      `-v ${LOG_AGENT_STATS_DIR}:${LOG_AGENT_STATS_DIR}:ro`,
      `-v ${LOG_AGENT_CONTAINER}_data:/var/lib/vector`,
      '--log-opt max-size=10m --log-opt max-file=2',
      `${LOG_AGENT_IMAGE} --config /etc/vector/vector.json >/dev/null`,
    ].join(' '),
    `  echo "${LOG_AGENT_MARKER} status=installed"`,
    'else',
    `  echo "${LOG_AGENT_MARKER} status=unchanged"`,
    'fi'
  );
  return lines.join('\n');
}

/** Stops and removes the agent and everything the install wrote. Prints `status=removed`. */
export function removeLogAgentCommand(): string {
  return [
    `docker rm -f ${LOG_AGENT_CONTAINER} >/dev/null 2>&1 || true`,
    `docker volume rm ${LOG_AGENT_CONTAINER}_data >/dev/null 2>&1 || true`,
    ...removeStatsSampler(),
    `rm -rf ${LOG_AGENT_DIR} ${LOG_AGENT_STATS_DIR}`,
    `echo "${LOG_AGENT_MARKER} status=removed"`,
  ].join('\n');
}

export type LogAgentSyncStatus = 'installed' | 'unchanged' | 'removed' | 'failed';

/** Reads the marker lines of an install / remove run. */
export function parseLogAgentOutput(stdout: string): { status: LogAgentSyncStatus | null; error: string | null; notes: string[] } {
  let status: LogAgentSyncStatus | null = null;
  let error: string | null = null;
  const notes: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(new RegExp(`^${LOG_AGENT_MARKER} (status|error|note)=(\\S+)$`));
    if (!m) continue;
    if (m[1] === 'status' && ['installed', 'unchanged', 'removed'].includes(m[2])) status = m[2] as LogAgentSyncStatus;
    if (m[1] === 'error') error = m[2];
    if (m[1] === 'note') notes.push(m[2]);
  }
  return { status: error ? 'failed' : status, error, notes };
}

// ── Connection test (sent from the API, not from the agent) ──────────────────

export interface DrainTestRequest {
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  body: string;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** AWS Signature Version 4 for one S3 request (headers given must include host). */
export function signS3Request(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): string {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const names = Object.keys(input.headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) lower[k.toLowerCase()] = v.trim();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const canonicalRequest = [input.method, input.url.pathname, query, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * The single request the connection test sends: one test log event in the format the agent uses
 * for that destination (an object under the prefix for S3).
 */
export function buildDrainTestRequest(drain: LogDrainSettings, secret: string | null, now: Date = new Date()): DrainTestRequest {
  const event = {
    message: 'Pushify log drain connection test',
    timestamp: now.toISOString(),
    pushify: { kind: 'test', project: '', environment: '', service: 'pushify', server: 'pushify-api' },
  };
  const json = (headers: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', ...headers });
  const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const auth = (): Record<string, string> =>
    !secret ? {} : drain.options.username ? { Authorization: basic(drain.options.username, secret) } : { Authorization: `Bearer ${secret}` };

  switch (drain.type) {
    case 'http':
      return { url: drain.endpoint!, method: 'POST', headers: json(auth()), body: JSON.stringify([event]) };
    case 'loki':
      return {
        url: `${drain.endpoint}/loki/api/v1/push`,
        method: 'POST',
        headers: json(auth()),
        body: JSON.stringify({
          streams: [{ stream: { source: 'pushify', kind: 'test' }, values: [[`${now.getTime()}000000`, JSON.stringify(event)]] }],
        }),
      };
    case 'elastic': {
      const headers: Record<string, string> = !secret
        ? {}
        : drain.options.username
          ? { Authorization: basic(drain.options.username, secret) }
          : { Authorization: `ApiKey ${secret}` };
      return {
        url: `${drain.endpoint}/${drain.options.index ?? DEFAULT_ELASTIC_INDEX}/_doc`,
        method: 'POST',
        headers: json(headers),
        body: JSON.stringify({ ...event, '@timestamp': event.timestamp }),
      };
    }
    case 'datadog':
      return {
        url: `https://http-intake.logs.${drain.options.site ?? DEFAULT_DATADOG_SITE}/api/v2/logs`,
        method: 'POST',
        headers: json({ 'DD-API-KEY': secret ?? '' }),
        body: JSON.stringify([{ ...event, ddsource: 'pushify', service: 'pushify' }]),
      };
    case 's3': {
      const key = `${drain.options.prefix ?? DEFAULT_S3_PREFIX}pushify-connection-test.json`;
      const encodedKey = key.split('/').map(encodeURIComponent).join('/');
      const url = drain.endpoint
        ? new URL(`${drain.endpoint}/${drain.options.bucket}/${encodedKey}`)
        : new URL(`https://${drain.options.bucket}.s3.${drain.options.region}.amazonaws.com/${encodedKey}`);
      const body = JSON.stringify(event);
      const payloadHash = sha256Hex(body);
      const headers: Record<string, string> = {
        host: url.host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
        'content-type': 'application/json',
      };
      headers.authorization = signS3Request({
        method: 'PUT',
        url,
        headers,
        payloadHash,
        region: drain.options.region!,
        accessKeyId: drain.options.accessKeyId!,
        secretAccessKey: secret ?? '',
        now,
      });
      delete headers.host;
      return { url: url.toString(), method: 'PUT', headers, body };
    }
  }
}
