import { describe, it, expect } from 'vitest';
import { publicPortSiteConfig } from './public-port-proxy';

// Behaviour (URL kept across deploys, legacy port taken over) is covered by the e2e runner case.
describe('publicPortSiteConfig', () => {
  const config = publicPortSiteConfig('shop', 3006, 3011);

  it('listens on the public port and forwards to the container on loopback', () => {
    expect(config).toContain('listen 3006;');
    expect(config).toContain('proxy_pass http://127.0.0.1:3011;');
  });

  it('keeps the port in the Host header the app sees, and websockets working', () => {
    expect(config).toContain('proxy_set_header Host $http_host;');
    expect(config).toContain('proxy_set_header Upgrade $http_upgrade;');
  });
});
