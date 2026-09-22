import { describe, it, expect } from 'vitest';
import { checkComposeFile, checkComposeService, checkHostMount, checkVolumes } from './host-access-guard';

/**
 * Regression: a free-tier project lands on the shared runner, and the marketplace's Portainer
 * template mounts /var/run/docker.sock. That socket is the Docker API — it is root on the box and
 * it walks straight past the network isolation. Nothing checked it.
 */

const shared = { sharedHost: true, projectDir: '/opt/pushify/apps/shop' };
const own = { sharedHost: false, projectDir: '/opt/pushify/apps/shop' };

describe('checkHostMount', () => {
  it('refuses the Docker socket on a shared runner, and says where it does work', () => {
    const problem = checkHostMount('/var/run/docker.sock:/var/run/docker.sock', shared);
    expect(problem).toMatch(/Docker socket/);
    expect(problem).toMatch(/server of your own/);
  });

  it('refuses it read-only too — :ro is the file, not the API', () => {
    expect(checkHostMount('/var/run/docker.sock:/var/run/docker.sock:ro', shared)).not.toBeNull();
  });

  it('refuses any other host path', () => {
    expect(checkHostMount('/:/host', shared)).not.toBeNull();
    expect(checkHostMount('/etc:/etc:ro', shared)).not.toBeNull();
    expect(checkHostMount('/opt/pushify/apps/other-tenant:/data', shared)).not.toBeNull();
    expect(checkHostMount('/opt/pushify/apps/shop/../other:/data', shared)).not.toBeNull();
  });

  it('allows the project its own directory, named volumes and relative paths', () => {
    expect(checkHostMount('/opt/pushify/apps/shop/data:/data', shared)).toBeNull();
    expect(checkHostMount('/opt/pushify/apps/shop:/app', shared)).toBeNull();
    expect(checkHostMount('pgdata:/var/lib/postgresql/data', shared)).toBeNull();
    expect(checkHostMount('./config:/etc/app', shared)).toBeNull();
    expect(checkHostMount('/data', shared)).not.toBeNull();
  });

  it("leaves the customer's own server alone — their host, their call", () => {
    expect(checkHostMount('/var/run/docker.sock:/var/run/docker.sock', own)).toBeNull();
    expect(checkVolumes(['/:/host', '/etc:/etc'], own)).toBeNull();
  });
});

describe('checkComposeService', () => {
  it('refuses the directives that hand over the host', () => {
    expect(checkComposeService('app', { privileged: true }, shared)).toMatch(/privileged/);
    expect(checkComposeService('app', { network_mode: 'host' }, shared)).toMatch(/network_mode/);
    expect(checkComposeService('app', { network_mode: 'container:other' }, shared)).not.toBeNull();
    expect(checkComposeService('app', { pid: 'host' }, shared)).toMatch(/pid: host/);
    expect(checkComposeService('app', { ipc: 'host' }, shared)).not.toBeNull();
    expect(checkComposeService('app', { userns_mode: 'host' }, shared)).not.toBeNull();
    expect(checkComposeService('app', { cap_add: ['SYS_ADMIN'] }, shared)).toMatch(/cap_add/);
    expect(checkComposeService('app', { devices: ['/dev/kvm'] }, shared)).toMatch(/devices/);
    expect(checkComposeService('app', { security_opt: ['seccomp=unconfined'] }, shared)).toMatch(/sandbox/);
  });

  it('leaves the ordinary ones alone', () => {
    expect(
      checkComposeService(
        'app',
        {
          image: 'nginx',
          privileged: false,
          cap_add: [],
          network_mode: 'service:db',
          security_opt: ['no-new-privileges:true'],
          ports: ['8080:80'],
          volumes: ['data:/var/lib/data', './conf:/etc/nginx/conf.d'],
        },
        shared
      )
    ).toBeNull();
  });

  it('checks long-form bind mounts too', () => {
    expect(
      checkComposeService('app', { volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/sock' }] }, shared)
    ).not.toBeNull();
    expect(
      checkComposeService('app', { volumes: [{ type: 'volume', source: 'data', target: '/data' }] }, shared)
    ).toBeNull();
  });
});

describe('checkComposeFile', () => {
  const compose = (body: string) => checkComposeFile(body, shared);

  it('names the offending service', () => {
    const problem = compose(`
services:
  web:
    image: nginx
  vector:
    image: timberio/vector
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`);
    expect(problem).toMatch(/service "vector"/);
  });

  it('catches a host path smuggled in as a named volume', () => {
    expect(
      compose(`
services:
  web:
    image: nginx
    volumes:
      - escape:/host
volumes:
  escape:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /
`)
    ).toMatch(/volume "escape"/);
  });

  it('accepts an ordinary stack', () => {
    expect(
      compose(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
    volumes:
      - ./site:/usr/share/nginx/html:ro
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`)
    ).toBeNull();
  });

  it('refuses what docker compose would only refuse later', () => {
    expect(compose('services: [')).toMatch(/not valid YAML/);
    expect(compose('version: "3"')).toMatch(/no services/);
  });
});
