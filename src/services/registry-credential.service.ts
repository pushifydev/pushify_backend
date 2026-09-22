import { HTTPException } from 'hono/http-exception';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db';
import { registryCredentials } from '../db/schema/registry-credentials';
import { organizationRepository } from '../repositories/organization.repository';
import { encrypt, decrypt } from '../lib/encryption';
import {
  normalizeRegistry,
  validateCredential,
  validateRegistryHost,
  type RegistryCredential,
} from '../lib/registry';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

/**
 * Registry credentials belong to the organization, not to a project: a private base image is
 * usually the same for every project a team deploys. Only owners and admins may manage them —
 * a token that can pull a company's images is not a per-project setting.
 */

const MAX_CREDENTIALS = 10;

type CredentialRow = typeof registryCredentials.$inferSelect;

/** What the API returns: everything except the token. */
export interface PublicRegistryCredential {
  id: string;
  name: string;
  registry: string;
  username: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

function toPublic(row: CredentialRow): PublicRegistryCredential {
  return {
    id: row.id,
    name: row.name,
    registry: row.registry,
    username: row.username,
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
  return membership;
}

export const registryCredentialService = {
  async list(organizationId: string, userId: string, locale: SupportedLocale = 'en') {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    const rows = await db
      .select()
      .from(registryCredentials)
      .where(eq(registryCredentials.organizationId, organizationId))
      .orderBy(desc(registryCredentials.createdAt));
    return rows.map(toPublic);
  },

  async create(
    organizationId: string,
    userId: string,
    input: { name?: string; registry?: string; username?: string; password?: string },
    locale: SupportedLocale = 'en'
  ): Promise<PublicRegistryCredential> {
    await assertCanManage(organizationId, userId, locale);

    const registry = normalizeRegistry(input.registry ?? '');
    const name = (input.name ?? '').trim() || registry;
    const username = (input.username ?? '').trim();
    const password = input.password ?? '';

    const hostError = validateRegistryHost(input.registry ?? '');
    if (hostError) throw new HTTPException(400, { message: hostError });
    const credentialError = validateCredential({ username, password });
    if (credentialError) throw new HTTPException(400, { message: credentialError });
    if (name.length > 100) throw new HTTPException(400, { message: 'Name is too long' });

    const existing = await db
      .select({ id: registryCredentials.id })
      .from(registryCredentials)
      .where(eq(registryCredentials.organizationId, organizationId));
    if (existing.length >= MAX_CREDENTIALS) {
      throw new HTTPException(400, { message: `An organization can have at most ${MAX_CREDENTIALS} registries` });
    }

    // One login per registry: a second set of credentials for the same host would make which
    // one a deploy uses a coin toss, so replacing is the only sensible meaning.
    const [row] = await db
      .insert(registryCredentials)
      .values({
        organizationId,
        name,
        registry,
        username,
        passwordEncrypted: encrypt(password),
      })
      .onConflictDoUpdate({
        target: [registryCredentials.organizationId, registryCredentials.registry],
        set: { name, username, passwordEncrypted: encrypt(password), updatedAt: new Date() },
      })
      .returning();

    logger.info({ organizationId, registry }, 'Registry credential stored');
    return toPublic(row);
  },

  async remove(organizationId: string, userId: string, id: string, locale: SupportedLocale = 'en') {
    await assertCanManage(organizationId, userId, locale);
    const [row] = await db
      .delete(registryCredentials)
      .where(and(eq(registryCredentials.id, id), eq(registryCredentials.organizationId, organizationId)))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'Registry credential not found' });
    return { success: true };
  },

  /**
   * The credentials a deploy logs in with, decrypted. Internal — never routed. A credential
   * whose token no longer decrypts (key rotated, row corrupted) is skipped rather than failing
   * the deploy: a public base image still builds fine without it.
   */
  async forDeploy(organizationId: string): Promise<RegistryCredential[]> {
    const rows = await db
      .select()
      .from(registryCredentials)
      .where(eq(registryCredentials.organizationId, organizationId))
      .orderBy(desc(registryCredentials.createdAt));

    const credentials: RegistryCredential[] = [];
    for (const row of rows) {
      try {
        credentials.push({
          name: row.name,
          registry: row.registry,
          username: row.username,
          password: decrypt(row.passwordEncrypted),
        });
      } catch (err) {
        logger.error({ err, credentialId: row.id }, 'Registry credential could not be decrypted');
      }
    }
    return credentials;
  },

  /** Note that a registry was used, so an unused credential is visible as such. */
  async markUsed(organizationId: string, registries: string[]): Promise<void> {
    if (registries.length === 0) return;
    await Promise.all(
      registries.map((registry) =>
        db
          .update(registryCredentials)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(registryCredentials.organizationId, organizationId),
              eq(registryCredentials.registry, registry)
            )
          )
          .catch(() => undefined)
      )
    );
  },
};
