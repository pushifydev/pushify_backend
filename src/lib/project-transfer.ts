import type { DeploymentBuildMetadata } from '../db/schema/deployments';

/**
 * Moving a project to another server of its organization (POST /projects/:projectId/transfer).
 *
 * The move is a deploy of the last successful production commit on the target server, through
 * the normal deploy queue. The project's `serverId` only changes after that deploy passed its
 * health check and nginx/SSL are set up on the target; the source's containers are then stopped
 * (not removed), so moving back is a start away. Until then — and when the deploy fails — the
 * project keeps running where it was.
 *
 * Persistent volumes move with the app (lib/project-volume-transfer.ts): once the image is built
 * on the target, the containers using them are stopped on the source, the volumes are copied and
 * checked, and only then does the container start on the target — the downtime is that copy. The
 * source's volumes are kept; removing them is a separate step. Compose stacks, static sites and a
 * managed database reached over the source's private Docker network are still refused with a
 * reason. The checks below are what `dryRun` reports.
 */

export type TransferCheckId =
  | 'project'
  | 'source_server'
  | 'target_server'
  | 'deployment'
  | 'app_type'
  | 'volumes'
  | 'databases'
  | 'plan_quota'
  | 'dns';

/** block stops the move; warn needs the user's attention but does not */
export type TransferCheckStatus = 'pass' | 'warn' | 'block';

export interface TransferCheck {
  id: TransferCheckId;
  status: TransferCheckStatus;
  message: string;
}

export interface TransferTargetServer {
  id: string;
  organizationId: string;
  name: string;
  status: string;
  setupStatus: string;
  ipv4: string | null;
  ipv6: string | null;
  hasSshKey: boolean;
}

export interface TransferVolume {
  /** The project volume's name (project_volumes.name) */
  name: string;
  /** Bytes of data in it on the current server; null when they could not be measured */
  sizeBytes: number | null;
}

/** Everything the checks need, gathered by services/project-transfer.service.ts */
export interface TransferFacts {
  project: {
    organizationId: string;
    status: string;
    suspended: boolean;
    serverId: string | null;
    /** Site Studio / uploaded static site (published from stored files, not a container) */
    staticSite: boolean;
    /** Compose file or marketplace stack: its services may keep data in compose volumes */
    composeStack: boolean;
  };
  targetServerId: string;
  /** null when no server has that id */
  target: TransferTargetServer | null;
  hasSuccessfulDeployment: boolean;
  deploymentInProgress: boolean;
  /** The project's persistent volumes, with their size on the current server */
  volumes: TransferVolume[];
  /** Free bytes on the target's Docker filesystem; null when not measured (or no volumes) */
  targetFreeBytes: number | null;
  /** Linked managed databases on the source server, reached over its private Docker network */
  sourceDatabases: string[];
  /** Why billing or the plan does not allow another deploy, null when it does */
  quotaProblem: string | null;
  /** Custom (not auto-generated) domains of the project */
  customDomains: string[];
  cloudflareConnected: boolean;
}

export interface TransferDnsDomain {
  domain: string;
  /** Cloudflare is connected: Pushify re-points the records it created once the move completes */
  autoUpdate: boolean;
}

export interface TransferPreflight {
  ok: boolean;
  fromServerId: string | null;
  toServerId: string;
  checks: TransferCheck[];
  /** Messages of the blocking checks, in order */
  blockers: string[];
  dns: {
    targetIpv4: string | null;
    targetIpv6: string | null;
    cloudflareConnected: boolean;
    /** Custom domains whose DNS records must point at the target after the move */
    domains: TransferDnsDomain[];
  };
  volumes: {
    items: TransferVolume[];
    /** null when a volume could not be measured */
    totalBytes: number | null;
    /** Free space the target needs for them: the data plus headroom */
    requiredFreeBytes: number | null;
    targetFreeBytes: number | null;
    /** How long the app is down while the volumes are copied (0 without volumes) */
    estimatedDowntimeSeconds: number;
  };
}

/** Headroom on the target on top of the volumes' data: 10%, at least 1 GiB */
const MIN_HEADROOM_BYTES = 1024 ** 3;
/** The copy is relayed source → Pushify → target over SSH; a conservative rate */
const COPY_BYTES_PER_SECOND = 20 * 1024 * 1024;
/** Both copies are read back for the checksum, at the same time */
const VERIFY_BYTES_PER_SECOND = 100 * 1024 * 1024;
/** Stopping the source, starting the container on the target, its health check */
const RESTART_SECONDS = 60;

export function requiredTargetFreeBytes(totalBytes: number): number {
  return totalBytes + Math.max(Math.ceil(totalBytes * 0.1), MIN_HEADROOM_BYTES);
}

/** Rough downtime of a move with volumes: restart plus copy plus checksum */
export function estimateVolumeDowntimeSeconds(totalBytes: number): number {
  return Math.ceil(RESTART_SECONDS + totalBytes / COPY_BYTES_PER_SECOND + totalBytes / VERIFY_BYTES_PER_SECOND);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds < 7200) return `${Math.ceil(seconds / 60)} minutes`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

function list(names: string[]): string {
  return names.map((n) => `"${n}"`).join(', ');
}

export function evaluateTransferPreflight(facts: TransferFacts): TransferPreflight {
  const checks: TransferCheck[] = [];
  const add = (id: TransferCheckId, status: TransferCheckStatus, message: string) =>
    checks.push({ id, status, message });
  const { project, target } = facts;

  if (project.suspended) {
    add('project', 'block', 'The project is suspended and cannot be moved.');
  } else if (project.status !== 'active') {
    add('project', 'block', 'The project is paused. Resume it before moving it to another server.');
  } else {
    add('project', 'pass', 'The project is active.');
  }

  if (!project.serverId) {
    add(
      'source_server',
      'block',
      'The project runs on the shared build server, not on a server of your own. Choose a server in the project settings instead.'
    );
  } else {
    add('source_server', 'pass', 'The project runs on a server of your organization.');
  }

  if (!target || target.organizationId !== project.organizationId) {
    add('target_server', 'block', 'The target server was not found in this organization.');
  } else if (target.id === project.serverId) {
    add('target_server', 'block', 'The project already runs on this server.');
  } else if (target.status !== 'running' || target.setupStatus !== 'completed') {
    add(
      'target_server',
      'block',
      `Server "${target.name}" is not ready for deployments (status: ${target.status}, setup: ${target.setupStatus}).`
    );
  } else if (!target.ipv4 || !target.hasSshKey) {
    add('target_server', 'block', `Server "${target.name}" has no IP address or SSH key, so Pushify cannot deploy to it.`);
  } else {
    add('target_server', 'pass', `Server "${target.name}" is ready.`);
  }

  if (facts.deploymentInProgress) {
    add('deployment', 'block', 'A deployment of this project is in progress. Wait for it to finish, then move the project.');
  } else if (!facts.hasSuccessfulDeployment) {
    add('deployment', 'block', 'The project has no successful production deployment to move. Deploy it first.');
  } else {
    add('deployment', 'pass', 'The last successful deployment is built again on the target server.');
  }

  if (project.staticSite) {
    add('app_type', 'block', 'Moving static sites (Site Studio or uploaded files) is not supported yet.');
  } else if (project.composeStack) {
    add(
      'app_type',
      'block',
      'Compose and marketplace stacks may keep data in their own volumes on this server, so they cannot be moved yet.'
    );
  } else {
    add('app_type', 'pass', 'The app runs as a container.');
  }

  const volumeNames = facts.volumes.map((v) => v.name);
  const unmeasured = facts.volumes.filter((v) => v.sizeBytes === null).map((v) => v.name);
  const totalBytes = unmeasured.length > 0 ? null : facts.volumes.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0);
  const requiredFreeBytes = totalBytes === null || facts.volumes.length === 0 ? null : requiredTargetFreeBytes(totalBytes);
  const estimatedDowntimeSeconds = totalBytes === null || facts.volumes.length === 0 ? 0 : estimateVolumeDowntimeSeconds(totalBytes);
  if (facts.volumes.length === 0) {
    add('volumes', 'pass', 'The project has no persistent volumes.');
  } else if (totalBytes === null) {
    add(
      'volumes',
      'block',
      `The size of persistent volume ${list(unmeasured)} on the current server could not be measured, so the move cannot be planned. Check that the server is reachable and try again.`
    );
  } else if (facts.targetFreeBytes === null) {
    add('volumes', 'block', `Free disk space on the target server could not be measured, so the persistent volumes (${list(volumeNames)}) cannot be moved there.`);
  } else if (requiredFreeBytes !== null && facts.targetFreeBytes < requiredFreeBytes) {
    add(
      'volumes',
      'block',
      `Not enough disk on the target server for the persistent volumes (${list(volumeNames)}): ${formatBytes(facts.targetFreeBytes)} free, ` +
        `${formatBytes(requiredFreeBytes)} needed (${formatBytes(totalBytes)} of data plus headroom). Free space on it or choose another server.`
    );
  } else {
    add(
      'volumes',
      'warn',
      `Persistent volumes ${list(volumeNames)} (${formatBytes(totalBytes)}) are copied to the target. The app is stopped on the current server ` +
        `during the copy: about ${formatDuration(estimatedDowntimeSeconds)} of downtime. If anything fails it is started again there; ` +
        'the volumes on the current server are kept either way.'
    );
  }

  if (facts.sourceDatabases.length > 0) {
    add(
      'databases',
      'block',
      `Linked database ${list(facts.sourceDatabases)} runs on the current server and the app reaches it over that server's private network. ` +
        'On another server the app would lose it. Moving databases is not supported yet.'
    );
  } else {
    add('databases', 'pass', 'No linked database depends on the current server.');
  }

  if (facts.quotaProblem) {
    add('plan_quota', 'block', facts.quotaProblem);
  } else {
    add('plan_quota', 'pass', 'The plan allows another deployment.');
  }

  const targetIpv4 = target && target.organizationId === project.organizationId ? target.ipv4 : null;
  const targetIpv6 = target && target.organizationId === project.organizationId ? target.ipv6 : null;
  const domains = facts.customDomains.map((domain) => ({ domain, autoUpdate: facts.cloudflareConnected }));
  if (domains.length === 0) {
    add('dns', 'pass', 'The project has no custom domains.');
  } else if (facts.cloudflareConnected) {
    add(
      'dns',
      'warn',
      `After the move, the DNS records of ${list(facts.customDomains)} must point at ${targetIpv4 ?? 'the new server'}. ` +
        'Cloudflare is connected: the records Pushify created are updated automatically; others must be changed by hand.'
    );
  } else {
    add(
      'dns',
      'warn',
      `After the move, point the DNS records of ${list(facts.customDomains)} at ${targetIpv4 ?? 'the new server'}.`
    );
  }

  const blockers = checks.filter((c) => c.status === 'block').map((c) => c.message);
  return {
    ok: blockers.length === 0,
    fromServerId: project.serverId,
    toServerId: facts.targetServerId,
    checks,
    blockers,
    dns: { targetIpv4, targetIpv6, cloudflareConnected: facts.cloudflareConnected, domains },
    volumes: {
      items: facts.volumes,
      totalBytes,
      requiredFreeBytes,
      targetFreeBytes: facts.volumes.length > 0 ? facts.targetFreeBytes : null,
      estimatedDowntimeSeconds,
    },
  };
}

/** The move a deployment carries (deployments.build_metadata.transfer), or null */
export function projectTransferOf(
  metadata: DeploymentBuildMetadata | null | undefined
): { fromServerId: string; toServerId: string } | null {
  const transfer = metadata?.transfer;
  if (!transfer || typeof transfer.fromServerId !== 'string' || typeof transfer.toServerId !== 'string') return null;
  return { fromServerId: transfer.fromServerId, toServerId: transfer.toServerId };
}
