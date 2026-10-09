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
  hasSecretReferences,
  resolveSecretReferences,
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
}

function toPublic(row: ConnectionRow): PublicSecretProviderConnection {
  return {
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

    const provider = input.provider ?? 'infisical';
    if (provider !== 'infisical') {
      throw new HTTPException(400, { message: 'Only the "infisical" provider is supported' });
    }
    const projectId = input.projectId || null;
    if (projectId) await assertProjectInOrg(projectId, organizationId, locale);

    const problem = validateInfisicalConnection(input);
    if (problem) throw new HTTPException(400, { message: problem });

    const values = {
      siteUrl: normalizeSiteUrl(input.siteUrl),
      clientId: input.clientId!.trim(),
      clientSecretEncrypted: encrypt(input.clientSecret!),
      workspaceId: input.workspaceId!.trim(),
      environment: input.environment!.trim(),
      secretPath: normalizeSecretPath(input.secretPath),
    };

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
  ): Promise<(InfisicalConnection & { id: string }) | null> {
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
      throw new Error('the stored Infisical client secret could not be decrypted — reconnect Infisical');
    }
    return {
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
        throw new Error('no Infisical connection is set up for this project or organization');
      }
      usedConnections.push(connection.id);
      return fetchInfisicalSecrets(connection);
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
