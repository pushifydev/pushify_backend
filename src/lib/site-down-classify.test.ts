import { describe, it, expect } from 'vitest';
import { classifySiteDown } from './site-down-classify';

describe('classifySiteDown', () => {
  it('blames the customer when their own server gives no answer', () => {
    expect(classifySiteDown({ downReason: 'server_unreachable', server: { provider: 'self_hosted', managed: false } }).blame).toBe('server');
    // A connected (not managed) cloud server is BYOS too
    expect(classifySiteDown({ downReason: 'server_unreachable', server: { provider: 'hetzner', managed: false } })).toEqual({
      blame: 'server',
      label: 'User server unreachable',
    });
  });

  it('keeps a managed or Pushify-hosted server unreachable on the platform', () => {
    expect(classifySiteDown({ downReason: 'server_unreachable', server: { provider: 'hetzner', managed: true } }).blame).toBe('pushify');
    // No server: the app runs on Pushify's own host
    expect(classifySiteDown({ downReason: 'server_unreachable', server: null }).blame).toBe('pushify');
  });

  it('blames the project for app errors and failed deploys', () => {
    expect(classifySiteDown({ downReason: 'app_error', server: null }).blame).toBe('project');
    expect(classifySiteDown({ downReason: 'deploy_failed', server: { provider: 'self_hosted', managed: false } }).blame).toBe('project');
  });

  it('says unknown when no reason is stored yet', () => {
    expect(classifySiteDown({ downReason: null, server: { provider: 'self_hosted', managed: false } }).blame).toBe('unknown');
  });
});
