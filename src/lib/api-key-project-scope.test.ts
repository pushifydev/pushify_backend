import { describe, it, expect } from 'vitest';
import {
  apiKeyProjectPathAccess,
  currentApiKeyProjectIds,
  normalizeApiKeyProjectIds,
  runWithApiKeyProjectScope,
} from './api-key-project-scope';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('apiKeyProjectPathAccess', () => {
  const keyProjects = [A];

  it('allows the project list and the metrics overview for reads only', () => {
    expect(apiKeyProjectPathAccess('GET', '/api/v1/projects', keyProjects)).toBe('allowed');
    expect(apiKeyProjectPathAccess('GET', '/api/v1/projects/', keyProjects)).toBe('allowed');
    expect(apiKeyProjectPathAccess('HEAD', '/api/v1/projects', keyProjects)).toBe('allowed');
    expect(apiKeyProjectPathAccess('GET', '/api/v1/projects/overview', keyProjects)).toBe('allowed');
    // Creating a project would make one outside the key's list
    expect(apiKeyProjectPathAccess('POST', '/api/v1/projects', keyProjects)).toBe('outside_project_api');
    expect(apiKeyProjectPathAccess('POST', '/api/v1/projects/overview', keyProjects)).toBe('outside_project_api');
  });

  it('allows any route of a project in the list, whatever the case of the id', () => {
    expect(apiKeyProjectPathAccess('GET', `/api/v1/projects/${A}`, keyProjects)).toBe('allowed');
    expect(apiKeyProjectPathAccess('POST', `/api/v1/projects/${A}/deployments`, keyProjects)).toBe('allowed');
    expect(apiKeyProjectPathAccess('DELETE', `/api/v1/projects/${A}/env/x`, keyProjects)).toBe('allowed');
    expect(apiKeyProjectPathAccess('GET', `/api/v1/projects/${A.toUpperCase()}/metrics`, keyProjects)).toBe('allowed');
  });

  it('answers not-in-scope for another project or a segment that is not a project id', () => {
    expect(apiKeyProjectPathAccess('GET', `/api/v1/projects/${B}`, keyProjects)).toBe('project_not_in_scope');
    expect(apiKeyProjectPathAccess('POST', `/api/v1/projects/${B}/deployments`, keyProjects)).toBe('project_not_in_scope');
    expect(apiKeyProjectPathAccess('GET', '/api/v1/projects/not-a-uuid/env', keyProjects)).toBe('project_not_in_scope');
    expect(apiKeyProjectPathAccess('GET', '/api/v1/projects/overview/extra', keyProjects)).toBe('project_not_in_scope');
  });

  it('allows the MCP endpoint, whose tools apply the key\'s list themselves', () => {
    expect(apiKeyProjectPathAccess('POST', '/api/v1/mcp', keyProjects)).toBe('allowed');
    expect(apiKeyProjectPathAccess('POST', '/api/v1/mcp/', keyProjects)).toBe('allowed');
    expect(apiKeyProjectPathAccess('POST', '/api/v1/mcpx', keyProjects)).toBe('outside_project_api');
    expect(apiKeyProjectPathAccess('GET', '/api/v1/mcp/other', keyProjects)).toBe('outside_project_api');
  });

  it('refuses everything outside the project API', () => {
    for (const path of [
      '/api/v1/servers',
      '/api/v1/databases',
      '/api/v1/dashboard/overview',
      '/api/v1/alerts',
      '/api/v1/activity',
      '/api/v1/organizations',
      '/api/v1/auth/me',
      '/api/v1/marketplace/deployments',
      '/api/v1/static-sites/upload',
      '/api/v1/projectsx',
    ]) {
      expect(apiKeyProjectPathAccess('GET', path, keyProjects)).toBe('outside_project_api');
    }
  });
});

describe('runWithApiKeyProjectScope', () => {
  it('exposes the normalised list inside the run only', async () => {
    expect(currentApiKeyProjectIds()).toBeNull();
    const seen = await runWithApiKeyProjectScope([A.toUpperCase(), A, B], async () => {
      await Promise.resolve();
      return currentApiKeyProjectIds();
    });
    expect(seen).toEqual([A, B]);
    expect(currentApiKeyProjectIds()).toBeNull();
  });

  it('sets nothing for an unscoped key', () => {
    expect(runWithApiKeyProjectScope(null, () => currentApiKeyProjectIds())).toBeNull();
    expect(runWithApiKeyProjectScope(undefined, () => currentApiKeyProjectIds())).toBeNull();
  });

  it('keeps an empty list empty (never "every project")', () => {
    expect(normalizeApiKeyProjectIds([])).toEqual([]);
    expect(runWithApiKeyProjectScope([], () => currentApiKeyProjectIds())).toEqual([]);
  });
});
