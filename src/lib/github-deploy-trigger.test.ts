import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isPreviewEnabled: vi.fn(),
  createOrUpdatePreview: vi.fn(),
  cleanupPreview: vi.fn(),
}));

vi.mock('../repositories/deployment.repository', () => ({ deploymentRepository: {} }));
vi.mock('../services/preview.service', () => ({
  previewService: {
    isPreviewEnabled: h.isPreviewEnabled,
    createOrUpdatePreview: h.createOrUpdatePreview,
    cleanupPreview: h.cleanupPreview,
  },
}));
vi.mock('./push-deploy-gate', () => ({
  checkPushDeployAllowed: vi.fn(),
  recordRefusedPushDeploy: vi.fn(),
}));

import {
  handlePullRequestEvent,
  isPreviewTeardownEvent,
  type GitHubPullRequestPayload,
} from './github-deploy-trigger';

const project = { id: 'p1', name: 'p', organizationId: 'org-1', autoDeploy: true, gitBranch: 'main' };

const prPayload = (
  action: string,
  headRepo: { full_name?: string } | null | undefined,
  baseRepo: { full_name?: string } | undefined = { full_name: 'acme/app' }
): GitHubPullRequestPayload => ({
  action,
  number: 7,
  pull_request: {
    title: 'PR',
    head: { ref: 'main', sha: 'deadbeef', repo: headRepo },
    base: { ref: 'main', repo: baseRepo },
  },
  repository: { full_name: 'acme/app' },
});

describe('handlePullRequestEvent fork protection', () => {
  beforeEach(() => {
    h.isPreviewEnabled.mockReset().mockResolvedValue(true);
    h.createOrUpdatePreview.mockReset().mockResolvedValue({ id: 'prev-1' });
    h.cleanupPreview.mockReset().mockResolvedValue(undefined);
  });

  it('builds a preview for a same-repository PR', async () => {
    const res = await handlePullRequestEvent(project, prPayload('opened', { full_name: 'acme/app' }));
    expect(h.createOrUpdatePreview).toHaveBeenCalledOnce();
    expect(res.previewId).toBe('prev-1');
  });

  it.each(['opened', 'synchronize', 'reopened'])('ignores a fork PR on %s', async (action) => {
    const res = await handlePullRequestEvent(project, prPayload(action, { full_name: 'attacker/app' }));
    expect(h.createOrUpdatePreview).not.toHaveBeenCalled();
    expect(res.message).toContain('fork PR ignored');
    expect(res.previewId).toBeUndefined();
  });

  it('treats a deleted fork (head.repo null) as a fork', async () => {
    const res = await handlePullRequestEvent(project, prPayload('synchronize', null));
    expect(h.createOrUpdatePreview).not.toHaveBeenCalled();
    expect(res.message).toContain('fork PR ignored');
  });

  it('falls back to repository.full_name when base.repo is absent', async () => {
    await handlePullRequestEvent(project, prPayload('opened', { full_name: 'ACME/app' }, undefined));
    expect(h.createOrUpdatePreview).toHaveBeenCalledOnce();
  });

  it('still cleans up on close for a fork PR', async () => {
    await handlePullRequestEvent(project, prPayload('closed', { full_name: 'attacker/app' }));
    expect(h.cleanupPreview).toHaveBeenCalledWith('p1', 7);
  });

  it('still cleans up on close when previews were turned off', async () => {
    h.isPreviewEnabled.mockResolvedValue(false);
    const res = await handlePullRequestEvent(project, prPayload('closed', { full_name: 'acme/app' }));
    expect(h.cleanupPreview).toHaveBeenCalledWith('p1', 7);
    expect(res.message).toContain('cleaned up');
  });

  it('does not build a preview when previews are turned off', async () => {
    h.isPreviewEnabled.mockResolvedValue(false);
    const res = await handlePullRequestEvent(project, prPayload('opened', { full_name: 'acme/app' }));
    expect(h.createOrUpdatePreview).not.toHaveBeenCalled();
    expect(res.message).toContain('disabled');
  });
});

describe('isPreviewTeardownEvent', () => {
  it('is true for a closed GitHub pull_request', () => {
    expect(isPreviewTeardownEvent(prPayload('closed', { full_name: 'acme/app' }))).toBe(true);
  });

  it.each(['opened', 'synchronize', 'reopened', 'edited'])('is false for a GitHub pull_request %s', (action) => {
    expect(isPreviewTeardownEvent(prPayload(action, { full_name: 'acme/app' }))).toBe(false);
  });

  it.each(['close', 'merge'])('is true for a GitLab merge request %s', (action) => {
    expect(isPreviewTeardownEvent({ object_kind: 'merge_request', object_attributes: { action } })).toBe(true);
  });

  it.each(['open', 'update', 'reopen'])('is false for a GitLab merge request %s', (action) => {
    expect(isPreviewTeardownEvent({ object_kind: 'merge_request', object_attributes: { action } })).toBe(false);
  });

  it('is false for pushes and malformed bodies', () => {
    expect(isPreviewTeardownEvent({ ref: 'refs/heads/main', head_commit: null })).toBe(false);
    expect(isPreviewTeardownEvent({ object_kind: 'push', action: 'closed' })).toBe(false);
    expect(isPreviewTeardownEvent({ action: 'closed' })).toBe(false);
    expect(isPreviewTeardownEvent({ object_kind: 'merge_request' })).toBe(false);
    expect(isPreviewTeardownEvent(null)).toBe(false);
    expect(isPreviewTeardownEvent('closed')).toBe(false);
  });
});
