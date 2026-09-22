import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { composePortOverride, containerPortOf, planCompose } from './compose-project';

const plan = (yaml: string, options?: { service?: string | null; port?: number | null }) => {
  const result = planCompose(yaml, options);
  if ('error' in result) throw new Error(result.error);
  return result.plan;
};
const failure = (yaml: string, options?: { service?: string | null; port?: number | null }) => {
  const result = planCompose(yaml, options);
  return 'error' in result ? result.error : null;
};

const stack = `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
  db:
    image: postgres:16
    ports:
      - "5432:5432"
  worker:
    image: acme/worker
`;

describe('containerPortOf', () => {
  it('takes the container side, whatever the shape', () => {
    expect(containerPortOf('8080:80')).toBe(80);
    expect(containerPortOf('127.0.0.1:8080:80')).toBe(80);
    expect(containerPortOf('80')).toBe(80);
    expect(containerPortOf(80)).toBe(80);
    expect(containerPortOf('8080:80/tcp')).toBe(80);
    expect(containerPortOf({ target: 3000, published: 8080 })).toBe(3000);
  });

  it('has no answer for a range or nonsense', () => {
    expect(containerPortOf('8000-8010:8000-8010')).toBeNull();
    expect(containerPortOf('nope')).toBeNull();
    expect(containerPortOf(undefined)).toBeNull();
  });
});

describe('planCompose', () => {
  it('serves the one service that publishes a port', () => {
    const result = plan(`
services:
  web:
    image: nginx
    ports: ["8080:80"]
  db:
    image: postgres:16
`);
    expect(result.service).toBe('web');
    expect(result.containerPort).toBe(80);
  });

  it('asks which one when several publish, instead of guessing', () => {
    expect(failure(stack)).toMatch(/More than one service publishes a port \(web, db\)/);
  });

  it('uses the service the project named', () => {
    expect(plan(stack, { service: 'db' })).toMatchObject({ service: 'db', containerPort: 5432 });
  });

  it('lets the project override the port too', () => {
    expect(plan(stack, { service: 'web', port: 3000 }).containerPort).toBe(3000);
  });

  it('says which services exist when the named one is not there', () => {
    expect(failure(stack, { service: 'api' })).toMatch(/no service "api".*web, db, worker/);
  });

  it('refuses a service with no port rather than serving nothing', () => {
    expect(failure(stack, { service: 'worker' })).toMatch(/publishes no port/);
    expect(failure(`
services:
  web:
    image: nginx
`)).toMatch(/No service in the compose file publishes a port/);
  });

  it('refuses a file that is not a compose file', () => {
    expect(failure('services: [')).toMatch(/not valid YAML/);
    expect(failure('name: my-stack')).toMatch(/no services/);
    expect(failure('')).toMatch(/no services/);
  });
});

describe('composePortOverride', () => {
  it('publishes the public service and takes every other port off the host', () => {
    const { yaml, dropped } = composePortOverride(plan(stack, { service: 'web' }), {
      hostPort: 5010,
      bindAddress: '127.0.0.1',
    });
    const parsed = parseYaml(yaml) as { services: Record<string, { ports: string[] }> };
    expect(parsed.services.web.ports).toEqual(['127.0.0.1:5010:80']);
    // A database published on the host is how a stack ends up on the internet
    expect(parsed.services.db.ports).toEqual([]);
    expect(dropped).toEqual(['db']);
    // A service that published nothing is left out entirely
    expect(parsed.services.worker).toBeUndefined();
  });

  it('publishes on all interfaces when no bind address is given (own server)', () => {
    const { yaml } = composePortOverride(plan(stack, { service: 'web' }), { hostPort: 5010 });
    const parsed = parseYaml(yaml) as { services: Record<string, { ports: string[] }> };
    expect(parsed.services.web.ports).toEqual(['5010:80']);
  });
});
