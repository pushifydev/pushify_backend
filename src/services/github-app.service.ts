/**
 * GitHub App installations: the replacement for borrowing a person's OAuth token.
 *
 * An installation belongs to a GitHub account (user or organisation) and survives whoever set it
 * up. This service keeps our copy of those installations in sync with GitHub's webhooks, links
 * them to a Pushify organisation, and hands out short-lived access tokens on demand.
 *
 * The App is optional: with no credentials configured, every function here reports "not
 * configured" and the OAuth path stays in charge.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import {
  githubAppInstallations,
  type GithubAppInstallation,
} from '../db/schema/integrations';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import {
  forgetInstallationToken,
  getInstallationToken,
  verifyAppCredentials,
  type AppCredentialCheck,
  type GitHubAppConfig,
} from '../lib/github-app-auth';

const GITHUB_API_URL = 'https://api.github.com';

export interface InstallationRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

export function isAppConfigured(): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

function appConfig(): GitHubAppConfig {
  if (!isAppConfigured()) {
    throw new Error('GitHub App is not configured');
  }
  return { appId: env.GITHUB_APP_ID!, privateKey: env.GITHUB_APP_PRIVATE_KEY! };
}

/** Where a user goes to install (or reconfigure) the App. */
export function installUrl(state?: string): string | null {
  if (!env.GITHUB_APP_SLUG) return null;
  const url = new URL(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** `owner/repo` from any GitHub URL shape we store. */
export function repoFullNameFromUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;

  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export const githubAppService = {
  isConfigured: isAppConfigured,
  installUrl,

  /** Upsert what a webhook (or the setup callback) told us about an installation. */
  async syncInstallation(input: {
    installationId: number;
    accountLogin: string;
    accountId?: number | null;
    accountType?: string | null;
    repositorySelection?: string | null;
    suspended?: boolean;
  }): Promise<GithubAppInstallation> {
    const values = {
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      accountId: input.accountId ?? null,
      accountType: input.accountType ?? null,
      repositorySelection: input.repositorySelection ?? null,
      suspendedAt: input.suspended ? new Date() : null,
      updatedAt: new Date(),
    };

    const [row] = await db
      .insert(githubAppInstallations)
      .values(values)
      .onConflictDoUpdate({ target: githubAppInstallations.installationId, set: values })
      .returning();

    // A changed installation may have gained or lost repositories; the cached token still works,
    // but its scope is stale, so drop it and let the next call mint a fresh one.
    forgetInstallationToken(input.installationId);
    return row;
  },

  async removeInstallation(installationId: number): Promise<void> {
    await db
      .delete(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId));
    forgetInstallationToken(installationId);
  },

  async setSuspended(installationId: number, suspended: boolean): Promise<void> {
    await db
      .update(githubAppInstallations)
      .set({ suspendedAt: suspended ? new Date() : null, updatedAt: new Date() })
      .where(eq(githubAppInstallations.installationId, installationId));
    forgetInstallationToken(installationId);
  },

  /**
   * Attach an installation to a Pushify organisation. Called from the post-install redirect,
   * which is the only moment we know which organisation the person was acting for.
   */
  async claimInstallation(
    installationId: number,
    organizationId: string,
    userId: string
  ): Promise<GithubAppInstallation | null> {
    const [row] = await db
      .update(githubAppInstallations)
      .set({ organizationId, installedByUserId: userId, updatedAt: new Date() })
      .where(
        and(
          eq(githubAppInstallations.installationId, installationId),
          // Only an unclaimed installation may be claimed; re-claiming is a no-op that returns null.
          isNull(githubAppInstallations.organizationId)
        )
      )
      .returning();

    return row ?? null;
  },

  async listForOrganization(organizationId: string): Promise<GithubAppInstallation[]> {
    return db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.organizationId, organizationId));
  },

  async findByInstallationId(installationId: number): Promise<GithubAppInstallation | null> {
    const row = await db.query.githubAppInstallations.findFirst({
      where: eq(githubAppInstallations.installationId, installationId),
    });
    return row ?? null;
  },

  /** Operator self-check: is the App configured, does the key parse, does GitHub accept it? */
  async status(): Promise<
    { configured: false } | ({ configured: true; slugConfigured: boolean } & AppCredentialCheck)
  > {
    if (!isAppConfigured()) return { configured: false };
    const check = await verifyAppCredentials(appConfig());
    return { configured: true, slugConfigured: Boolean(env.GITHUB_APP_SLUG), ...check };
  },

  /** A live token for this installation. Never persisted — the installation is the credential. */
  async tokenFor(installationId: number): Promise<string> {
    const { token } = await getInstallationToken(appConfig(), installationId);
    return token;
  },

  /** Every repository an installation can see, for the repo picker. */
  async listRepositories(installationId: number): Promise<InstallationRepository[]> {
    const token = await this.tokenFor(installationId);
    const repositories: InstallationRepository[] = [];

    // 100 per page, capped at 5 pages: a picker does not need more, and it bounds the call.
    for (let page = 1; page <= 5; page += 1) {
      const response = await fetch(
        `${GITHUB_API_URL}/installation/repositories?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (!response.ok) {
        logger.warn(
          { installationId, status: response.status },
          'Could not list installation repositories'
        );
        break;
      }

      const payload = (await response.json()) as {
        repositories?: {
          id: number;
          full_name: string;
          private: boolean;
          default_branch: string;
          html_url: string;
        }[];
      };

      const batch = payload.repositories ?? [];
      repositories.push(
        ...batch.map((repo) => ({
          id: repo.id,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          htmlUrl: repo.html_url,
        }))
      );

      if (batch.length < 100) break;
    }

    return repositories;
  },

  /**
   * The installation that can reach this repository for this organisation, if any.
   *
   * The account login is matched first because it is free; a `selected` installation is then
   * confirmed against its repository list, since owning the account does not imply the App was
   * granted that particular repository.
   */
  async findInstallationForRepo(
    organizationId: string,
    repoUrl: string
  ): Promise<GithubAppInstallation | null> {
    if (!isAppConfigured()) return null;

    const fullName = repoFullNameFromUrl(repoUrl);
    if (!fullName) return null;

    const [ownerLogin] = fullName.split('/');
    const installations = await this.listForOrganization(organizationId);

    const candidates = installations.filter(
      (installation) =>
        !installation.suspendedAt &&
        installation.accountLogin.toLowerCase() === ownerLogin.toLowerCase()
    );

    for (const candidate of candidates) {
      if (candidate.repositorySelection === 'all') return candidate;

      try {
        const repositories = await this.listRepositories(candidate.installationId);
        if (repositories.some((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase())) {
          return candidate;
        }
      } catch (error) {
        logger.warn(
          { installationId: candidate.installationId, error: String(error) },
          'Could not confirm repository access for installation'
        );
      }
    }

    return null;
  },
};
