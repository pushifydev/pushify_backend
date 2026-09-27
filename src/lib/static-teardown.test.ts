import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('../utils/ssh', () => ({ getSSHConnection: vi.fn(), SSHClient: vi.fn() }));
vi.mock('../workers/port-manager', () => ({ releasePort: vi.fn() }));

import { buildStaticTeardownScript } from './project-remote-cleanup';

describe('buildStaticTeardownScript', () => {
  it('removes only the site folder and vhost, never containers', () => {
    const script = buildStaticTeardownScript('my-site-3c6c924f');
    expect(script).toContain('rm -rf /opt/pushify/site-studio/my-site-3c6c924f ');
    expect(script).toContain('/etc/nginx/conf.d/pushify-my-site-3c6c924f.conf');
    expect(script).not.toContain('docker');
  });

  it('refuses a key that could reach the shell', () => {
    expect(() => buildStaticTeardownScript('x; rm -rf /')).toThrow();
  });
});
