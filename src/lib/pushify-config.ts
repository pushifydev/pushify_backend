import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { validateCronExpression, isValidTimezone, nextCronRun } from './cron-schedule';
import { validateVolumeName, validateContainerPath } from './volume-validate';
import { validateWorkerName, validateWorkerCommand, MAX_WORKERS_PER_PROJECT } from './worker-validate';

/**
 * Config-as-code: a `pushify.yaml` at the repo root (or project root directory)
 * declares build/runtime settings, cron jobs and volumes. The file WINS over
 * dashboard settings when present — the repo is the source of truth. Secrets are
 * deliberately unsupported here (env vars stay in the dashboard, encrypted).
 * A malformed file never breaks a deploy: it is reported and ignored.
 */

const cronItemSchema = z.object({
  name: z.string().min(1).max(255),
  schedule: z.string().min(9).max(100),
  command: z.string().min(1).max(2000),
  timezone: z.string().max(64).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
});

const volumeItemSchema = z.object({
  name: z.string().min(1).max(32),
  path: z.string().min(2).max(255),
});

const workerItemSchema = z.object({
  name: z.string().min(1).max(40),
  command: z.string().min(1).max(1000),
});

const fileSchema = z
  .object({
    build: z.string().min(1).max(1000).optional(),
    install: z.string().min(1).max(1000).optional(),
    start: z.string().min(1).max(1000).optional(),
    output: z.string().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    framework: z.string().min(1).max(50).optional(),
    cron: z.array(cronItemSchema).max(20).optional(),
    volumes: z.array(volumeItemSchema).max(10).optional(),
    workers: z.array(workerItemSchema).max(MAX_WORKERS_PER_PROJECT).optional(),
  })
  .strict();

export type PushifyFileConfig = z.infer<typeof fileSchema>;

export interface LoadedPushifyConfig {
  config: PushifyFileConfig | null;
  /** Which file was used, relative to the clone root */
  source: string | null;
  /** Human-readable problems (parse/validation) — deploy continues without the file */
  error: string | null;
}

const FILE_NAMES = ['pushify.yaml', 'pushify.yml'];

/** Deep validation beyond shape: cron expressions, timezones, volume names/paths. */
export function validatePushifyConfig(config: PushifyFileConfig): string | null {
  for (const item of config.cron ?? []) {
    const scheduleError = validateCronExpression(item.schedule, item.timezone ?? 'UTC');
    if (scheduleError) return `cron "${item.name}": ${scheduleError}`;
    if (item.timezone && !isValidTimezone(item.timezone)) {
      return `cron "${item.name}": invalid timezone "${item.timezone}"`;
    }
  }
  const seenCron = new Set<string>();
  for (const item of config.cron ?? []) {
    if (seenCron.has(item.name)) return `duplicate cron name "${item.name}"`;
    seenCron.add(item.name);
  }
  for (const vol of config.volumes ?? []) {
    const nameError = validateVolumeName(vol.name);
    if (nameError) return `volume "${vol.name}": ${nameError}`;
    const pathError = validateContainerPath(vol.path);
    if (pathError) return `volume "${vol.name}": ${pathError}`;
  }
  const seenVol = new Set<string>();
  for (const vol of config.volumes ?? []) {
    if (seenVol.has(vol.name)) return `duplicate volume name "${vol.name}"`;
    seenVol.add(vol.name);
  }
  const seenWorker = new Set<string>();
  for (const worker of config.workers ?? []) {
    const nameError = validateWorkerName(worker.name);
    if (nameError) return `worker "${worker.name}": ${nameError}`;
    const commandError = validateWorkerCommand(worker.command);
    if (commandError) return `worker "${worker.name}": ${commandError}`;
    if (seenWorker.has(worker.name)) return `duplicate worker name "${worker.name}"`;
    seenWorker.add(worker.name);
  }
  return null;
}

export function parsePushifyConfig(content: string): { config: PushifyFileConfig | null; error: string | null } {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    return { config: null, error: `invalid YAML: ${err instanceof Error ? err.message.split('\n')[0] : 'parse error'}` };
  }
  if (raw === null || raw === undefined) return { config: null, error: 'file is empty' };

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      config: null,
      error: `${first.path.join('.') || 'root'}: ${first.message}`,
    };
  }
  const deepError = validatePushifyConfig(parsed.data);
  if (deepError) return { config: null, error: deepError };
  return { config: parsed.data, error: null };
}

/** Look for pushify.yaml in the project's root directory first, then the repo root. */
export async function loadPushifyConfig(
  workDir: string,
  rootDirectory?: string
): Promise<LoadedPushifyConfig> {
  const candidates: string[] = [];
  if (rootDirectory && rootDirectory !== '.' && rootDirectory !== '/') {
    for (const name of FILE_NAMES) candidates.push(path.join(rootDirectory, name));
  }
  for (const name of FILE_NAMES) candidates.push(name);

  for (const relative of candidates) {
    const absolute = path.join(workDir, relative);
    let content: string;
    try {
      content = await readFile(absolute, 'utf-8');
    } catch {
      continue; // not present — try next candidate
    }
    const { config, error } = parsePushifyConfig(content);
    return { config, source: relative, error };
  }
  return { config: null, source: null, error: null };
}

/** One-line summary of what the file overrides, for the deploy log. */
export function describeOverrides(config: PushifyFileConfig): string {
  const parts: string[] = [];
  if (config.build) parts.push('build');
  if (config.install) parts.push('install');
  if (config.start) parts.push('start');
  if (config.output) parts.push('output');
  if (config.port) parts.push(`port ${config.port}`);
  if (config.framework) parts.push(`framework ${config.framework}`);
  if (config.cron?.length) parts.push(`${config.cron.length} cron`);
  if (config.volumes?.length) parts.push(`${config.volumes.length} volume(s)`);
  if (config.workers?.length) parts.push(`${config.workers.length} worker(s)`);
  return parts.join(', ');
}

export { nextCronRun };
