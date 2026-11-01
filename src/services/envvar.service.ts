import { HTTPException } from 'hono/http-exception';
import { envVarRepository } from '../repositories/envvar.repository';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { encrypt, decrypt } from '../lib/encryption';
import { t, type SupportedLocale } from '../i18n';
import { assertMemberProjectScope } from '../lib/member-project-scope';
import type { environmentVariables } from '../db/schema/projects';

type Environment = 'production' | 'staging' | 'development' | 'preview';

interface CreateEnvVarInput {
  key: string;
  value: string;
  environment?: Environment;
  isSecret?: boolean;
  locked?: boolean;
}

interface BulkCreateInput {
  variables: Array<{
    key: string;
    value: string;
    isSecret?: boolean;
  }>;
  environment?: Environment;
}

interface UpdateEnvVarInput {
  value?: string;
  isSecret?: boolean;
  locked?: boolean;
}

type EnvVarRow = typeof environmentVariables.$inferSelect;

/** Returned in place of a value the reader's role may not see. */
const WITHHELD = '****';

// Helper to mask secret values
function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return value.substring(0, 2) + '****' + value.substring(value.length - 2);
}

/** Owners and admins are the only roles that read or change a locked (admin-only) variable. */
function canManageLocked(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/** No value at all for this reader: viewers for every variable, members for locked ones. */
function isWithheld(locked: boolean, role: string): boolean {
  return role === 'viewer' || (locked && !canManageLocked(role));
}

/**
 * What a reader sees of a value: viewers see names only (every value is ****, nothing of the
 * secret leaks), and so do members for a locked variable; others see plain values and secrets as
 * their first/last two characters. A withheld value is not decrypted.
 */
function displayValue(envVar: EnvVarRow, role: string): string {
  if (isWithheld(envVar.locked, role)) return WITHHELD;
  const decrypted = decrypt(envVar.valueEncrypted);
  return envVar.isSecret ? maskValue(decrypted) : decrypted;
}

/** A variable as returned to `role`; `masked` is true when the value was withheld. */
function toResponse(envVar: EnvVarRow, role: string) {
  return {
    id: envVar.id,
    projectId: envVar.projectId,
    environment: envVar.environment,
    key: envVar.key,
    value: displayValue(envVar, role),
    isSecret: envVar.isSecret,
    locked: envVar.locked,
    masked: isWithheld(envVar.locked, role),
    createdAt: envVar.createdAt,
    updatedAt: envVar.updatedAt,
  };
}

function adminRequired(locale: SupportedLocale): HTTPException {
  return new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
}

async function readerRole(organizationId: string, userId: string): Promise<string> {
  return (await organizationRepository.findMember(organizationId, userId))?.role ?? 'viewer';
}

export const envVarService = {
  /**
   * Check if user has access to project
   */
  async checkProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
    requireWrite = false
  ) {
    // Verify organization membership
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Writes (create/update/delete) require a non-viewer role — viewer is read-only (M-3).
    if (requireWrite && !['owner', 'admin', 'member'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    // Verify project exists and belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId || project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    await assertMemberProjectScope(membership, organizationId, userId, projectId, locale);

    return project;
  },

  /**
   * Get all environment variables for a project
   */
  async getByProject(
    projectId: string,
    organizationId: string,
    userId: string,
    environment: Environment | undefined,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);
    const role = await readerRole(organizationId, userId);

    const envVars = await envVarRepository.findByProject(projectId, environment);

    // Decrypt values and mask secrets
    return envVars.map((envVar) => toResponse(envVar, role));
  },

  /**
   * Get single environment variable (with decrypted value)
   */
  async getById(
    envVarId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);
    const role = await readerRole(organizationId, userId);

    const envVar = await envVarRepository.findById(envVarId);
    if (!envVar || envVar.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'envVars', 'notFound') });
    }

    return toResponse(envVar, role);
  },

  /**
   * Create new environment variable
   */
  async create(
    projectId: string,
    organizationId: string,
    userId: string,
    input: CreateEnvVarInput,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale, true);

    // Only owners/admins create a locked (admin-only) variable.
    if (input.locked && !canManageLocked(await readerRole(organizationId, userId))) {
      throw adminRequired(locale);
    }

    const environment = input.environment || 'production';

    // Check if key already exists in this environment
    const existing = await envVarRepository.findByKey(projectId, environment, input.key);
    if (existing) {
      throw new HTTPException(409, { message: t(locale, 'envVars', 'keyExists') });
    }

    // Validate key format (alphanumeric and underscore only)
    if (!/^[A-Z][A-Z0-9_]*$/.test(input.key)) {
      throw new HTTPException(400, { message: t(locale, 'envVars', 'invalidKeyFormat') });
    }

    // Encrypt value
    const valueEncrypted = encrypt(input.value);

    const envVar = await envVarRepository.create({
      projectId,
      environment,
      key: input.key,
      valueEncrypted,
      isSecret: input.isSecret,
      locked: input.locked,
    });

    return {
      id: envVar.id,
      projectId: envVar.projectId,
      environment: envVar.environment,
      key: envVar.key,
      value: envVar.isSecret ? maskValue(input.value) : input.value,
      isSecret: envVar.isSecret,
      locked: envVar.locked,
      masked: false,
      createdAt: envVar.createdAt,
      updatedAt: envVar.updatedAt,
    };
  },

  /**
   * Bulk create/update environment variables
   */
  async bulkCreate(
    projectId: string,
    organizationId: string,
    userId: string,
    input: BulkCreateInput,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale, true);
    const manageLocked = canManageLocked(await readerRole(organizationId, userId));

    const environment = input.environment || 'production';

    // A locked variable is changed by owners/admins only. Checked for every key before anything is
    // written, so a refused push changes nothing. The withheld placeholder a member gets back from
    // a read is not a change and is skipped below.
    if (!manageLocked) {
      for (const variable of input.variables) {
        const existing = await envVarRepository.findByKey(projectId, environment, variable.key);
        if (existing?.locked && variable.value !== WITHHELD) throw adminRequired(locale);
      }
    }

    const results: Array<{
      id: string;
      key: string;
      environment: string;
      isSecret: boolean;
      action: 'created' | 'updated' | 'unchanged';
    }> = [];

    for (const variable of input.variables) {
      // Validate key format
      if (!/^[A-Z][A-Z0-9_]*$/.test(variable.key)) {
        throw new HTTPException(400, {
          message: `${t(locale, 'envVars', 'invalidKeyFormat')}: ${variable.key}`,
        });
      }

      const existing = await envVarRepository.findByKey(projectId, environment, variable.key);
      const valueEncrypted = encrypt(variable.value);

      if (existing) {
        if (existing.locked && !manageLocked) {
          results.push({ id: existing.id, key: variable.key, environment, isSecret: existing.isSecret, action: 'unchanged' });
          continue;
        }
        // `pushify env pull` writes secrets masked; pushing that file back must not replace the
        // real secret with its mask. An unchanged mask leaves the variable as it is.
        if (existing.isSecret && variable.value === maskValue(decrypt(existing.valueEncrypted))) {
          results.push({ id: existing.id, key: variable.key, environment, isSecret: true, action: 'unchanged' });
          continue;
        }
        // isSecret is only changed when the request says so; otherwise the variable keeps it.
        const updated = await envVarRepository.update(existing.id, {
          valueEncrypted,
          ...(variable.isSecret !== undefined ? { isSecret: variable.isSecret } : {}),
        });
        results.push({
          id: existing.id,
          key: variable.key,
          environment,
          isSecret: updated?.isSecret ?? existing.isSecret,
          action: 'updated',
        });
      } else {
        // Create new
        const envVar = await envVarRepository.create({
          projectId,
          environment,
          key: variable.key,
          valueEncrypted,
          isSecret: variable.isSecret,
        });
        results.push({
          id: envVar.id,
          key: variable.key,
          environment,
          isSecret: variable.isSecret ?? false,
          action: 'created',
        });
      }
    }

    return results;
  },

  /**
   * Update environment variable
   */
  async update(
    envVarId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    input: UpdateEnvVarInput,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale, true);

    const envVar = await envVarRepository.findById(envVarId);
    if (!envVar || envVar.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'envVars', 'notFound') });
    }

    // A locked variable, and the lock itself, are changed by owners/admins only.
    const role = await readerRole(organizationId, userId);
    const changesLock = input.locked !== undefined && input.locked !== envVar.locked;
    if ((envVar.locked || changesLock) && !canManageLocked(role)) {
      throw adminRequired(locale);
    }

    const updateData: { valueEncrypted?: string; isSecret?: boolean; locked?: boolean } = {};

    if (input.value !== undefined) {
      updateData.valueEncrypted = encrypt(input.value);
    }

    if (input.isSecret !== undefined) {
      updateData.isSecret = input.isSecret;
    }

    if (input.locked !== undefined) {
      updateData.locked = input.locked;
    }

    const updated = await envVarRepository.update(envVarId, updateData);

    return toResponse(updated!, role);
  },

  /**
   * Delete environment variable
   */
  async delete(
    envVarId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale, true);

    const envVar = await envVarRepository.findById(envVarId);
    if (!envVar || envVar.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'envVars', 'notFound') });
    }

    if (envVar.locked && !canManageLocked(await readerRole(organizationId, userId))) {
      throw adminRequired(locale);
    }

    await envVarRepository.delete(envVarId);
  },

  async cloneEnvironment(
    projectId: string,
    organizationId: string,
    userId: string,
    sourceEnv: Environment,
    targetEnv: Environment,
    overwrite: boolean = false,
    locale?: SupportedLocale,
  ): Promise<{ copied: number; skipped: number; overwritten: number }> {
    await this.checkProjectAccess(projectId, organizationId, userId, locale as SupportedLocale, true);
    const manageLocked = canManageLocked(await readerRole(organizationId, userId));

    // Get source env vars
    const sourceVars = await envVarRepository.findByProject(projectId, sourceEnv);
    if (sourceVars.length === 0) {
      return { copied: 0, skipped: 0, overwritten: 0 };
    }

    // Get existing target env vars
    const targetVars = await envVarRepository.findByProject(projectId, targetEnv);
    const targetKeyMap = new Map(targetVars.map((v) => [v.key, v]));

    let copied = 0;
    let skipped = 0;
    let overwritten = 0;

    for (const srcVar of sourceVars) {
      const existingTarget = targetKeyMap.get(srcVar.key);
      // Below owner/admin, a locked variable is neither copied nor overwritten: it is skipped.
      if (!manageLocked && (srcVar.locked || existingTarget?.locked)) {
        skipped++;
        continue;
      }
      const decryptedValue = decrypt(srcVar.valueEncrypted);

      if (existingTarget) {
        if (overwrite) {
          await envVarRepository.update(existingTarget.id, {
            valueEncrypted: encrypt(decryptedValue),
            isSecret: srcVar.isSecret,
            locked: srcVar.locked,
          });
          overwritten++;
        } else {
          skipped++;
        }
      } else {
        await envVarRepository.create({
          projectId,
          key: srcVar.key,
          valueEncrypted: encrypt(decryptedValue),
          environment: targetEnv,
          isSecret: srcVar.isSecret,
          locked: srcVar.locked,
        });
        copied++;
      }
    }

    return { copied, skipped, overwritten };
  },
};
