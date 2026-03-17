import crypto from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { organizationRepository } from '../repositories/organization.repository';
import { userRepository } from '../repositories/user.repository';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';
import { sendOrgInvitationEmail } from '../lib/email';

interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
}

export const organizationService = {
  /**
   * Get organization details
   */
  async getOrganization(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'notFound') });
    }

    return { ...org, role: membership.role };
  },

  /**
   * Update organization (owner/admin only)
   */
  async updateOrganization(
    organizationId: string,
    userId: string,
    input: UpdateOrganizationInput,
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    // Check slug uniqueness if changing
    if (input.slug) {
      const existing = await organizationRepository.findBySlug(input.slug);
      if (existing && existing.id !== organizationId) {
        throw new HTTPException(409, { message: t(locale, 'organizations', 'slugTaken') });
      }
    }

    const updated = await organizationRepository.update(organizationId, input);
    logger.info({ organizationId, userId }, 'Organization updated');
    return updated;
  },

  /**
   * Get all members of an organization
   */
  async getMembers(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    return organizationRepository.findMembers(organizationId);
  },

  /**
   * Add a member by email
   */
  async addMember(
    organizationId: string,
    userId: string,
    email: string,
    role: 'admin' | 'member' | 'viewer',
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    // Find user by email
    const targetUser = await userRepository.findByEmail(email);
    if (!targetUser) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'userNotFound') });
    }

    // Check if already a member
    const existingMember = await organizationRepository.findMember(organizationId, targetUser.id);
    if (existingMember) {
      throw new HTTPException(409, { message: t(locale, 'organizations', 'alreadyMember') });
    }

    const member = await organizationRepository.addMember({
      organizationId,
      userId: targetUser.id,
      role,
      invitedBy: userId,
    });

    logger.info({ organizationId, targetUserId: targetUser.id, role, invitedBy: userId }, 'Member added');
    return member;
  },

  /**
   * Update a member's role (owner/admin only)
   */
  async updateMemberRole(
    organizationId: string,
    userId: string,
    targetUserId: string,
    role: 'admin' | 'member' | 'viewer',
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    // Check target member exists
    const targetMember = await organizationRepository.findMember(organizationId, targetUserId);
    if (!targetMember) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'memberNotFound') });
    }

    // Cannot change owner's role
    if (targetMember.role === 'owner') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'cannotChangeOwner') });
    }

    const updated = await organizationRepository.updateMemberRole(organizationId, targetUserId, role);
    logger.info({ organizationId, targetUserId, role, updatedBy: userId }, 'Member role updated');
    return updated;
  },

  /**
   * Remove a member (owner/admin only)
   */
  async removeMember(
    organizationId: string,
    userId: string,
    targetUserId: string,
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    // Check target member exists
    const targetMember = await organizationRepository.findMember(organizationId, targetUserId);
    if (!targetMember) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'memberNotFound') });
    }

    // Cannot remove owner
    if (targetMember.role === 'owner') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'cannotRemoveOwner') });
    }

    await organizationRepository.removeMember(organizationId, targetUserId);
    logger.info({ organizationId, targetUserId, removedBy: userId }, 'Member removed');
  },

  /**
   * Send an invitation email to a user (owner/admin only)
   */
  async sendInvitation(
    organizationId: string,
    userId: string,
    email: string,
    role: 'admin' | 'member' | 'viewer',
    note: string | undefined,
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'notFound') });
    }

    // Check if target is already a member
    const targetUser = await userRepository.findByEmail(email);
    if (targetUser) {
      const existingMember = await organizationRepository.findMember(organizationId, targetUser.id);
      if (existingMember) {
        throw new HTTPException(409, { message: t(locale, 'organizations', 'alreadyMember') });
      }
    }

    // Check for existing pending invitation
    const existingInvitation = await organizationRepository.findPendingInvitationByEmail(organizationId, email);
    if (existingInvitation) {
      throw new HTTPException(409, { message: t(locale, 'organizations', 'invitationAlreadyPending') });
    }

    // Generate token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invitation = await organizationRepository.createInvitation({
      organizationId,
      email,
      role,
      invitedByUserId: userId,
      tokenHash,
      note,
      expiresAt,
    });

    // Get inviter name for email
    const inviter = await userRepository.findById(userId);
    const inviterName = inviter?.name ?? 'Someone';

    // Send email (fire and forget)
    sendOrgInvitationEmail(email, rawToken, org.name, inviterName, role, locale).catch(() => {});

    logger.info({ organizationId, email, role, invitedBy: userId }, 'Invitation sent');
    return invitation;
  },

  /**
   * List pending invitations for an organization
   */
  async listInvitations(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    return organizationRepository.findInvitationsByOrg(organizationId);
  },

  /**
   * Revoke an invitation (owner/admin only)
   */
  async revokeInvitation(
    organizationId: string,
    userId: string,
    invitationId: string,
    locale: SupportedLocale = 'en'
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    const invitations = await organizationRepository.findInvitationsByOrg(organizationId);
    const invitation = invitations.find((i) => i.id === invitationId);
    if (!invitation) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'invitationNotFound') });
    }

    await organizationRepository.updateInvitationStatus(invitationId, 'revoked');
    logger.info({ organizationId, invitationId, revokedBy: userId }, 'Invitation revoked');
  },

  /**
   * Get invitation info by raw token (public — for accept page)
   */
  async getInvitationInfo(token: string, locale: SupportedLocale = 'en') {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const invitation = await organizationRepository.findInvitationByTokenHash(tokenHash);

    if (!invitation) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'invitationNotFound') });
    }
    if (invitation.status === 'accepted') {
      throw new HTTPException(409, { message: t(locale, 'organizations', 'invitationAlreadyAccepted') });
    }
    if (invitation.status === 'revoked' || new Date() > new Date(invitation.expiresAt)) {
      throw new HTTPException(410, { message: t(locale, 'organizations', 'invitationExpired') });
    }

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      organization: invitation.organization,
      invitedBy: invitation.invitedBy,
      expiresAt: invitation.expiresAt,
    };
  },

  /**
   * Accept an invitation (authenticated — user must be logged in)
   */
  async acceptInvitation(
    token: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const invitation = await organizationRepository.findInvitationByTokenHash(tokenHash);

    if (!invitation) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'invitationNotFound') });
    }
    if (invitation.status === 'accepted') {
      throw new HTTPException(409, { message: t(locale, 'organizations', 'invitationAlreadyAccepted') });
    }
    if (invitation.status === 'revoked' || new Date() > new Date(invitation.expiresAt)) {
      throw new HTTPException(410, { message: t(locale, 'organizations', 'invitationExpired') });
    }

    // Verify user email matches
    const user = await userRepository.findById(userId);
    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'invitationEmailMismatch') });
    }

    // Check not already a member
    const existingMember = await organizationRepository.findMember(invitation.organizationId, userId);
    if (existingMember) {
      // Still mark invitation as accepted to clean up
      await organizationRepository.updateInvitationStatus(invitation.id, 'accepted', new Date());
      throw new HTTPException(409, { message: t(locale, 'organizations', 'alreadyMember') });
    }

    // Add member
    await organizationRepository.addMember({
      organizationId: invitation.organizationId,
      userId,
      role: invitation.role,
      invitedBy: invitation.invitedByUserId,
    });

    await organizationRepository.updateInvitationStatus(invitation.id, 'accepted', new Date());

    logger.info({ organizationId: invitation.organizationId, userId, invitationId: invitation.id }, 'Invitation accepted');
    return { organizationId: invitation.organizationId, organization: invitation.organization };
  },
};
