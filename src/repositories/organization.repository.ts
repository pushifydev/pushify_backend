import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { organizations, organizationMembers, organizationInvitations } from '../db/schema/organizations';

// Types
export type CreateOrganizationInput = {
  name: string;
  slug: string;
  billingEmail?: string;
};

export type CreateMemberInput = {
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  invitedBy?: string;
};

export type CreateInvitationInput = {
  organizationId: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  invitedByUserId: string;
  tokenHash: string;
  note?: string;
  expiresAt: Date;
};

export const organizationRepository = {
  // Find organization by ID
  async findById(id: string) {
    return db.query.organizations.findFirst({
      where: eq(organizations.id, id),
    });
  },

  // Find organization by slug
  async findBySlug(slug: string) {
    return db.query.organizations.findFirst({
      where: eq(organizations.slug, slug),
    });
  },

  // Create organization
  async create(input: CreateOrganizationInput) {
    const [org] = await db
      .insert(organizations)
      .values(input)
      .returning({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
      });

    return org;
  },

  // Update organization
  async update(id: string, data: Partial<typeof organizations.$inferInsert>) {
    const [org] = await db
      .update(organizations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(organizations.id, id))
      .returning();

    return org;
  },

  // Delete organization
  async delete(id: string) {
    await db.delete(organizations).where(eq(organizations.id, id));
  },

  // Add member to organization
  async addMember(input: CreateMemberInput) {
    const [member] = await db
      .insert(organizationMembers)
      .values(input)
      .returning();

    return member;
  },

  // Find member
  async findMember(organizationId: string, userId: string) {
    return db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId)
      ),
    });
  },

  // Find user's first organization (with membership)
  async findUserFirstOrganization(userId: string) {
    return db.query.organizationMembers.findFirst({
      where: eq(organizationMembers.userId, userId),
      with: {
        organization: true,
      },
    });
  },

  // Find all user's organizations
  async findUserOrganizations(userId: string) {
    return db.query.organizationMembers.findMany({
      where: eq(organizationMembers.userId, userId),
      with: {
        organization: true,
      },
    });
  },

  // Find organization members
  async findMembers(organizationId: string) {
    return db.query.organizationMembers.findMany({
      where: eq(organizationMembers.organizationId, organizationId),
      with: {
        user: {
          columns: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
    });
  },

  // Find organization owner
  async findOwner(organizationId: string) {
    return db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.role, 'owner')
      ),
    });
  },

  // Update member role
  async updateMemberRole(organizationId: string, userId: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
    const [member] = await db
      .update(organizationMembers)
      .set({ role })
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId)
        )
      )
      .returning();

    return member;
  },

  // Remove member
  async removeMember(organizationId: string, userId: string) {
    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId)
        )
      );
  },

  // ============ Invitations ============

  async createInvitation(input: CreateInvitationInput) {
    const [invitation] = await db
      .insert(organizationInvitations)
      .values(input)
      .returning();
    return invitation;
  },

  async findInvitationByTokenHash(tokenHash: string) {
    return db.query.organizationInvitations.findFirst({
      where: eq(organizationInvitations.tokenHash, tokenHash),
      with: {
        organization: {
          columns: { id: true, name: true, slug: true },
        },
        invitedBy: {
          columns: { id: true, name: true, email: true },
        },
      },
    });
  },

  async findInvitationsByOrg(organizationId: string) {
    return db.query.organizationInvitations.findMany({
      where: and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.status, 'pending')
      ),
      with: {
        invitedBy: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: (inv, { desc }) => [desc(inv.createdAt)],
    });
  },

  async findPendingInvitationByEmail(organizationId: string, email: string) {
    return db.query.organizationInvitations.findFirst({
      where: and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.email, email),
        eq(organizationInvitations.status, 'pending')
      ),
    });
  },

  async updateInvitationStatus(
    id: string,
    status: 'accepted' | 'revoked',
    acceptedAt?: Date
  ) {
    const [inv] = await db
      .update(organizationInvitations)
      .set({ status, ...(acceptedAt ? { acceptedAt } : {}) })
      .where(eq(organizationInvitations.id, id))
      .returning();
    return inv;
  },

  async deleteInvitation(id: string) {
    await db.delete(organizationInvitations).where(eq(organizationInvitations.id, id));
  },
};
