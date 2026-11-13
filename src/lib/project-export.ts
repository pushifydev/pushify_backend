import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { z } from '@hono/zod-openapi';
import { COMPOSE_PULL_POLICIES } from './compose-pull';

/**
 * A project's settings as a portable bundle, to recreate it on another Pushify instance
 * (self-hosted ↔ managed, or between two self-hosted ones). Only definitions travel: build and
 * start settings, environment variables, custom domains, scheduled tasks, workers, volume mounts
 * and the compose setup. Nothing instance-bound does — ids, servers, the slug, the webhook
 * secret, auto-generated subdomains, deploy history. Volume and database *data* stay behind: the
 * bundle lists linked databases with the backup/import endpoints that move their data.
 *
 * Secret variables are left out by default. With a passphrase they are encrypted
 * (scrypt → AES-256-GCM) — the instance's own ENCRYPTION_KEY never leaves it, so the passphrase
 * is the only thing the other instance needs.
 */
export const PROJECT_EXPORT_FORMAT = 'pushify.project/v1';
export const PROJECT_EXPORT_MIN_PASSPHRASE = 12;

const CIPHER = 'aes-256-gcm';
const SCRYPT_ALGORITHM = 'scrypt-aes-256-gcm';

export const ExportedEnvVarSchema = z.object({
  key: z.string().min(1).max(255),
  environment: z.enum(['production', 'staging', 'development', 'preview']),
  isSecret: z.boolean(),
  locked: z.boolean(),
  /** Plain value; null when it was left out (a secret without passphrase, or withheld from the exporter) */
  value: z.string().nullable(),
  /** Set instead of `value` for a secret exported with a passphrase */
  valueEncrypted: z.string().optional(),
});

export const ProjectExportBundleSchema = z
  .object({
    format: z.literal(PROJECT_EXPORT_FORMAT),
    exportedAt: z.string(),
    source: z.object({ projectName: z.string(), apiUrl: z.string().nullable() }),
    project: z.object({
      name: z.string().min(1).max(255),
      description: z.string().nullable(),
      gitRepoUrl: z.string().nullable(),
      gitBranch: z.string().nullable(),
      stagingBranch: z.string().nullable(),
      gitProvider: z.string().nullable(),
      installCommand: z.string().nullable(),
      buildCommand: z.string().nullable(),
      startCommand: z.string().nullable(),
      outputDirectory: z.string().nullable(),
      rootDirectory: z.string().nullable(),
      dockerfilePath: z.string().nullable(),
      dockerImage: z.string().nullable(),
      composePath: z.string().nullable(),
      composeService: z.string().nullable(),
      composePort: z.number().int().nullable(),
      composePullPolicy: z.enum(COMPOSE_PULL_POLICIES),
      port: z.number().int().nullable(),
      autoDeploy: z.boolean(),
      replicas: z.number().int(),
      autoscaleEnabled: z.boolean(),
      autoscaleMin: z.number().int(),
      autoscaleMax: z.number().int(),
      autoscaleObserveOnly: z.boolean(),
      sleepEnabled: z.boolean(),
      sleepAfterMinutes: z.number().int(),
    }),
    secrets: z.object({
      mode: z.enum(['excluded', 'encrypted']),
      algorithm: z.literal(SCRYPT_ALGORITHM).optional(),
      salt: z.string().optional(),
    }),
    envVars: z.array(ExportedEnvVarSchema),
    domains: z.array(
      z.object({
        domain: z.string(),
        isPrimary: z.boolean(),
        environment: z.string(),
        nginxSettings: z.record(z.string(), z.unknown()).nullable(),
      })
    ),
    scheduledTasks: z.array(
      z.object({
        name: z.string(),
        type: z.enum(['command', 'http']),
        schedule: z.string(),
        timezone: z.string(),
        command: z.string().nullable(),
        httpUrl: z.string().nullable(),
        timeoutSeconds: z.number().int(),
        enabled: z.boolean(),
      })
    ),
    workers: z.array(z.object({ name: z.string(), command: z.string(), enabled: z.boolean() })),
    volumes: z.array(z.object({ name: z.string(), containerPath: z.string() })),
    databases: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        envVarName: z.string(),
        /** Endpoints that move the data: back up and download here, import there */
        dataMigration: z.string(),
      })
    ),
  })
  .openapi('ProjectExportBundle');

export type ProjectExportBundle = z.infer<typeof ProjectExportBundleSchema>;
export type ExportedEnvVar = z.infer<typeof ExportedEnvVarSchema>;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

/** A per-bundle key: one random salt, so the (slow) derivation runs once per export. */
export function createSecretSealer(passphrase: string) {
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  return {
    salt: salt.toString('hex'),
    seal(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv(CIPHER, key, iv);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
    },
  };
}

/** Throws when the passphrase is wrong or the value was tampered with (GCM auth tag). */
export function createSecretOpener(passphrase: string, saltHex: string) {
  const key = deriveKey(passphrase, Buffer.from(saltHex, 'hex'));
  return {
    open(sealed: string): string {
      const [ivHex, tagHex, dataHex] = sealed.split(':');
      if (!ivHex || !tagHex || dataHex === undefined) throw new Error('Invalid encrypted value');
      const decipher = createDecipheriv(CIPHER, key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    },
  };
}

export interface ExportSourceEnvVar {
  key: string;
  environment: ExportedEnvVar['environment'];
  isSecret: boolean;
  locked: boolean;
  /** Decrypted value; null when the exporter may not read it */
  value: string | null;
}

export interface BuildProjectExportInput {
  project: ProjectExportBundle['project'];
  envVars: ExportSourceEnvVar[];
  domains: Array<ProjectExportBundle['domains'][number] & { isAutoGenerated: boolean }>;
  scheduledTasks: ProjectExportBundle['scheduledTasks'];
  workers: ProjectExportBundle['workers'];
  volumes: ProjectExportBundle['volumes'];
  databases: Array<{ id: string; name: string; type: string; envVarName: string }>;
  apiUrl: string | null;
  /** Encrypt secret variables with it; without one they are left out */
  passphrase?: string;
  now?: Date;
}

export function buildProjectExport(input: BuildProjectExportInput): ProjectExportBundle {
  const sealer = input.passphrase ? createSecretSealer(input.passphrase) : null;

  const envVars = input.envVars.map((v): ExportedEnvVar => {
    const base = { key: v.key, environment: v.environment, isSecret: v.isSecret, locked: v.locked };
    if (v.value === null) return { ...base, value: null };
    if (!v.isSecret) return { ...base, value: v.value };
    return sealer ? { ...base, value: null, valueEncrypted: sealer.seal(v.value) } : { ...base, value: null };
  });

  return {
    format: PROJECT_EXPORT_FORMAT,
    exportedAt: (input.now ?? new Date()).toISOString(),
    source: { projectName: input.project.name, apiUrl: input.apiUrl },
    project: input.project,
    secrets: sealer ? { mode: 'encrypted', algorithm: SCRYPT_ALGORITHM, salt: sealer.salt } : { mode: 'excluded' },
    envVars,
    // An auto-generated subdomain belongs to this instance's base domain; the target makes its own.
    domains: input.domains
      .filter((d) => !d.isAutoGenerated)
      .map(({ domain, isPrimary, environment, nginxSettings }) => ({ domain, isPrimary, environment, nginxSettings })),
    scheduledTasks: input.scheduledTasks,
    workers: input.workers,
    volumes: input.volumes,
    databases: input.databases.map((d) => ({
      name: d.name,
      type: d.type,
      envVarName: d.envVarName,
      dataMigration:
        `Create a backup (POST /api/v1/databases/${d.id}/backups), download it ` +
        `(GET /api/v1/databases/${d.id}/backups/{backupId}/download), then import it into a database ` +
        'on the target instance (POST /api/v1/databases/{id}/imports) and link it to the project.',
    })),
  };
}

/**
 * The variables to create on import, in the order of the bundle. A secret without a value
 * (left out at export, or encrypted and no passphrase given) is reported as skipped.
 */
export function resolveImportedEnvVars(
  bundle: ProjectExportBundle,
  passphrase?: string
): { variables: Array<Omit<ExportSourceEnvVar, 'value'> & { value: string }>; skipped: Array<{ key: string; environment: string; reason: string }> } {
  let opener: ReturnType<typeof createSecretOpener> | null = null;
  const hasEncrypted = bundle.envVars.some((v) => v.valueEncrypted);
  if (hasEncrypted && passphrase) {
    if (bundle.secrets.mode !== 'encrypted' || !bundle.secrets.salt) {
      throw new Error('The bundle has encrypted values but no encryption parameters');
    }
    opener = createSecretOpener(passphrase, bundle.secrets.salt);
  }

  const variables: Array<Omit<ExportSourceEnvVar, 'value'> & { value: string }> = [];
  const skipped: Array<{ key: string; environment: string; reason: string }> = [];
  for (const v of bundle.envVars) {
    const base = { key: v.key, environment: v.environment, isSecret: v.isSecret, locked: v.locked };
    if (v.value !== null) {
      variables.push({ ...base, value: v.value });
    } else if (v.valueEncrypted && opener) {
      try {
        variables.push({ ...base, value: opener.open(v.valueEncrypted) });
      } catch {
        // GCM fails on the first value for a wrong passphrase; nothing may be half-imported.
        throw new Error('The passphrase does not match the one the bundle was exported with');
      }
    } else {
      skipped.push({
        key: v.key,
        environment: v.environment,
        reason: v.valueEncrypted ? 'Encrypted; no passphrase given' : 'Value not included in the export',
      });
    }
  }
  return { variables, skipped };
}
