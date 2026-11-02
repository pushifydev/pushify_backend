/**
 * Which git host a repository URL points at, and the clone URL that carries an access token.
 *
 * The URL is whatever a member typed into the project. Deciding by substring — `includes('github.com')`,
 * `includes('gitlab')` — let `https://evil.example/github.com/acme/repo` or
 * `https://gitlab.evil.example/x/y` pick up the owner's OAuth token or the GitHub App token, which
 * git then sent as Basic auth to evil.example. So: parse the URL, and only the exact host a token
 * was issued for, over https, ever gets one.
 */
import { env } from '../config/env';

export type GitHost = 'github' | 'gitlab';

const GITHUB_HOST = 'github.com';
const GITLAB_HOST = 'gitlab.com';

/** gitlab.com, plus the self-hosted instance the GitLab OAuth app lives on (GITLAB_BASE_URL). */
function gitlabHosts(): string[] {
  const hosts = [GITLAB_HOST];
  if (env.GITLAB_BASE_URL) {
    try {
      hosts.push(new URL(env.GITLAB_BASE_URL).host.toLowerCase());
    } catch {
      // env.ts validates it as a URL; nothing else to add if it somehow is not one
    }
  }
  return hosts;
}

/** `git@host:owner/repo.git` — the scp-like form older rows may still hold. */
const SCP_LIKE_RE = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)(.*)$/;

/**
 * Host (lower-case, with a non-default port) and path of a repository URL, or null when it is not
 * one we understand. https/http/ssh URLs and the scp-like form are accepted.
 */
export function parseGitRemote(repoUrl: string | null | undefined): { host: string; path: string } | null {
  if (!repoUrl) return null;
  const value = repoUrl.trim();

  const scp = SCP_LIKE_RE.exec(value);
  if (scp) return { host: scp[1].toLowerCase(), path: scp[2] };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.host) return null;
  return { host: url.host.toLowerCase(), path: url.pathname };
}

/** github / gitlab by exact host; null for every other host. */
export function gitHostOf(repoUrl: string | null | undefined): GitHost | null {
  const remote = parseGitRemote(repoUrl);
  if (!remote) return null;
  if (remote.host === GITHUB_HOST) return 'github';
  if (gitlabHosts().includes(remote.host)) return 'gitlab';
  return null;
}

/**
 * The URL to hand `git clone`: with the token as Basic auth when the URL is https on github.com
 * or a GitLab host we hold tokens for, otherwise exactly `repoUrl`, without a token.
 */
export function authenticatedCloneUrl(repoUrl: string, accessToken?: string | null): string {
  if (!accessToken) return repoUrl;

  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return repoUrl;
  }
  if (url.protocol !== 'https:') return repoUrl;

  const host = gitHostOf(repoUrl);
  if (!host) return repoUrl;

  // `x-access-token` is what GitHub documents for App installation tokens (ghs_…) and works for
  // OAuth tokens too; a bare `token@host` makes git prompt for a password in a worker.
  url.username = host === 'github' ? 'x-access-token' : 'oauth2';
  url.password = accessToken;
  return url.toString();
}
