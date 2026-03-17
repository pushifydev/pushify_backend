import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { environmentVariables } from '../db/schema/projects';

type Environment = 'production' | 'staging' | 'development' | 'preview';

interface CreateEnvVarInput {
  projectId: string;
  environment: Environment;
  key: string;
  valueEncrypted: string;
  isSecret?: boolean;
}

interface UpdateEnvVarInput {
  valueEncrypted?: string;
  isSecret?: boolean;
}

export const envVarRepository = {
  /**
   * Find environment variable by ID
   */
  async findById(id: string) {
    const result = await db
      .select()
      .from(environmentVariables)
      .where(eq(environmentVariables.id, id))
      .limit(1);
    return result[0] || null;
  },

  /**
   * Find all environment variables for a project
   */
  async findByProject(projectId: string, environment?: Environment) {
    if (environment) {
      return db
        .select()
        .from(environmentVariables)
        .where(
          and(
            eq(environmentVariables.projectId, projectId),
            eq(environmentVariables.environment, environment)
          )
        )
        .orderBy(environmentVariables.key);
    }

    return db
      .select()
      .from(environmentVariables)
      .where(eq(environmentVariables.projectId, projectId))
      .orderBy(environmentVariables.key);
  },

  /**
   * Find environment variable by project, environment and key
   */
  async findByKey(projectId: string, environment: Environment, key: string) {
    const result = await db
      .select()
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.projectId, projectId),
          eq(environmentVariables.environment, environment),
          eq(environmentVariables.key, key)
        )
      )
      .limit(1);
    return result[0] || null;
  },

  /**
   * Create new environment variable
   */
  async create(input: CreateEnvVarInput) {
    const result = await db
      .insert(environmentVariables)
      .values({
        projectId: input.projectId,
        environment: input.environment,
        key: input.key,
        valueEncrypted: input.valueEncrypted,
        isSecret: input.isSecret ?? false,
      })
      .returning();
    return result[0];
  },

  /**
   * Create multiple environment variables
   */
  async createMany(inputs: CreateEnvVarInput[]) {
    if (inputs.length === 0) return [];

    const result = await db
      .insert(environmentVariables)
      .values(
        inputs.map((input) => ({
          projectId: input.projectId,
          environment: input.environment,
          key: input.key,
          valueEncrypted: input.valueEncrypted,
          isSecret: input.isSecret ?? false,
        }))
      )
      .returning();
    return result;
  },

  /**
   * Update environment variable
   */
  async update(id: string, input: UpdateEnvVarInput) {
    const result = await db
      .update(environmentVariables)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(environmentVariables.id, id))
      .returning();
    return result[0] || null;
  },

  /**
   * Delete environment variable
   */
  async delete(id: string) {
    await db.delete(environmentVariables).where(eq(environmentVariables.id, id));
  },

  /**
   * Delete all environment variables for a project in an environment
   */
  async deleteByProjectAndEnvironment(projectId: string, environment: Environment) {
    await db
      .delete(environmentVariables)
      .where(
        and(
          eq(environmentVariables.projectId, projectId),
          eq(environmentVariables.environment, environment)
        )
      );
  },
};
