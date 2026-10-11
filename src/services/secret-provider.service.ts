import { HTTPException } from 'hono/http-exception';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { secretProviderConnections } from '../db/schema/secret-providers';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { encrypt, decrypt } from '../lib/encryption';
import {
  fetchInfisicalSecrets,
  normalizeSecretPath,
  normalizeSiteUrl,
  validateInfisicalConnection,
  type InfisicalConnection,
} from '../lib/infisical';
import {
  DOPPLER_API_URL,
  fetchDopplerSecrets,
  validateDopplerConnection,
  type DopplerConnection,
} from '../lib/doppler';
import {
  hasSecretReferences,
  providerLabel,
  resolveSecretReferences,
  SUPPORTED_SECRET_PROVIDERS,
  type ResolvedEnv,
  type SecretProvider,
} from '../lib/secret-references';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

/**
 * External secret manager connections. Like registry credentials, only owners and admins
 * manage them: a machine identity that can read a team's secrets is not a per-member setting.
 * The client secret is write-only — it goes in on create and is only used by the deploy worker.
 */

type ConnectionRow = typeof secretProviderConnections.$inferSelect;

export interface PublicSecretProviderConnection {
  id: string;
  provider: string;
  projectId: string | null;
  siteUrl: string;
  clientId: string;
  workspaceId: string;
  environment: string;
  secretPath: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  /** Doppler only: project and config slugs (same values as workspaceId / environment) */
  project?: string;
  config?: string;
}

function toPublic(row: ConnectionRow): PublicSecretProviderConnection {
  const doppler = row.provider === 'doppler' ? { project: row.workspaceId, config: row.environment } : {};
  return {
    ...doppler,
    id: row.id,
    provider: row.provider,
    projectId: row.projectId,
    siteUrl: row.siteUrl,
    clientId: row.clientId,
    workspaceId: row.workspaceId,
    environment: row.environment,
    secretPath: row.secretPath,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

async function assertCanManage(organizationId: string, userId: string, locale: SupportedLocale) {
  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
  }
}

async function assertProjectInOrg(projectId: string, organizationId: string, locale: SupportedLocale) {
  const project = await projectRepository.findById(projectId);
  if (!project || project.organizationId !== organizationId || project.status === 'deleted') {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }
}

function scopeCondition(organizationId: string, projectId: string | null, provider: string) {
  return and(
    eq(secretProviderConnections.organizationId, organizationId),
    eq(secretProviderConnections.provider, provider),
    projectId ? eq(secretProviderConnections.projectId, projectId) : isNull(secretProviderConnections.projectId)
  );
}

export interface SecretProviderInput {
  provider?: string;
  projectId?: string | null;
  siteUrl?: string;
  clientId?: string;
  clientSecret?: string;
  workspaceId?: string;
  environment?: string;
  secretPath?: string;
  /** Doppler access token (service token, service account or personal token) */
  token?: string;
  /** Doppler project slug */
  project?: string;
  /** Doppler config slug */
  config?: string;
}

/**
 * A decrypted connection as the deploy worker uses it. Doppler rows reuse the table's columns:
 * `workspace_id` holds the Doppler project, `environment` the config and
 * `client_secret_encrypted` the token (see db/schema/secret-providers.ts).
 */
export type DeployConnection =
  | ({ provider: 'infisical'; id: string } & InfisicalConnection)
  | ({ provider: 'doppler'; id: string } & DopplerConnection);

type StoredValues = Pick<
  ConnectionRow,
  'siteUrl' | 'clientId' | 'clientSecretEncrypted' | 'workspaceId' | 'environment' | 'secretPath'
>;

function storedValues(provider: SecretProvider, input: SecretProviderInput): StoredValues {
  if (provider === 'doppler') {
    const problem = validateDopplerConnection(input);
    if (problem) throw new HTTPException(400, { message: problem });
    return {
      siteUrl: DOPPLER_API_URL,
      clientId: '',
      clientSecretEncrypted: encrypt(input.token!.trim()),
      workspaceId: input.project!.trim(),
      environment: input.config!.trim(),
      secretPath: '/',
    };
  }
  const problem = validateInfisicalConnection(input);
  if (problem) throw new HTTPException(400, { message: problem });
  return {
    siteUrl: normalizeSiteUrl(input.siteUrl),
    clientId: input.clientId!.trim(),
    clientSecretEncrypted: encrypt(input.clientSecret!),
    workspaceId: input.workspaceId!.trim(),
    environment: input.environment!.trim(),
    secretPath: normalizeSecretPath(input.secretPath),
  };
}

export const secretProviderService = {
  async list(organizationId: string, userId: string, locale: SupportedLocale = 'en') {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    const rows = await db
      .select()
      .from(secretProviderConnections)
      .where(eq(secretProviderConnections.organizationId, organizationId))
      .orderBy(desc(secretProviderConnections.createdAt));
    return rows.map(toPublic);
  },

  /** Add a connection, or replace the one stored for the same provider and scope. */
  async upsert(
    organizationId: string,
    userId: string,
    input: SecretProviderInput,
    locale: SupportedLocale = 'en'
  ): Promise<PublicSecretProviderConnection> {
    await assertCanManage(organizationId, userId, locale);

    const provider = (input.provider ?? 'infisical') as SecretProvider;
    if (!SUPPORTED_SECRET_PROVIDERS.includes(provider)) {
      throw new HTTPException(400, {
        message: `Unsupported provider; use one of: ${SUPPORTED_SECRET_PROVIDERS.join(', ')}`,
      });
    }
    const projectId = input.projectId || null;
    if (projectId) await assertProjectInOrg(projectId, organizationId, locale);

    const values = storedValues(provider, input);

    const [existing] = await db
      .select({ id: secretProviderConnections.id })
      .from(secretProviderConnections)
      .where(scopeCondition(organizationId, projectId, provider))
      .limit(1);

    const [row] = existing
      ? await db
          .update(secretProviderConnections)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(secretProviderConnections.id, existing.id))
          .returning()
      : await db
          .insert(secretProviderConnections)
          .values({ organizationId, projectId, provider, ...values })
          .returning();

    logger.info({ organizationId, projectId, provider }, 'Secret provider connection stored');
    return toPublic(row);
  },

  async remove(organizationId: string, userId: string, id: string, locale: SupportedLocale = 'en') {
    await assertCanManage(organizationId, userId, locale);
    const [row] = await db
      .delete(secretProviderConnections)
      .where(and(eq(secretProviderConnections.id, id), eq(secretProviderConnections.organizationId, organizationId)))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'Secret provider connection not found' });
    return { success: true };
  },

  /**
   * The connection a project's deploy uses for a provider, decrypted: the project's own, else
   * the organization's. Internal — never routed.
   */
  async connectionForDeploy(
    organizationId: string,
    projectId: string,
    provider: SecretProvider
  ): Promise<DeployConnection | null> {
    const [projectRow] = await db
      .select()
      .from(secretProviderConnections)
      .where(scopeCondition(organizationId, projectId, provider))
      .limit(1);
    const row =
      projectRow ??
      (
        await db
          .select()
          .from(secretProviderConnections)
          .where(scopeCondition(organizationId, null, provider))
          .limit(1)
      )[0];
    if (!row) return null;

    let clientSecret: string;
    try {
      clientSecret = decrypt(row.clientSecretEncrypted);
    } catch {
      const label = providerLabel(provider);
      const what = provider === 'doppler' ? 'token' : 'client secret';
      throw new Error(`the stored ${label} ${what} could not be decrypted — reconnect ${label}`);
    }
    if (provider === 'doppler') {
      return {
        provider: 'doppler',
        id: row.id,
        token: clientSecret,
        project: row.workspaceId,
        config: row.environment,
      };
    }
    return {
      provider: 'infisical',
      id: row.id,
      siteUrl: row.siteUrl,
      clientId: row.clientId,
      clientSecret,
      workspaceId: row.workspaceId,
      environment: row.environment,
      secretPath: row.secretPath,
    };
  },

  /**
   * Replace `{{infisical.KEY}}` references in a deploy's env with the values from Infisical.
   * The result lives only in the deploy worker's memory and the container's environment —
   * nothing is written back. Throws SecretReferenceError (a readable message, no values) when
   * a reference cannot be resolved, which fails the deploy.
   */
  async resolveDeployEnv(
    organizationId: string,
    projectId: string,
    envVars: Record<string, string>
  ): Promise<ResolvedEnv> {
    if (!hasSecretReferences(envVars)) {
      return { envVars, resolvedValues: [], resolvedKeys: [] };
    }
    const usedConnections: string[] = [];
    const resolved = await resolveSecretReferences(envVars, async (provider) => {
      const connection = await secretProviderService.connectionForDeploy(organizationId, projectId, provider);
      if (!connection) {
        throw new Error(`no ${providerLabel(provider)} connection is set up for this project or organization`);
      }
      usedConnections.push(connection.id);
      return connection.provider === 'doppler'
        ? fetchDopplerSecrets(connection)
        : fetchInfisicalSecrets(connection);
    });
    for (const id of usedConnections) {
      db.update(secretProviderConnections)
        .set({ lastUsedAt: new Date() })
        .where(eq(secretProviderConnections.id, id))
        .catch(() => undefined);
    }
    return resolved;
  },
};
