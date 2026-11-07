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
 * This first step moves stateless apps only: anything whose data lives on the source server
 * (persistent volumes, compose stacks, a managed database reached over the source's private
 * Docker network) is refused with a reason. The checks below are what `dryRun` reports.
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
  /** Names of the project's persistent volumes */
  volumes: string[];
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

  if (facts.volumes.length > 0) {
    add(
      'volumes',
      'block',
      `The project has persistent volumes (${list(facts.volumes)}) whose data stays on the current server. Moving volumes is not supported yet.`
    );
  } else {
    add('volumes', 'pass', 'The project has no persistent volumes.');
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
