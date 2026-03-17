import { createHash, randomBytes } from 'crypto';
import { apiKeyRepository } from '../repositories/apikey.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';
import { HTTPException } from 'hono/http-exception';
import { API_KEY_SCOPES, type ApiKey, type ApiKeyScope } from '../db/schema';

const MAX_KEYS_PER_USER = 10;
const KEY_PREFIX = 'pk_live_';

/**
 * Generate a secure random API key
 * Format: pk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx (32 random chars)
 */
function generateApiKey(): string {
  const randomPart = randomBytes(24).toString('base64url');
  return `${KEY_PREFIX}${randomPart}`;
}

/**
 * Hash an API key using SHA-256
 */
function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Get the prefix for display (first 12 chars)
 */
function getKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

/**
 * Validate scopes are valid
 */
function validateScopes(scopes: string[]): boolean {
  if (scopes.includes('*')) return true;
  return scopes.every((scope) => scope in API_KEY_SCOPES);
}

/**
 * Check if a key has a specific scope
 */
export function hasScope(keyScopes: string, requiredScope: ApiKeyScope): boolean {
  if (keyScopes === '*') return true;
  const scopes = keyScopes.split(',').map((s) => s.trim());
  return scopes.includes(requiredScope) || scopes.includes('*');
}

export interface CreateApiKeyInput {
  name: string;
  scopes?: string[]; // Array of scope strings, defaults to ['*']
  expiresAt?: Date;
}

export interface ApiKeyWithSecret {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  secretKey: string; // Only returned on creation
  createdAt: Date;
  expiresAt: Date | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
  user?: {
    id: string;
    name: string | null;
    email: string;
  };
}

export const apiKeyService = {
  /**
   * Create a new API key
   */
  async create(
    userId: string,
    organizationId: string,
    input: CreateApiKeyInput,
    locale: SupportedLocale = 'en'
  ): Promise<ApiKeyWithSecret> {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Check key limit
    const keyCount = await apiKeyRepository.countByUser(userId);
    if (keyCount >= MAX_KEYS_PER_USER) {
      throw new HTTPException(400, { message: t(locale, 'apiKeys', 'limitReached') });
    }

    // Validate scopes
    const scopes = input.scopes || ['*'];
    if (!validateScopes(scopes)) {
      throw new HTTPException(400, { message: t(locale, 'apiKeys', 'invalidScopes') });
    }

    // Generate key
    const secretKey = generateApiKey();
    const keyHash = hashApiKey(secretKey);
    const prefix = getKeyPrefix(secretKey);

    // Create in database
    const apiKey = await apiKeyRepository.create({
      userId,
      organizationId,
      name: input.name,
      prefix,
      keyHash,
      scopes: scopes.join(','),
      expiresAt: input.expiresAt || null,
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      secretKey, // Only returned once!
      createdAt: apiKey.createdAt,
      expiresAt: apiKey.expiresAt,
    };
  },

  /**
   * Validate an API key and return its info
   */
  async validate(key: string): Promise<{
    apiKey: ApiKey;
    userId: string;
    organizationId: string;
  } | null> {
    const keyHash = hashApiKey(key);
    const apiKey = await apiKeyRepository.findByHash(keyHash);

    if (!apiKey) {
      return null;
    }

    // Check if expired
    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
      return null;
    }

    // Update last used (fire and forget)
    apiKeyRepository.updateLastUsed(apiKey.id).catch(() => {});

    return {
      apiKey,
      userId: apiKey.userId,
      organizationId: apiKey.organizationId,
    };
  },

  /**
   * List all API keys for a user
   */
  async list(
    userId: string,
    organizationId: string,
    locale: SupportedLocale = 'en'
  ): Promise<ApiKeyInfo[]> {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const keys = await apiKeyRepository.findByUserAndOrg(userId, organizationId);

    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scopes: key.scopes,
      isActive: key.isActive,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
    }));
  },

  /**
   * List all API keys for an organization (admin)
   */
  async listOrganizationKeys(
    userId: string,
    organizationId: string,
    locale: SupportedLocale = 'en'
  ): Promise<ApiKeyInfo[]> {
    // Verify admin access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || membership.role !== 'owner') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const keys = await apiKeyRepository.findByOrganization(organizationId);

    return keys.map((key: any) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scopes: key.scopes,
      isActive: key.isActive,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      user: key.user,
    }));
  },

  /**
   * Revoke an API key
   */
  async revoke(
    keyId: string,
    userId: string,
    organizationId: string,
    locale: SupportedLocale = 'en'
  ): Promise<void> {
    const apiKey = await apiKeyRepository.findById(keyId);

    if (!apiKey) {
      throw new HTTPException(404, { message: t(locale, 'apiKeys', 'notFound') });
    }

    // Verify ownership or admin
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // User can only revoke their own keys unless they're an owner
    if (apiKey.userId !== userId && membership.role !== 'owner') {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    await apiKeyRepository.revoke(keyId);
  },

  /**
   * Update an API key's name or scopes
   */
  async update(
    keyId: string,
    userId: string,
    organizationId: string,
    input: { name?: string; scopes?: string[] },
    locale: SupportedLocale = 'en'
  ): Promise<ApiKeyInfo> {
    const apiKey = await apiKeyRepository.findById(keyId);

    if (!apiKey) {
      throw new HTTPException(404, { message: t(locale, 'apiKeys', 'notFound') });
    }

    // Verify ownership
    if (apiKey.userId !== userId) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    // Validate scopes if provided
    if (input.scopes && !validateScopes(input.scopes)) {
      throw new HTTPException(400, { message: t(locale, 'apiKeys', 'invalidScopes') });
    }

    const updateData: { name?: string; scopes?: string } = {};
    if (input.name) updateData.name = input.name;
    if (input.scopes) updateData.scopes = input.scopes.join(',');

    const updated = await apiKeyRepository.update(keyId, updateData);

    if (!updated) {
      throw new HTTPException(500, { message: t(locale, 'errors', 'internalError') });
    }

    return {
      id: updated.id,
      name: updated.name,
      prefix: updated.prefix,
      scopes: updated.scopes,
      isActive: updated.isActive,
      lastUsedAt: updated.lastUsedAt,
      createdAt: updated.createdAt,
      expiresAt: updated.expiresAt,
    };
  },

  /**
   * Get available scopes
   */
  getAvailableScopes(): Record<string, string> {
    return API_KEY_SCOPES;
  },
};
