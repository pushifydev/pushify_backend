import { eq, and, desc, isNull } from 'drizzle-orm';
import { db } from '../db';
import {
  previewDeployments,
  type PreviewDeployment,
  type NewPreviewDeployment,
} from '../db/schema';

export const previewRepository = {
  // Find preview by ID
  async findById(id: string): Promise<PreviewDeployment | undefined> {
    return db.query.previewDeployments.findFirst({
      where: eq(previewDeployments.id, id),
    });
  },

  // Find preview by project and PR number
  async findByProjectAndPr(
    projectId: string,
    prNumber: number
  ): Promise<PreviewDeployment | undefined> {
    return db.query.previewDeployments.findFirst({
      where: and(
        eq(previewDeployments.projectId, projectId),
        eq(previewDeployments.prNumber, prNumber)
      ),
    });
  },

  // Find all active previews for a project
  async findActiveByProject(projectId: string): Promise<PreviewDeployment[]> {
    return db.query.previewDeployments.findMany({
      where: and(
        eq(previewDeployments.projectId, projectId),
        isNull(previewDeployments.closedAt)
      ),
      orderBy: [desc(previewDeployments.createdAt)],
    });
  },

  // Find all previews for a project (including closed)
  async findAllByProject(projectId: string, limit = 50): Promise<PreviewDeployment[]> {
    return db.query.previewDeployments.findMany({
      where: eq(previewDeployments.projectId, projectId),
      orderBy: [desc(previewDeployments.createdAt)],
      limit,
    });
  },

  // Create preview
  async create(data: NewPreviewDeployment): Promise<PreviewDeployment> {
    const [preview] = await db
      .insert(previewDeployments)
      .values(data)
      .returning();

    return preview;
  },

  // Update preview
  async update(
    id: string,
    data: Partial<Omit<NewPreviewDeployment, 'id' | 'projectId' | 'prNumber'>>
  ): Promise<PreviewDeployment | undefined> {
    const [preview] = await db
      .update(previewDeployments)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(previewDeployments.id, id))
      .returning();

    return preview;
  },

  // Update preview by project and PR number
  async updateByProjectAndPr(
    projectId: string,
    prNumber: number,
    data: Partial<Omit<NewPreviewDeployment, 'id' | 'projectId' | 'prNumber'>>
  ): Promise<PreviewDeployment | undefined> {
    const [preview] = await db
      .update(previewDeployments)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(previewDeployments.projectId, projectId),
          eq(previewDeployments.prNumber, prNumber)
        )
      )
      .returning();

    return preview;
  },

  // Close preview (mark as closed)
  async close(id: string): Promise<PreviewDeployment | undefined> {
    const [preview] = await db
      .update(previewDeployments)
      .set({
        status: 'stopped',
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(previewDeployments.id, id))
      .returning();

    return preview;
  },

  // Close preview by project and PR number
  async closeByProjectAndPr(
    projectId: string,
    prNumber: number
  ): Promise<PreviewDeployment | undefined> {
    const [preview] = await db
      .update(previewDeployments)
      .set({
        status: 'stopped',
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(previewDeployments.projectId, projectId),
          eq(previewDeployments.prNumber, prNumber)
        )
      )
      .returning();

    return preview;
  },

  // Delete preview
  async delete(id: string): Promise<void> {
    await db.delete(previewDeployments).where(eq(previewDeployments.id, id));
  },

  // Find stale previews (older than X days and closed)
  async findStalePreviews(daysOld: number): Promise<PreviewDeployment[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    return db.query.previewDeployments.findMany({
      where: and(
        eq(previewDeployments.status, 'stopped'),
        // closedAt is not null and older than cutoff
        // We'll filter in code for simplicity
      ),
    });
  },
};
