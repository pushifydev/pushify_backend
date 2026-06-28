import { env } from '../config/env';

/**
 * Pick the runner server a free/unassigned project deploys to, from the configured pool
 * (`PUSHIFY_RUNNER_SERVER_IDS`, comma-separated; legacy single `PUSHIFY_RUNNER_SERVER_ID` still
 * honored). The mapping is sticky and deterministic by project id, so a project's redeploys
 * always land on the same runner (its subdomain/state stay put) while projects spread across the
 * pool. Returns null when no runner is configured → caller falls back to the local host.
 */
export function pickRunnerServerId(projectId: string): string | null {
  const raw = env.PUSHIFY_RUNNER_SERVER_IDS || env.PUSHIFY_RUNNER_SERVER_ID || '';
  const pool = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

/**
 * The server a project's container actually lives on: its explicitly assigned server, otherwise
 * the runner it was stickily routed to at deploy time. Any post-deploy op that talks to the
 * container (logs, restart, exec, domain/nginx) must resolve the target this way — branching on
 * `project.serverId` alone wrongly treats runner-deployed (unassigned) projects as local.
 */
export function resolveProjectServerId(project: { id: string; serverId: string | null }): string | null {
  return project.serverId || pickRunnerServerId(project.id);
}
