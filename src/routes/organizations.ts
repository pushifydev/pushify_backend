import { Hono } from 'hono';
import { organizationService } from '../services/organization.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const organizationRouter = new Hono<AppEnv>();

// All routes require authentication
organizationRouter.use('*', authMiddleware);

// Get organization details
organizationRouter.get('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const org = await organizationService.getOrganization(organizationId, userId, locale);

  return c.json({ data: org });
});

// Update organization
organizationRouter.patch('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const org = await organizationService.updateOrganization(
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({
    data: org,
    message: t(locale, 'organizations', 'updated'),
  });
});

// Get all members
organizationRouter.get('/members', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const members = await organizationService.getMembers(organizationId, userId, locale);

  return c.json({ data: members });
});

// Add a member
organizationRouter.post('/members', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { email, role } = await c.req.json();

  const member = await organizationService.addMember(
    organizationId,
    userId,
    email,
    role || 'member',
    locale
  );

  return c.json({
    data: member,
    message: t(locale, 'organizations', 'memberAdded'),
  }, 201);
});

// Update member role
organizationRouter.patch('/members/:userId', async (c) => {
  const currentUserId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const targetUserId = c.req.param('userId');
  const { role } = await c.req.json();

  const member = await organizationService.updateMemberRole(
    organizationId,
    currentUserId,
    targetUserId,
    role,
    locale
  );

  return c.json({
    data: member,
    message: t(locale, 'organizations', 'roleUpdated'),
  });
});

// Remove member
organizationRouter.delete('/members/:userId', async (c) => {
  const currentUserId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const targetUserId = c.req.param('userId');

  await organizationService.removeMember(
    organizationId,
    currentUserId,
    targetUserId,
    locale
  );

  return c.json({ message: t(locale, 'organizations', 'memberRemoved') });
});

// List pending invitations
organizationRouter.get('/invitations', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const invitations = await organizationService.listInvitations(organizationId, userId, locale);
  return c.json({ data: invitations });
});

// Send invitation
organizationRouter.post('/invitations', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { email, role, note } = await c.req.json();

  const invitation = await organizationService.sendInvitation(
    organizationId,
    userId,
    email,
    role || 'member',
    note,
    locale
  );

  return c.json({
    data: invitation,
    message: t(locale, 'organizations', 'invitationSent'),
  }, 201);
});

// Revoke invitation
organizationRouter.delete('/invitations/:invitationId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const invitationId = c.req.param('invitationId');

  await organizationService.revokeInvitation(organizationId, userId, invitationId, locale);
  return c.json({ message: t(locale, 'organizations', 'invitationRevoked') });
});

export { organizationRouter as organizationRoutes };
