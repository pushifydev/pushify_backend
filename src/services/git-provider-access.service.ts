import { decrypt } from '../lib/encryption';
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
 * Resolve an OAuth access token for cloning / API calls for a project (org owner's integration).
 */
export async function getProjectGitAccessToken(projectId: string): Promise<{
  provider: GitProvider;
  token: string;
} | null> {
  const project = await projectRepository.findById(projectId);
  if (!project?.gitRepoUrl) return null;

  const provider =
    (project.gitProvider as GitProvider | null) || detectGitProviderFromUrl(project.gitRepoUrl);
  if (!provider) return null;

  const owner = await organizationRepository.findOwner(project.organizationId);
  if (!owner) return null;

  try {
    if (provider === 'gitlab') {
      const integration = await gitlabService.getIntegration(owner.userId);
      if (!integration) return null;
      return { provider: 'gitlab', token: decrypt(integration.accessToken) };
    }

    const integration = await githubService.getIntegration(owner.userId);
    if (!integration) return null;
    return { provider: 'github', token: decrypt(integration.accessToken) };
  } catch {
    return null;
  }
}
