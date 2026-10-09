import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/runner-routing', () => ({
  resolveProjectServerId: (p: { id: string; serverId: string | null }) => p.serverId || (p.id === 'free-1' ? 'runner-1' : null),
}));
vi.mock('../db', () => ({ db: {} }));

import { metricsServerKey } from './metrics.worker';

describe('metrics collection target', () => {
  it('collects a serverless (free, *.pushify.dev) project from its shared runner, not the control plane', () => {
    expect(metricsServerKey({ projectId: 'free-1', serverId: null })).toBe('runner-1');
  });

  it('keeps projects with their own server on that server, and local only without any runner', () => {
    expect(metricsServerKey({ projectId: 'p2', serverId: 'byos-9' })).toBe('byos-9');
    expect(metricsServerKey({ projectId: 'p3', serverId: null })).toBeNull();
  });
});
