import { db } from '../db';
import { gitIntegrations, type GitIntegration, type NewGitIntegration } from '../db/schema';
import { encrypt, decrypt } from '../lib/encryption';
import { env } from '../config/env';
import { eq, and } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { t, type SupportedLocale } from '../i18n';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { logger } from '../lib/logger';

// GitHub API URLs
const GITHUB_OAUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';

// GitHub types
export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  name: string | null;
  email: string | null;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  description: string | null;
  language: string | null;
  updated_at: string;
  pushed_at: string;
}

export interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

class GitHubService {
  /**
   * Generate OAuth authorization URL
   */
  getAuthorizationUrl(state: string): string {
    if (!env.GITHUB_CLIENT_ID) {
      throw new Error('GitHub OAuth is not configured');
    }

    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: env.GITHUB_CALLBACK_URL || '',
      scope: 'repo read:user user:email',
      state,
      allow_signup: 'true',
    });

    return `${GITHUB_OAUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<{
    access_token: string;
    token_type: string;
    scope: string;
  }> {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      throw new Error('GitHub OAuth is not configured');
    }

    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: env.GITHUB_CALLBACK_URL,
      }),
    });

    const data = await response.json();

    if (data.error) {
      throw new HTTPException(400, { message: data.error_description || data.error });
    }

    return data;
  }

  /**
   * Get GitHub user info
   */
  async getUser(accessToken: string): Promise<GitHubUser> {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new HTTPException(response.status as ContentfulStatusCode, { message: 'Failed to fetch GitHub user' });
    }

    return response.json();
  }

  /**
   * Get user's repositories
   */
  async getRepositories(accessToken: string, options?: {
    page?: number;
    perPage?: number;
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
    direction?: 'asc' | 'desc';
  }): Promise<GitHubRepo[]> {
    const params = new URLSearchParams({
      page: String(options?.page || 1),
      per_page: String(options?.perPage || 30),
      sort: options?.sort || 'updated',
      direction: options?.direction || 'desc',
      affiliation: 'owner,collaborator,organization_member',
    });

    const response = await fetch(`${GITHUB_API_URL}/user/repos?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new HTTPException(response.status as ContentfulStatusCode, { message: 'Failed to fetch repositories' });
    }

    return response.json();
  }

  /**
   * Get repository branches
   */
  async getBranches(accessToken: string, owner: string, repo: string): Promise<GitHubBranch[]> {
    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/branches`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new HTTPException(response.status as ContentfulStatusCode, { message: 'Failed to fetch branches' });
    }

    return response.json();
  }

  /**
   * Get repository details
   */
  async getRepository(accessToken: string, owner: string, repo: string): Promise<GitHubRepo> {
    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new HTTPException(response.status as ContentfulStatusCode, { message: 'Failed to fetch repository' });
    }

    return response.json();
  }

  /**
   * Detect framework from repository files
   */
  async detectFramework(accessToken: string, owner: string, repo: string, branch?: string): Promise<{
    framework: string | null;
    buildCommand: string | null;
    installCommand: string | null;
    outputDirectory: string | null;
    startCommand: string | null;
  }> {
    const ref = branch || 'main';

    // Try to get package.json
    try {
      const packageJson = await this.getFileContent(accessToken, owner, repo, 'package.json', ref);
      const pkg = JSON.parse(packageJson);

      // Check dependencies for framework detection
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['next']) {
        return {
          framework: 'nextjs',
          buildCommand: 'npm run build',
          installCommand: 'npm install',
          outputDirectory: '.next',
          startCommand: 'npm start',
        };
      }

      if (deps['nuxt']) {
        return {
          framework: 'nuxt',
          buildCommand: 'npm run build',
          installCommand: 'npm install',
          outputDirectory: '.output',
          startCommand: 'npm start',
        };
      }

      if (deps['svelte'] || deps['@sveltejs/kit']) {
        return {
          framework: 'svelte',
          buildCommand: 'npm run build',
          installCommand: 'npm install',
          outputDirectory: 'build',
          startCommand: null,
        };
      }

      if (deps['astro']) {
        return {
          framework: 'astro',
          buildCommand: 'npm run build',
          installCommand: 'npm install',
          outputDirectory: 'dist',
          startCommand: null,
        };
      }

      if (deps['vue']) {
        return {
          framework: 'vue',
          buildCommand: 'npm run build',
          installCommand: 'npm install',
          outputDirectory: 'dist',
          startCommand: null,
        };
      }

      if (deps['react'] || deps['react-dom']) {
        return {
          framework: 'react',
          buildCommand: 'npm run build',
          installCommand: 'npm install',
          outputDirectory: 'build',
          startCommand: null,
        };
      }

      // Generic Node.js project
      if (pkg.scripts?.start) {
        return {
          framework: 'nodejs',
          buildCommand: pkg.scripts?.build ? 'npm run build' : null,
          installCommand: 'npm install',
          outputDirectory: null,
          startCommand: 'npm start',
        };
      }
    } catch {
      // No package.json found
    }

    // Check for Dockerfile
    try {
      await this.getFileContent(accessToken, owner, repo, 'Dockerfile', ref);
      return {
        framework: 'docker',
        buildCommand: null,
        installCommand: null,
        outputDirectory: null,
        startCommand: null,
      };
    } catch {
      // No Dockerfile
    }

    // Check for static site (index.html)
    try {
      await this.getFileContent(accessToken, owner, repo, 'index.html', ref);
      return {
        framework: 'static',
        buildCommand: null,
        installCommand: null,
        outputDirectory: '.',
        startCommand: null,
      };
    } catch {
      // No index.html
    }

    return {
      framework: null,
      buildCommand: null,
      installCommand: null,
      outputDirectory: null,
      startCommand: null,
    };
  }

  /**
   * Get file content from repository
   */
  async getFileContent(accessToken: string, owner: string, repo: string, path: string, ref = 'main'): Promise<string> {
    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3.raw',
      },
    });

    if (!response.ok) {
      throw new Error(`File not found: ${path}`);
    }

    return response.text();
  }

  // ============ Database Operations ============

  /**
   * Save or update GitHub integration for user
   */
  async saveIntegration(userId: string, tokenData: {
    access_token: string;
    scope: string;
  }, githubUser: GitHubUser): Promise<GitIntegration> {
    // Check if user already has a GitHub integration
    const existing = await db.query.gitIntegrations.findFirst({
      where: and(
        eq(gitIntegrations.userId, userId),
        eq(gitIntegrations.provider, 'github')
      ),
    });

    const encryptedToken = encrypt(tokenData.access_token);

    if (existing) {
      // Update existing integration
      const [updated] = await db
        .update(gitIntegrations)
        .set({
          accessToken: encryptedToken,
          scopes: tokenData.scope,
          providerUsername: githubUser.login,
          updatedAt: new Date(),
        })
        .where(eq(gitIntegrations.id, existing.id))
        .returning();

      return updated;
    }

    // Create new integration
    const [integration] = await db
      .insert(gitIntegrations)
      .values({
        userId,
        provider: 'github',
        providerAccountId: String(githubUser.id),
        providerUsername: githubUser.login,
        accessToken: encryptedToken,
        scopes: tokenData.scope,
      })
      .returning();

    return integration;
  }

  /**
   * Get user's GitHub integration
   */
  async getIntegration(userId: string): Promise<GitIntegration | null> {
    const integration = await db.query.gitIntegrations.findFirst({
      where: and(
        eq(gitIntegrations.userId, userId),
        eq(gitIntegrations.provider, 'github')
      ),
    });

    return integration || null;
  }

  /**
   * Get decrypted access token for user's GitHub integration
   */
  async getAccessToken(userId: string, locale: SupportedLocale): Promise<string> {
    const integration = await this.getIntegration(userId);

    if (!integration) {
      throw new HTTPException(404, { message: t(locale, 'integrations', 'notConnected') });
    }

    return decrypt(integration.accessToken);
  }

  /**
   * Disconnect GitHub integration
   */
  async disconnectIntegration(userId: string): Promise<void> {
    await db
      .delete(gitIntegrations)
      .where(and(
        eq(gitIntegrations.userId, userId),
        eq(gitIntegrations.provider, 'github')
      ));
  }

  /**
   * Check if user has GitHub connected
   */
  async isConnected(userId: string): Promise<boolean> {
    const integration = await this.getIntegration(userId);
    return integration !== null;
  }

  // ============ Commit Status (PR Status Checks) ============

  /**
   * Set commit status on GitHub
   * Used for PR status checks to show deployment progress/result
   */
  async setCommitStatus(
    accessToken: string,
    owner: string,
    repo: string,
    sha: string,
    state: 'pending' | 'success' | 'failure' | 'error',
    description: string,
    targetUrl?: string,
    context: string = 'Pushify/deployment'
  ): Promise<void> {
    try {
      const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/statuses/${sha}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state,
          description: description.substring(0, 140), // GitHub limit
          target_url: targetUrl,
          context,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        logger.warn({ owner, repo, sha, state, error }, 'Failed to set commit status');
        // Don't throw - status updates are non-critical
      } else {
        logger.info({ owner, repo, sha, state }, 'Commit status updated');
      }
    } catch (error) {
      logger.error({ error, owner, repo, sha }, 'Error setting commit status');
      // Don't throw - status updates are non-critical
    }
  }

  /**
   * Post or update a comment on a PR
   * Used for preview deployment URLs
   */
  async postPRComment(
    accessToken: string,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    existingCommentId?: number
  ): Promise<number | null> {
    try {
      if (existingCommentId) {
        // Update existing comment
        const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/issues/comments/${existingCommentId}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body }),
        });

        if (!response.ok) {
          logger.warn({ owner, repo, prNumber, existingCommentId }, 'Failed to update PR comment');
          return null;
        }

        return existingCommentId;
      } else {
        // Create new comment
        const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body }),
        });

        if (!response.ok) {
          logger.warn({ owner, repo, prNumber }, 'Failed to post PR comment');
          return null;
        }

        const data = await response.json();
        return data.id;
      }
    } catch (error) {
      logger.error({ error, owner, repo, prNumber }, 'Error posting PR comment');
      return null;
    }
  }

  /**
   * Parse GitHub repo owner and name from URL
   */
  parseRepoFromUrl(gitUrl: string): { owner: string; repo: string } | null {
    // Handle HTTPS URLs: https://github.com/owner/repo.git
    const httpsMatch = gitUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    // Handle SSH URLs: git@github.com:owner/repo.git
    const sshMatch = gitUrl.match(/git@github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    return null;
  }
}

export const githubService = new GitHubService();
