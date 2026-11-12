import { organizationRepository } from '../repositories/organization.repository';
import { deploymentAlertRepository } from '../repositories/deployment-alert.repository';
import { sendServerAutoPatchEmail } from '../lib/email';
import type { AutoPatchAlert, ServerAutoPatchLastRun } from '../lib/server-auto-patch';
import { logger } from '../lib/logger';

/**
 * Emails about scheduled security update runs. Only a failed run or a pending reboot is worth one,
 * and the worker sends each condition once (`nextAutoPatchAlert`); every run is on the server
 * timeline anyway. Goes to whoever keeps deployment alerts on, like the disk alert.
 */
export const serverAutoPatchAlertService = {
  async announce(
    server: { id: string; name: string; organizationId: string },
    alert: AutoPatchAlert,
    run: ServerAutoPatchLastRun
  ): Promise<void> {
    const [recipients, org] = await Promise.all([
      deploymentAlertRepository.findAlertRecipients(server.organizationId),
      organizationRepository.findById(server.organizationId),
    ]);

    for (const recipient of recipients) {
      await sendServerAutoPatchEmail(recipient.email, {
        orgName: org?.name ?? '',
        serverName: server.name,
        serverId: server.id,
        alert,
        error: run.error,
        code: run.code,
        summary: run.summary,
      }).catch(() => {});
    }

    logger.info({ serverId: server.id, alert, code: run.code }, 'Scheduled security update alert sent');
  },
};
