import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projectWorkers } from '../db/schema/project-workers';
import { workerContainerName } from '../lib/worker-validate';
import { runWorkerContainer } from './remote-docker';
import type { SSHClient } from '../utils/ssh';

export interface SyncWorkerContainersOptions {
  projectId: string;
  slug: string;
  /** Full image ref to run (e.g. pushify-myapp:abc1234) */
  imageRef: string;
  envVars?: Record<string, string>;
  volumes?: string[];
  framework?: string;
  buildpackId?: string;
  onProgress: (message: string) => void;
}

/**
 * Reconcile worker containers on the deploy host with the DB state: start every
 * enabled worker from the freshly deployed image, remove containers whose worker
 * was disabled or deleted. Never throws — a worker failure must not fail the
 * app deploy; problems are reported through onProgress.
 */
export async function syncWorkerContainersOnDeploy(
  ssh: SSHClient,
  options: SyncWorkerContainersOptions
): Promise<void> {
  const { projectId, slug, imageRef, envVars, volumes, framework, buildpackId, onProgress } =
    options;

  try {
    const workers = await db
      .select()
      .from(projectWorkers)
      .where(eq(projectWorkers.projectId, projectId));

    const enabled = workers.filter((w) => w.enabled);
    const prefix = `pushify-${slug}-worker-`;

    // Remove containers for disabled/deleted workers
    const listed = await ssh.exec(
      `docker ps -a --format '{{.Names}}' | grep '^${prefix}' || true`
    );
    const existingNames = (listed.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const wantedNames = new Set(enabled.map((w) => workerContainerName(slug, w.name)));

    for (const name of existingNames) {
      if (!wantedNames.has(name)) {
        await ssh.exec(`docker rm -f ${name} 2>/dev/null || true`);
        onProgress(`🧹 Removed worker container: ${name}`);
      }
    }

    if (enabled.length === 0) return;

    onProgress(`⚙️ Starting ${enabled.length} worker process(es)...`);

    for (const worker of enabled) {
      const containerName = workerContainerName(slug, worker.name);
      try {
        const result = await runWorkerContainer(ssh, {
          imageName: imageRef,
          containerName,
          command: worker.command,
          envVars,
          volumes,
          framework,
          buildpackId,
          onProgress,
        });

        if (result.success) {
          // Join the shared network so workers reach Pushify databases by name
          await ssh.exec(`docker network connect pushify ${containerName} 2>/dev/null || true`);
          onProgress(`✅ Worker running: ${worker.name}`);
        } else {
          onProgress(`⚠️ Worker "${worker.name}" failed to start: ${result.logs.slice(0, 300)}`);
        }
      } catch (err) {
        onProgress(
          `⚠️ Worker "${worker.name}" failed to start: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err) {
    onProgress(
      `⚠️ Worker sync skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
