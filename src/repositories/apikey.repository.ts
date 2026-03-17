import { eq, and, desc, isNull } from 'drizzle-orm';
import { db } from '../db';
import { apiKeys, type ApiKey, type NewApiKey } from '../db/schema';

export const apiKeyRepository = {
  // Create a new API key
  async create(data: NewApiKey): Promise<ApiKey> {
    const [apiKey] = await db.insert(apiKeys).values(data).returning();
    return apiKey;
  },

  // Find API key by ID
  async findById(id: string): Promise<ApiKey | undefined> {
    return db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, id),
    });
  },

  // Find API key by hash (for authentication)
  async findByHash(keyHash: string): Promise<ApiKey | undefined> {
    return db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.keyHash, keyHash),
        eq(apiKeys.isActive, true),
        isNull(apiKeys.revokedAt)
      ),
    });
  },

  // Find all API keys for a user in an organization
  async findByUserAndOrg(userId: string, organizationId: string): Promise<ApiKey[]> {
    return db.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.organizationId, organizationId),
        isNull(apiKeys.revokedAt)
      ),
      orderBy: [desc(apiKeys.createdAt)],
    });
  },

  // Find all API keys for an organization
  async findByOrganization(organizationId: string): Promise<ApiKey[]> {
    return db.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.organizationId, organizationId),
        isNull(apiKeys.revokedAt)
      ),
      orderBy: [desc(apiKeys.createdAt)],
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });
  },

  // Update last used timestamp
  async updateLastUsed(id: string): Promise<void> {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, id));
  },

  // Revoke an API key
  async revoke(id: string): Promise<ApiKey | undefined> {
    const [apiKey] = await db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
      })
      .where(eq(apiKeys.id, id))
      .returning();
    return apiKey;
  },

  // Update API key name or scopes
  async update(
    id: string,
    data: { name?: string; scopes?: string }
  ): Promise<ApiKey | undefined> {
    const [apiKey] = await db
      .update(apiKeys)
      .set(data)
      .where(eq(apiKeys.id, id))
      .returning();
    return apiKey;
  },

  // Delete an API key permanently
  async delete(id: string): Promise<void> {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  },

  // Count active API keys for a user
  async countByUser(userId: string): Promise<number> {
    const keys = await db.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.isActive, true),
        isNull(apiKeys.revokedAt)
      ),
      columns: { id: true },
    });
    return keys.length;
  },
};
