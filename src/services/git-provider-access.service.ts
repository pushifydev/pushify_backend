import { decrypt } from '../lib/encryption';
import { githubAppService, repoFullNameFromUrl } from './github-app.service';
import { gitlabService } from './gitlab.service';
import { githubService } from './github.service';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { logger } from '../lib/logger';

export type GitProvider = 'github' | 'gitlab';

export interface GitCredential {
  provider: GitProvider;
  token: string;
  /** which credential answered — useful in logs while both paths are live */
  source?: 'app' | 'oauth';
  /** the login it acts as: the installation's account, or the connected OAuth username */
  account?: string | null;
}

export interface ProjectGitAccess {
  provider: GitProvider | null;
  /** `owner/repo`, when the URL could be parsed */
  repoFullName: string | null;
  credential: GitCredential | null;
  /**
   * GitHub only, and only looked up when no credential can read the repo: true = anyone can
   * clone it, false = private and nobody connected can see it, null = unknown.
   */
  isPublic: boolean | null;
}

export interface ResolveGitAccessOptions {
  /**
   * The member acting right now (deploy button, API call). Their own connection is tried right
   * after the App — it's their account, so it is always fair to use for what they started.
   */
  preferUserId?: string | null;
  /** Look up whether the repo is public when no credential can read it (one anonymous call). */
  checkPublic?: boolean;
}

export function detectGitProviderFromUrl(repoUrl: string | null | undefined): GitProvider | null {
  if (!repoUrl) return null;
  if (repoUrl.includes('gitlab.com') || repoUrl.includes('gitlab.')) return 'gitlab';
  if (repoUrl.includes('github.com')) return 'github';
  return null;
}

/**
 * Work out which credential can read a project's repository.
 *
 * GitHub, in order:
 * 1. A GitHub App installation on the repo owner's account that covers the repo — it belongs to
 *    the account, not a person, so it survives members leaving.
 * 2. The OAuth connection of the member acting now (`preferUserId`).
 * 3. The organisation owner's OAuth connection — how every project deployed before the App.
 *
 * Every OAuth token is checked against the repo before it is used, so a connection to a
 * different GitHub account (someone switched accounts) is skipped instead of producing a
 * confusing clone failure. Any failure in one path falls through to the next; nothing here
 * throws. Other members' connections are deliberately not used: that would let one member
 * deploy a private repo only another member can see, without asking them.
 */
export async function resolveProjectGitAccess(
  projectId: string,
  options: ResolveGitAccessOptions = {}
): Promise<ProjectGitAccess> {
  const project = await projectRepository.findById(projectId).catch(() => null);
  const repoUrl = project?.gitRepoUrl ?? null;
  const provider = repoUrl
    ? (project?.gitProvider as GitProvider | null) || detectGitProviderFromUrl(repoUrl)
    : null;
  const repoFullName = provider === 'github' ? repoFullNameFromUrl(repoUrl) : null;
  const result: ProjectGitAccess = { provider, repoFullName, credential: null, isPublic: null };

  if (!project || !repoUrl || !provider) return result;

  // 1. GitHub App
  if (provider === 'github') {
    try {
      const installation = await githubAppService.findInstallationForRepo(project.organizationId, repoUrl);
      if (installation) {
        result.credential = {
          provider: 'github',
          token: await githubAppService.tokenFor(installation.installationId),
          source: 'app',
          account: installation.accountLogin ?? null,
        };
        return result;
      }
    } catch (error) {
      logger.warn(
        { projectId, error: String(error) },
        'GitHub App credential failed; trying OAuth connections'
      );
    }
  }

  // 2 + 3. OAuth connections: the acting member, then the owner
  const userIds: string[] = [];
  if (options.preferUserId) userIds.push(options.preferUserId);
  try {
    const owner = await organizationRepository.findOwner(project.organizationId);
    if (owner && !userIds.includes(owner.userId)) userIds.push(owner.userId);
  } catch (error) {
    logger.warn({ projectId, error: String(error) }, 'Owner lookup for git credentials failed');
  }

  const [repoOwner, repoName] = repoFullName ? repoFullName.split('/') : [];
  let maybe: GitCredential | null = null;

  for (const userId of userIds) {
    let candidate: GitCredential;
    try {
      const integration =
        provider === 'gitlab'
          ? await gitlabService.getIntegration(userId)
          : await githubService.getIntegration(userId);
      if (!integration) continue;
      candidate = {
        provider,
        token: decrypt(integration.accessToken),
        source: 'oauth',
        account: integration.providerUsername ?? null,
      };
    } catch (error) {
      logger.warn({ projectId, userId, error: String(error) }, 'Could not read a git OAuth connection');
      continue;
    }

    // GitLab and unparseable GitHub URLs: no cheap check, first connection wins (as before).
    if (provider !== 'github' || !repoOwner) {
      result.credential = candidate;
      return result;
    }

    const access = await githubService.repoAccess(repoOwner, repoName, candidate.token);
    if (access === 'yes') {
      result.credential = candidate;
      return result;
    }
    if (access === 'unknown' && !maybe) maybe = candidate;
  }

  if (maybe) {
    result.credential = maybe;
    return result;
  }

  if (options.checkPublic && provider === 'github' && repoOwner) {
    const anonymous = await githubService.repoAccess(repoOwner, repoName);
    result.isPublic = anonymous === 'yes' ? true : anonymous === 'no' ? false : null;
  }

  return result;
}

/**
 * The credential for cloning and API calls on one project, or null when none can read it.
 * See resolveProjectGitAccess for the order.
 */
export async function getProjectGitAccessToken(
  projectId: string,
  options: Pick<ResolveGitAccessOptions, 'preferUserId'> = {}
): Promise<GitCredential | null> {
  const { credential } = await resolveProjectGitAccess(projectId, options);
  return credential;
}

/** What a deploy log / API error says when no connected credential can read the repo. */
export function noRepoAccessMessage(repoFullName: string | null): string {
  const repo = repoFullName ? `github.com/${repoFullName}` : 'this repository';
  const owner = repoFullName?.split('/')[0];
  return (
    `Pushify has no access to ${repo}. Connect the GitHub account that can see it, or install ` +
    `the Pushify GitHub App on ${owner ? `@${owner}` : 'the account that owns it'} ` +
    `(Project → Settings → GitHub access).`
  );
}
