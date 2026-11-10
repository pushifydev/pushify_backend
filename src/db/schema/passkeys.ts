import { pgTable, uuid, varchar, text, bigint, integer, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * WebAuthn credentials ("passkeys") a user registered on their own account. Each one can sign the
 * user in instead of a password (routes/passkeys.ts). The public key is kept exactly as the
 * authenticator sent it (a COSE key, base64url), so another WebAuthn implementation can read it.
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The credential ID, base64url. What the browser sends back at sign-in. */
    credentialId: text('credential_id').notNull().unique(),
    /** COSE_Key, base64url */
    publicKey: text('public_key').notNull(),
    /** COSE algorithm identifier (-7 ES256, -8 EdDSA, -257 RS256) */
    algorithm: integer('algorithm').notNull(),
    /** Last signature counter seen; 0 for authenticators that do not keep one (most synced passkeys) */
    signCount: bigint('sign_count', { mode: 'number' }).default(0).notNull(),
    transports: jsonb('transports').$type<string[]>().default([]).notNull(),
    aaguid: varchar('aaguid', { length: 36 }),
    /** Can be synced to other devices (BE flag) / is synced right now (BS flag) */
    backupEligible: boolean('backup_eligible').default(false).notNull(),
    backedUp: boolean('backed_up').default(false).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('passkeys_user_idx').on(t.userId),
  })
);

export type Passkey = typeof passkeys.$inferSelect;
