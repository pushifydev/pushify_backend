import { decrypt } from '../lib/encryption';
import { githubAppService } from './github-app.service';
import { gitlabService } from './gitlab.service';
import { githubService } from './github.service';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';

export type GitProvider = 'github' | 'gitlab';

export function detectGitProviderFromUrl(repoUrl: string | null | undefined): GitProvider | null {
  if (!repoUrl) return null;
  if (repoUrl.includes('gitlab.com') || repoUrl.includes('gitlab.')) return 'gitlab';
  if (repoUrl.includes('github.com')) return 'github';
  return null;
}

/**
 * Resolve a token for cloning and API calls for one project.
 *
 * A GitHub App installation is preferred: it belongs to the account rather than to a person, is
 * scoped to the repositories that account chose, and keeps working when the member who connected
 * the repository leaves. When no installation covers the repository we fall back to the legacy
 * path — the organisation owner's OAuth token — so projects connected before the App keep
 * deploying untouched.
 */
export async function getProjectGitAccessToken(projectId: string): Promise<{
  provider: GitProvider;
  token: string;
  /** which credential answered — useful in logs while both paths are live */
  source?: 'app' | 'oauth';
} | null> {
  const project = await projectRepository.findById(projectId);
  if (!project?.gitRepoUrl) return null;

  const provider =
    (project.gitProvider as GitProvider | null) || detectGitProviderFromUrl(project.gitRepoUrl);
  if (!provider) return null;

  try {
    // The App path first, and deliberately before the owner lookup: an installation belongs to
    // the account, so it must keep working even when the organisation has no usable owner
    // integration left — the exact case the OAuth model fails.
    if (provider === 'github') {
      const installation = await githubAppService.findInstallationForRepo(
        project.organizationId,
        project.gitRepoUrl
      );

      if (installation) {
        return {
          provider: 'github',
          token: await githubAppService.tokenFor(installation.installationId),
          source: 'app',
        };
      }
    }

    const owner = await organizationRepository.findOwner(project.organizationId);
    if (!owner) return null;

    if (provider === 'gitlab') {
      const integration = await gitlabService.getIntegration(owner.userId);
      if (!integration) return null;
      return { provider: 'gitlab', token: decrypt(integration.accessToken), source: 'oauth' };
    }

    const integration = await githubService.getIntegration(owner.userId);
    if (!integration) return null;
    return { provider: 'github', token: decrypt(integration.accessToken), source: 'oauth' };
  } catch {
    return null;
  }
}
