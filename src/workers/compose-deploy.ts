import path from 'path';
import type { SSHClient } from '../utils/ssh';
import type { servers } from '../db/schema/servers';
import { getOrAssignPort } from './port-manager';
import { shSingleQuote } from './shell';
import { checkComposeFile } from '../lib/host-access-guard';
import { COMPOSE_FILENAMES, composePortOverride, planCompose } from '../lib/compose-project';
import { dockerConfigPrefix } from '../lib/registry';

/**
 * Deploy a repository as a Docker Compose stack — the customer's own compose file, from their
 * own checkout, so `build:` contexts and config files beside it work the way they do locally.
 *
 * The marketplace's compose deploys (in `remote-deployment.ts`) run files we wrote and ship.
 * This one does not, so two things are decided here rather than trusted: what the stack may
 * take from the host (`lib/host-access-guard.ts`) and which ports reach it
 * (`lib/compose-project.ts` — only the public service is published, through nginx).
 */

export interface ComposeDeployOptions {
  server: typeof servers.$inferSelect;
  projectId: string;
  projectSlug: string;
  /** `<slug>` or `<slug>-staging` — the compose project name */
  deploySlug: string;
  projectDir: string;
  /** The checkout, at the project's root directory */
  workDir: string;
  /** Absolute path of the compose file on the server */
  composeFile: string;
  service: string | null;
  port: number | null;
  envVars: Record<string, string>;
  sharedHost: boolean;
  /** This deploy's private-registry logins, for images and `build:` steps in the stack */
  dockerConfig: string | null;
  onProgress: (message: string) => void;
}

export interface ComposeDeployResult {
  success: true;
  deploymentUrl: string;
  containerPort: number;
}

/**
 * The compose file to deploy. An explicit path is taken as given (relative to the project's root
 * directory); otherwise the usual names are tried in the order `docker compose` tries them.
 */
export async function findComposeFile(
  ssh: SSHClient,
  workDir: string,
  configured?: string | null
): Promise<string | null> {
  const candidates = configured?.trim()
    ? [path.posix.normalize(path.posix.join(workDir, configured.trim()))]
    : COMPOSE_FILENAMES.map((name) => path.posix.join(workDir, name));

  for (const candidate of candidates) {
    // A configured path must stay inside the checkout — `../../etc/passwd` is not a compose file
    if (!candidate.startsWith(`${workDir}/`) && candidate !== workDir) continue;
    if (await ssh.fileExists(candidate)) return candidate;
  }
  return null;
}

export async function deployComposeFromRepo(
  ssh: SSHClient,
  options: ComposeDeployOptions
): Promise<ComposeDeployResult> {
  const {
    server,
    projectId,
    projectSlug,
    deploySlug,
    projectDir,
    workDir,
    composeFile,
    envVars,
    sharedHost,
    dockerConfig,
    onProgress,
  } = options;

  const stackName = `pushify-${deploySlug}`;
  const composeDir = path.posix.dirname(composeFile);
  onProgress(`📦 Deploying ${path.posix.relative(workDir, composeFile) || 'the compose file'} as stack ${stackName}`);

  const composeCheck = await ssh.exec('docker compose version 2>&1');
  if (!composeCheck.stdout.includes('Docker Compose')) {
    throw new Error('The Docker Compose plugin is not installed on the server');
  }

  const read = await ssh.exec(`cat ${shSingleQuote(composeFile)}`);
  if (read.code !== 0) throw new Error(`Could not read the compose file: ${read.stderr.trim()}`);
  const composeYaml = read.stdout;

  // What may it take from the host? On a shared runner: its own directory and nothing else.
  const hostProblem = checkComposeFile(composeYaml, { sharedHost, projectDir: composeDir });
  if (hostProblem) throw new Error(`Refusing to deploy: ${hostProblem}`);

  // Which service does the world reach, and on which port?
  const planned = planCompose(composeYaml, { service: options.service, port: options.port });
  if ('error' in planned) throw new Error(`Refusing to deploy: ${planned.error}`);
  const plan = planned.plan;
  onProgress(`🎯 Serving service "${plan.service}" on container port ${plan.containerPort}`);

  // A stable host port, so the URL and the firewall rule survive redeploys
  const { port: hostPort, isNew } = await getOrAssignPort(ssh, deploySlug, {
    range: { min: 5000, max: 5999 },
  });
  onProgress(`📌 ${isNew ? 'Assigned' : 'Reusing'} host port ${hostPort} → ${plan.service}:${plan.containerPort}`);

  // The project's environment variables, for ${VAR} in the compose file and for the containers.
  // A committed .env is read first, so the file keeps working the way it does locally, and the
  // project's own variables win over it.
  const envFile = path.posix.join(composeDir, '.env.pushify');
  const envContent = Object.entries(envVars)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/g, '\\n')}`)
    .join('\n');
  await ssh.uploadFile(`${envContent}\n`, envFile);
  const repoEnv = path.posix.join(composeDir, '.env');
  const envFileFlags = ((await ssh.fileExists(repoEnv)) ? [repoEnv, envFile] : [envFile])
    .map((file) => `--env-file ${shSingleQuote(file)}`)
    .join(' ');

  // The override decides the ports: the public service on the host port nginx proxies, and every
  // other service's published ports dropped — a compose file that puts its database on 5432 would
  // otherwise put it on the internet. Services still reach each other by name inside the stack.
  const override = composePortOverride(plan, {
    hostPort,
    bindAddress: sharedHost ? '127.0.0.1' : undefined,
  });
  const overridePath = path.posix.join(composeDir, 'docker-compose.pushify.yml');
  await ssh.uploadFile(override.yaml, overridePath);
  if (override.dropped.length > 0) {
    onProgress(
      `🔒 Not publishing ports for ${override.dropped.join(', ')} — they are reachable inside the stack by name`
    );
  }

  // DOCKER_CONFIG carries the organization's registry logins, so a stack can use private images
  // and `build:` steps with a private base image.
  const compose = (args: string) =>
    `cd ${shSingleQuote(composeDir)} && ${dockerConfigPrefix(dockerConfig)}docker compose ${envFileFlags} ` +
    `-f ${shSingleQuote(composeFile)} -f ${shSingleQuote(overridePath)} -p ${shSingleQuote(stackName)} ${args}`;

  // A previous stack of this project, if any — its containers hold the ports
  onProgress('🛑 Stopping the previous stack (if any)...');
  await ssh.exec(`${compose('down --remove-orphans')} 2>&1 || true`);

  onProgress('⬇️ Pulling images...');
  const pull = await ssh.exec(`${compose('pull --ignore-pull-failures')} 2>&1`);
  if (pull.code !== 0) onProgress('⚠️ Some images could not be pulled; they will be built or already exist');

  const { openFirewallPort } = await import('./remote-deployment');
  if (!sharedHost) await openFirewallPort(ssh, hostPort, onProgress);

  onProgress('🚀 Starting the stack...');
  const up = await ssh.exec(`${compose('up -d --build --remove-orphans')} 2>&1`);
  const upOutput = `${up.stdout}\n${up.stderr}`;
  if (up.code !== 0) {
    throw new Error(`Docker Compose could not start the stack:\n${upOutput.slice(-1200)}`);
  }

  const running = await ssh.exec(`${compose('ps -q')} 2>&1`);
  const containers = running.stdout.trim().split('\n').filter(Boolean);
  if (containers.length === 0) {
    throw new Error(`No container is running after compose up. On the server: ${compose('logs --tail 50')}`);
  }
  onProgress(`✅ ${containers.length} container(s) running`);

  // A stack runs the processes its own file declares. Pushify's Workers and Scheduled tasks
  // drive a single app container, so they do not apply here — say so rather than quietly
  // doing nothing with what the project configured.
  await warnAboutUnusedProcesses(projectId, onProgress);

  const { setupNginxAndDomain } = await import('./remote-deployment');
  const deploymentUrl = await setupNginxAndDomain(ssh, server, projectId, projectSlug, hostPort, onProgress);

  return { success: true, deploymentUrl, containerPort: hostPort };
}

/** Workers and cron jobs configured on a project that now deploys as a stack. */
async function warnAboutUnusedProcesses(projectId: string, onProgress: (message: string) => void): Promise<void> {
  try {
    const { db } = await import('../db');
    const { projectWorkers } = await import('../db/schema/project-workers');
    const { scheduledTasks } = await import('../db/schema/scheduled-tasks');
    const { eq } = await import('drizzle-orm');

    const [workers, tasks] = await Promise.all([
      db.select({ name: projectWorkers.name }).from(projectWorkers).where(eq(projectWorkers.projectId, projectId)),
      db.select({ name: scheduledTasks.name }).from(scheduledTasks).where(eq(scheduledTasks.projectId, projectId)),
    ]);
    if (workers.length > 0) {
      onProgress(
        `⚠️ ${workers.length} worker(s) configured in Pushify are not started for a compose stack — declare them as services in the compose file instead`
      );
    }
    if (tasks.length > 0) {
      onProgress(
        `⚠️ ${tasks.length} scheduled task(s) configured in Pushify do not run against a compose stack`
      );
    }
  } catch {
    // A warning is not worth failing a deploy over
  }
}
