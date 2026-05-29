import { db } from '../db';
import { gitIntegrations, type GitIntegration } from '../db/schema';
import { encrypt, decrypt } from '../lib/encryption';
import { env } from '../config/env';
import { eq, and } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { t, type SupportedLocale } from '../i18n';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  detectFrameworkFromPackageJson,
  STATIC_FRAMEWORK_RESULT,
} from '../lib/git-framework-detect';

function gitlabBaseUrl(): string {
  return (env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/$/, '');
}

function gitlabApiUrl(): string {
  return `${gitlabBaseUrl()}/api/v4`;
}

export interface GitLabUser {
  id: number;
  username: string;
  avatar_url: string;
  name: string | null;
  email: string | null;
}

/** Normalized repo shape (matches GitHub list for frontend reuse) */
export interface GitLabRepo {
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

export interface GitLabBranch {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

interface GitLabProjectApi {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  visibility: string;
  web_url: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  default_branch: string;
  description: string | null;
  last_activity_at: string;
}

class GitLabService {
  getAuthorizationUrl(state: string): string {
    if (!env.GITLAB_CLIENT_ID) {
      throw new Error('GitLab OAuth is not configured');
    }

    const params = new URLSearchParams({
      client_id: env.GITLAB_CLIENT_ID,
      redirect_uri: env.GITLAB_CALLBACK_URL || '',
      response_type: 'code',
      state,
      scope: 'api read_user read_repository',
    });

    return `${gitlabBaseUrl()}/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<{
    access_token: string;
    token_type: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }> {
    if (!env.GITLAB_CLIENT_ID || !env.GITLAB_CLIENT_SECRET) {
      throw new Error('GitLab OAuth is not configured');
    }

    const response = await fetch(`${gitlabBaseUrl()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: env.GITLAB_CLIENT_ID,
        client_secret: env.GITLAB_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: env.GITLAB_CALLBACK_URL,
      }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new HTTPException(400, {
        message: data.error_description || data.error || 'GitLab token exchange failed',
      });
    }

    return data;
  }

  async getUser(accessToken: string): Promise<GitLabUser> {
    const response = await fetch(`${gitlabApiUrl()}/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new HTTPException(response.status as ContentfulStatusCode, {
        message: 'Failed to fetch GitLab user',
      });
    }

    return response.json();
  }

  private mapProject(p: GitLabProjectApi): GitLabRepo {
    return {
      id: p.id,
      name: p.path,
      full_name: p.path_with_namespace,
      private: p.visibility === 'private' || p.visibility === 'internal',
      html_url: p.web_url,
      clone_url: p.http_url_to_repo,
      ssh_url: p.ssh_url_to_repo,
      default_branch: p.default_branch || 'main',
      description: p.description,
      language: null,
      updated_at: p.last_activity_at,
      pushed_at: p.last_activity_at,
    };
  }

  async getRepositories(
    accessToken: string,
    options?: { page?: number; perPage?: number },
  ): Promise<GitLabRepo[]> {
    const params = new URLSearchParams({
      membership: 'true',
      order_by: 'updated_at',
      sort: 'desc',
      page: String(options?.page || 1),
      per_page: String(options?.perPage || 30),
    });

    const response = await fetch(`${gitlabApiUrl()}/projects?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new HTTPException(response.status as ContentfulStatusCode, {
        message: 'Failed to fetch GitLab projects',
      });
    }

    const projects = (await response.json()) as GitLabProjectApi[];
    return projects.map((p) => this.mapProject(p));
  }

  async getBranches(accessToken: string, projectId: number): Promise<GitLabBranch[]> {
    const response = await fetch(
      `${gitlabApiUrl()}/projects/${projectId}/repository/branches`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      throw new HTTPException(response.status as ContentfulStatusCode, {
        message: 'Failed to fetch GitLab branches',
      });
    }

    const branches = await response.json();
    return branches.map((b: { name: string; commit: { id: string; web_url?: string }; protected?: boolean }) => ({
      name: b.name,
      commit: {
        sha: b.commit.id,
        url: b.commit.web_url || '',
      },
      protected: !!b.protected,
    }));
  }

  async getFileContent(
    accessToken: string,
    projectId: number,
    filePath: string,
    ref: string,
  ): Promise<string> {
    const encodedPath = encodeURIComponent(filePath);
    const response = await fetch(
      `${gitlabApiUrl()}/projects/${projectId}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      throw new Error(`File not found: ${filePath}`);
    }

    return response.text();
  }

  async detectFramework(
    accessToken: string,
    projectId: number,
    branch?: string,
  ): Promise<{
    framework: string | null;
    buildCommand: string | null;
    installCommand: string | null;
    outputDirectory: string | null;
    startCommand: string | null;
  }> {
    const ref = branch || 'main';

    try {
      const packageJson = await this.getFileContent(accessToken, projectId, 'package.json', ref);
      const detected = detectFrameworkFromPackageJson(packageJson);
      if (detected.framework) return detected;
    } catch {
      // no package.json
    }

    try {
      await this.getFileContent(accessToken, projectId, 'Dockerfile', ref);
      return STATIC_FRAMEWORK_RESULT.docker;
    } catch {
      // no Dockerfile
    }

    try {
      await this.getFileContent(accessToken, projectId, 'index.html', ref);
      return STATIC_FRAMEWORK_RESULT.static;
    } catch {
      // no index.html
    }

    return {
      framework: null,
      buildCommand: null,
      installCommand: null,
      outputDirectory: null,
      startCommand: null,
    };
  }

  parseRepoFromUrl(repoUrl: string): { pathWithNamespace: string; projectId?: number } | null {
    try {
      const url = new URL(repoUrl);
      const host = url.hostname;
      if (!host.includes('gitlab')) return null;

      const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
      if (!path) return null;

      return { pathWithNamespace: path };
    } catch {
      return null;
    }
  }

  async postMergeRequestNote(
    accessToken: string,
    projectId: number | string,
    mergeRequestIid: number,
    body: string,
    existingNoteId?: number,
  ): Promise<number | null> {
    const projectRef =
      typeof projectId === 'number' ? String(projectId) : encodeURIComponent(projectId);
    try {
      if (existingNoteId) {
        const response = await fetch(
          `${gitlabApiUrl()}/projects/${projectRef}/merge_requests/${mergeRequestIid}/notes/${existingNoteId}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ body }),
          },
        );
        return existingNoteId;
      }

      const response = await fetch(
        `${gitlabApiUrl()}/projects/${projectRef}/merge_requests/${mergeRequestIid}/notes`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body }),
        },
      );

      if (!response.ok) return null;
      const note = await response.json();
      return note.id ?? null;
    } catch {
      return null;
    }
  }

  async saveIntegration(
    userId: string,
    tokenData: { access_token: string; scope?: string },
    gitlabUser: GitLabUser,
  ): Promise<GitIntegration> {
    const existing = await db.query.gitIntegrations.findFirst({
      where: and(eq(gitIntegrations.userId, userId), eq(gitIntegrations.provider, 'gitlab')),
    });

    const encryptedToken = encrypt(tokenData.access_token);

    if (existing) {
      const [updated] = await db
        .update(gitIntegrations)
        .set({
          accessToken: encryptedToken,
          scopes: tokenData.scope || 'api',
          providerUsername: gitlabUser.username,
          updatedAt: new Date(),
        })
        .where(eq(gitIntegrations.id, existing.id))
        .returning();
      return updated;
    }

    const [integration] = await db
      .insert(gitIntegrations)
      .values({
        userId,
        provider: 'gitlab',
        providerAccountId: String(gitlabUser.id),
        providerUsername: gitlabUser.username,
        accessToken: encryptedToken,
        scopes: tokenData.scope || 'api',
      })
      .returning();

    return integration;
  }

  async getIntegration(userId: string): Promise<GitIntegration | null> {
    const integration = await db.query.gitIntegrations.findFirst({
      where: and(eq(gitIntegrations.userId, userId), eq(gitIntegrations.provider, 'gitlab')),
    });
    return integration || null;
  }

  async getAccessToken(userId: string, locale: SupportedLocale): Promise<string> {
    const integration = await this.getIntegration(userId);
    if (!integration) {
      throw new HTTPException(404, { message: t(locale, 'integrations', 'notConnected') });
    }
    return decrypt(integration.accessToken);
  }

  async disconnectIntegration(userId: string): Promise<void> {
    await db
      .delete(gitIntegrations)
      .where(and(eq(gitIntegrations.userId, userId), eq(gitIntegrations.provider, 'gitlab')));
  }
}

export const gitlabService = new GitLabService();
