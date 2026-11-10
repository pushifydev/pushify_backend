import { and, asc, count, eq } from 'drizzle-orm';
import { db } from '../db';
import { passkeys, type Passkey } from '../db/schema/passkeys';

export type CreatePasskeyInput = Omit<Passkey, 'id' | 'createdAt' | 'lastUsedAt'>;

export const passkeyRepository = {
  async findByUserId(userId: string): Promise<Passkey[]> {
    return db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt));
  },

  async countByUserId(userId: string): Promise<number> {
    const [row] = await db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, userId));
    return Number(row?.n ?? 0);
  },

  async findByCredentialId(credentialId: string): Promise<Passkey | undefined> {
    const [row] = await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialId)).limit(1);
    return row;
  },

  async create(input: CreatePasskeyInput): Promise<Passkey> {
    const [row] = await db.insert(passkeys).values(input).returning();
    return row;
  },

  async markUsed(id: string, signCount: number, backedUp: boolean): Promise<void> {
    await db.update(passkeys).set({ signCount, backedUp, lastUsedAt: new Date() }).where(eq(passkeys.id, id));
  },

  /** Only the owner's own passkey; the number of rows deleted (0 or 1). */
  async deleteForUser(id: string, userId: string): Promise<number> {
    const rows = await db
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning({ id: passkeys.id });
    return rows.length;
  },
};
