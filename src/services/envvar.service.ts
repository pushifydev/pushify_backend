import { HTTPException } from 'hono/http-exception';
import { envVarRepository } from '../repositories/envvar.repository';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { encrypt, decrypt } from '../lib/encryption';
import { t, type SupportedLocale } from '../i18n';

type Environment = 'production' | 'staging' | 'development' | 'preview';

interface CreateEnvVarInput {
  key: string;
  value: string;
  environment?: Environment;
  isSecret?: boolean;
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
}

// Helper to mask secret values
function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return value.substring(0, 2) + '****' + value.substring(value.length - 2);
}

export const envVarService = {
  /**
   * Check if user has access to project
   */
  async checkProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    // Verify organization membership
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify project exists and belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId || project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

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

    const envVars = await envVarRepository.findByProject(projectId, environment);

    // Decrypt values and mask secrets
    return envVars.map((envVar) => {
      const decryptedValue = decrypt(envVar.valueEncrypted);
      return {
        id: envVar.id,
        projectId: envVar.projectId,
        environment: envVar.environment,
        key: envVar.key,
        value: envVar.isSecret ? maskValue(decryptedValue) : decryptedValue,
        isSecret: envVar.isSecret,
        createdAt: envVar.createdAt,
        updatedAt: envVar.updatedAt,
      };
    });
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

    const envVar = await envVarRepository.findById(envVarId);
    if (!envVar || envVar.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'envVars', 'notFound') });
    }

    const decryptedValue = decrypt(envVar.valueEncrypted);
    return {
      id: envVar.id,
      projectId: envVar.projectId,
      environment: envVar.environment,
      key: envVar.key,
      value: envVar.isSecret ? maskValue(decryptedValue) : decryptedValue,
      isSecret: envVar.isSecret,
      createdAt: envVar.createdAt,
      updatedAt: envVar.updatedAt,
    };
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
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

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
    });

    return {
      id: envVar.id,
      projectId: envVar.projectId,
      environment: envVar.environment,
      key: envVar.key,
      value: envVar.isSecret ? maskValue(input.value) : input.value,
      isSecret: envVar.isSecret,
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
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const environment = input.environment || 'production';
    const results: Array<{
      id: string;
      key: string;
      environment: string;
      isSecret: boolean;
      action: 'created' | 'updated';
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
        // Update existing
        await envVarRepository.update(existing.id, {
          valueEncrypted,
          isSecret: variable.isSecret,
        });
        results.push({
          id: existing.id,
          key: variable.key,
          environment,
          isSecret: variable.isSecret ?? false,
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
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const envVar = await envVarRepository.findById(envVarId);
    if (!envVar || envVar.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'envVars', 'notFound') });
    }

    const updateData: { valueEncrypted?: string; isSecret?: boolean } = {};

    if (input.value !== undefined) {
      updateData.valueEncrypted = encrypt(input.value);
    }

    if (input.isSecret !== undefined) {
      updateData.isSecret = input.isSecret;
    }

    const updated = await envVarRepository.update(envVarId, updateData);

    const decryptedValue = decrypt(updated!.valueEncrypted);
    return {
      id: updated!.id,
      projectId: updated!.projectId,
      environment: updated!.environment,
      key: updated!.key,
      value: updated!.isSecret ? maskValue(decryptedValue) : decryptedValue,
      isSecret: updated!.isSecret,
      createdAt: updated!.createdAt,
      updatedAt: updated!.updatedAt,
    };
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
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const envVar = await envVarRepository.findById(envVarId);
    if (!envVar || envVar.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'envVars', 'notFound') });
    }

    await envVarRepository.delete(envVarId);
  },
};
