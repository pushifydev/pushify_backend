import { env } from '../config/env';

const QUEUE_LINE_PREFIX = '[Pushify] queue:';

export interface DeployQueueSnapshot {
  deploymentId: string;
  serverId: string;
  position: number;
  serverActive: number;
  serverLimit: number;
  globalActive: number;
  globalLimit: number;
}

export function formatQueueStatusLine(snapshot: DeployQueueSnapshot): string {
  const waiting =
    snapshot.position > snapshot.serverLimit - snapshot.serverActive ||
    snapshot.globalActive >= snapshot.globalLimit;

  if (!waiting && snapshot.position === 1 && snapshot.serverActive < snapshot.serverLimit) {
    return `${QUEUE_LINE_PREFIX} starting soon (slot ${snapshot.serverActive + 1}/${snapshot.serverLimit} on server)`;
  }

  const serverPart = `server queue #${snapshot.position} (${snapshot.serverActive}/${snapshot.serverLimit} builds running)`;
  const globalPart =
    snapshot.globalActive >= snapshot.globalLimit
      ? ` · platform ${snapshot.globalActive}/${snapshot.globalLimit} builds (waiting for a slot)`
      : '';

  return `${QUEUE_LINE_PREFIX} ${serverPart}${globalPart}`;
}

/** Strip prior queue header lines from stored build logs. */
export function stripQueueLinesFromLogs(logs: string): string {
  return logs
    .split('\n')
    .filter((line) => !line.includes(QUEUE_LINE_PREFIX))
    .join('\n')
    .trim();
}

export function mergeQueueLineIntoLogs(existingLogs: string | null, queueLine: string): string {
  const body = stripQueueLinesFromLogs(existingLogs ?? '');
  const timestamp = new Date().toISOString();
  const header = `[${timestamp}] ${queueLine}`;
  return body ? `${header}\n${body}` : header;
}

export function buildQueueSnapshots(
  pendingDeploymentIds: { id: string; serverId: string | null }[],
  serverActiveCounts: Map<string, number>,
  globalActive: number
): DeployQueueSnapshot[] {
  const byServer = new Map<string, string[]>();

  for (const row of pendingDeploymentIds) {
    const sid = row.serverId || '__local__';
    const list = byServer.get(sid) ?? [];
    list.push(row.id);
    byServer.set(sid, list);
  }

  const snapshots: DeployQueueSnapshot[] = [];

  for (const [serverId, ids] of byServer) {
    const serverActive = serverActiveCounts.get(serverId) ?? 0;
    ids.forEach((id, index) => {
      snapshots.push({
        deploymentId: id,
        serverId,
        position: index + 1,
        serverActive,
        serverLimit: env.MAX_CONCURRENT_DEPLOYS_PER_SERVER,
        globalActive,
        globalLimit: env.MAX_CONCURRENT_DEPLOYS_TOTAL,
      });
    });
  }

  return snapshots;
}
