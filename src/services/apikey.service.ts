import { createHash, randomBytes } from 'crypto';
import { apiKeyRepository } from '../repositories/apikey.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';
import { HTTPException } from 'hono/http-exception';
import { API_KEY_SCOPES, type ApiKey, type ApiKeyScope } from '../db/schema';
import { isUserBanned } from '../lib/user-ban';
import { projectRepository } from '../repositories/project.repository';
import { getMemberAllowedProjectIds, type MembershipScope } from '../lib/member-project-scope';
import { normalizeApiKeyProjectIds } from '../lib/api-key-project-scope';

const MAX_KEYS_PER_USER = 10;
const MAX_PROJECTS_PER_KEY = 50;
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
 * A key may only be limited to projects of its organization that its creator can reach right now
 * (lib/api-key-project-scope). Returns the normalised list, or null for an unrestricted key. A
 * missing project and one outside the creator's access get the same 400, so neither can be probed.
 */
async function resolveKeyProjectIds(
  projectIds: string[] | null | undefined,
  membership: MembershipScope,
  organizationId: string,
  userId: string,
  locale: SupportedLocale
): Promise<string[] | null> {
  const ids = normalizeApiKeyProjectIds(projectIds);
  if (!ids) return null;

  const invalid = new HTTPException(400, { message: t(locale, 'apiKeys', 'invalidProjects') });
  if (ids.length === 0 || ids.length > MAX_PROJECTS_PER_KEY) throw invalid;

  const memberAllowed = await getMemberAllowedProjectIds(membership, organizationId, userId);
  const reachable = memberAllowed
    ? ids.filter((id) => memberAllowed.some((allowed) => allowed.toLowerCase() === id))
    : ids;
  if (reachable.length !== ids.length) throw invalid;

  const found = await projectRepository.findByOrganization(organizationId, reachable);
  if (found.length !== ids.length) throw invalid;

  return ids;
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
  /** Limit the key to these projects; omitted or null = every project the creator can reach */
  projectIds?: string[] | null;
}

export interface ApiKeyWithSecret {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  projectIds: string[] | null;
  secretKey: string; // Only returned on creation
  createdAt: Date;
  expiresAt: Date | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  projectIds: string[] | null;
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

    const projectIds = await resolveKeyProjectIds(input.projectIds, membership, organizationId, userId, locale);

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
      projectIds,
      expiresAt: input.expiresAt || null,
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      projectIds: apiKey.projectIds ?? null,
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

    // A key acts as the member who created it: once they have left the organization, it stops.
    const member = await organizationRepository.findMember(apiKey.organizationId, apiKey.userId);
    if (!member) {
      return null;
    }
    // …and once they are banned (a ban deletes their keys too; this covers the gap)
    if (await isUserBanned(apiKey.userId)) {
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
      projectIds: key.projectIds ?? null,
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
      projectIds: key.projectIds ?? null,
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

    // A key of another organization is not found here, even for this organization's owner.
    if (!apiKey || apiKey.organizationId !== organizationId) {
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
   * Update an API key's name, scopes or project list (`projectIds: null` lifts the limit)
   */
  async update(
    keyId: string,
    userId: string,
    organizationId: string,
    input: { name?: string; scopes?: string[]; projectIds?: string[] | null },
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

    const updateData: { name?: string; scopes?: string; projectIds?: string[] | null } = {};
    if (input.name) updateData.name = input.name;
    if (input.scopes) updateData.scopes = input.scopes.join(',');
    if (input.projectIds !== undefined) {
      // Checked against the key's own organization and the creator's access there now
      const membership = await organizationRepository.findMember(apiKey.organizationId, userId);
      if (!membership) {
        throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
      }
      updateData.projectIds = await resolveKeyProjectIds(
        input.projectIds,
        membership,
        apiKey.organizationId,
        userId,
        locale
      );
    }

    const updated = await apiKeyRepository.update(keyId, updateData);

    if (!updated) {
      throw new HTTPException(500, { message: t(locale, 'errors', 'internalError') });
    }

    return {
      id: updated.id,
      name: updated.name,
      prefix: updated.prefix,
      scopes: updated.scopes,
      projectIds: updated.projectIds ?? null,
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
