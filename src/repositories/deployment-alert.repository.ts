import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { organizationMembers } from '../db/schema/organizations';
import { users } from '../db/schema/users';

/** The reads behind personal deployment-alert emails, kept apart so the service is testable. */
export const deploymentAlertRepository = {
  async findDeployment(deploymentId: string) {
    const [row] = await db
      .select({
        id: deployments.id,
        projectId: deployments.projectId,
        isPreview: deployments.isPreview,
        branch: deployments.branch,
        errorMessage: deployments.errorMessage,
        createdAt: deployments.createdAt,
      })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    return row ?? null;
  },

  /** Status of the production deployment created right before this one, if any. */
  async previousDeploymentStatus(projectId: string, before: Date, excludingId: string): Promise<string | null> {
    const [row] = await db
      .select({ status: deployments.status })
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, projectId),
          eq(deployments.isPreview, false),
          lt(deployments.createdAt, before),
          ne(deployments.id, excludingId),
        ),
      )
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    return row?.status ?? null;
  },

  /** Every member of the organisation who has not switched deployment alerts off. */
  async findAlertRecipients(organizationId: string): Promise<{ email: string; name: string }[]> {
    const rows = await db
      .select({ email: users.email, name: users.name, prefs: users.notificationPrefs })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, organizationId));
    return rows
      .filter((r) => (r.prefs?.deploymentAlerts ?? true) !== false)
      .map((r) => ({ email: r.email, name: r.name }));
  },
};
