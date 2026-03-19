import { eq, and, ne } from 'drizzle-orm';
import { db } from '../db';
import { users, userSessions, passwordResetTokens, emailVerificationTokens } from '../db/schema/users';

// Types
export type CreateUserInput = {
  email: string;
  passwordHash: string | null;
  name: string;
  avatarUrl?: string | null;
  githubId?: string | null;
};

export type UserPublic = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
};

export type CreateSessionInput = {
  userId: string;
  tokenHash: string;
  ipAddress?: string;
  userAgent?: string;
  expiresAt: Date;
};

export const userRepository = {
  // Find user by email
  async findByEmail(email: string) {
    return db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });
  },

  // Find user by GitHub ID
  async findByGithubId(githubId: string) {
    return db.query.users.findFirst({
      where: eq(users.githubId, githubId),
    });
  },

  // Find user by Google ID
  async findByGoogleId(googleId: string) {
    return db.query.users.findFirst({
      where: eq(users.googleId, googleId),
    });
  },

  // Find user by ID
  async findById(id: string) {
    return db.query.users.findFirst({
      where: eq(users.id, id),
    });
  },

  // Find user by ID (public fields only)
  async findByIdPublic(id: string): Promise<UserPublic | undefined> {
    return db.query.users.findFirst({
      where: eq(users.id, id),
      columns: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        emailVerified: true,
        twoFactorEnabled: true,
        createdAt: true,
      },
    });
  },

  // Create new user
  async create(input: CreateUserInput) {
    const [user] = await db
      .insert(users)
      .values({
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash ?? undefined,
        name: input.name,
        ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
        ...(input.githubId !== undefined && { githubId: input.githubId }),
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        emailVerified: users.emailVerified,
        twoFactorEnabled: users.twoFactorEnabled,
      });

    return user;
  },

  // Update user
  async update(id: string, data: Partial<typeof users.$inferInsert>) {
    const [user] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    return user;
  },

  // Delete user
  async delete(id: string) {
    await db.delete(users).where(eq(users.id, id));
  },

  // Create session
  async createSession(input: CreateSessionInput) {
    const [session] = await db
      .insert(userSessions)
      .values(input)
      .returning();

    return session;
  },

  // Find session by token hash
  async findSessionByTokenHash(tokenHash: string) {
    return db.query.userSessions.findFirst({
      where: eq(userSessions.tokenHash, tokenHash),
    });
  },

  // Delete session by token hash
  async deleteSessionByTokenHash(tokenHash: string) {
    await db.delete(userSessions).where(eq(userSessions.tokenHash, tokenHash));
  },

  // Delete all sessions for user
  async deleteAllSessions(userId: string) {
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
  },

  // Find all sessions for user
  async findAllSessionsByUserId(userId: string) {
    return db.query.userSessions.findMany({
      where: eq(userSessions.userId, userId),
      orderBy: (sessions, { desc }) => [desc(sessions.createdAt)],
    });
  },

  // Find session by ID
  async findSessionById(sessionId: string) {
    return db.query.userSessions.findFirst({
      where: eq(userSessions.id, sessionId),
    });
  },

  // Delete session by ID
  async deleteSessionById(sessionId: string) {
    await db.delete(userSessions).where(eq(userSessions.id, sessionId));
  },

  // Delete all sessions except one (for "logout other sessions")
  async deleteOtherSessions(userId: string, exceptSessionId: string) {
    await db
      .delete(userSessions)
      .where(and(eq(userSessions.userId, userId), ne(userSessions.id, exceptSessionId)));
  },

  // Create password reset token
  async createPasswordResetToken(input: { userId: string; tokenHash: string; expiresAt: Date }) {
    const [token] = await db
      .insert(passwordResetTokens)
      .values(input)
      .returning();

    return token;
  },

  // Find password reset token by token hash
  async findPasswordResetTokenByHash(tokenHash: string) {
    return db.query.passwordResetTokens.findFirst({
      where: eq(passwordResetTokens.tokenHash, tokenHash),
    });
  },

  // Delete all password reset tokens for a user
  async deletePasswordResetTokensByUserId(userId: string) {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
  },

  // Create email verification token
  async createEmailVerificationToken(input: { userId: string; tokenHash: string; expiresAt: Date }) {
    const [token] = await db
      .insert(emailVerificationTokens)
      .values(input)
      .returning();

    return token;
  },

  // Find email verification token by hash
  async findEmailVerificationTokenByHash(tokenHash: string) {
    return db.query.emailVerificationTokens.findFirst({
      where: eq(emailVerificationTokens.tokenHash, tokenHash),
    });
  },

  // Delete all email verification tokens for a user
  async deleteEmailVerificationTokensByUserId(userId: string) {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));
  },
};
