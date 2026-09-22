import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { containerPortOf, planCompose, renderDeployableCompose } from './compose-project';

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

describe('renderDeployableCompose', () => {
  /**
   * Regression: this was an override file with `ports: []`, and compose *appends* to `ports:`
   * instead of replacing it — so every original mapping survived and the api stayed published on
   * the host. The e2e caught it. What deploys is a rewritten copy of the file.
   */
  it('publishes the served service and takes every other port off the host', () => {
    const { yaml, dropped } = renderDeployableCompose(stack, plan(stack, { service: 'web' }), {
      hostPort: 5010,
      bindAddress: '127.0.0.1',
    });
    const parsed = parseYaml(yaml) as { services: Record<string, { ports?: string[]; image?: string }> };
    expect(parsed.services.web.ports).toEqual(['127.0.0.1:5010:80']);
    // Not an empty list — the key is gone, because an empty list would have been merged away
    expect(parsed.services.db.ports).toBeUndefined();
    expect('ports' in parsed.services.db).toBe(false);
    expect(dropped).toEqual(['db']);
  });

  it('keeps everything else of the file as it was', () => {
    const { yaml } = renderDeployableCompose(stack, plan(stack, { service: 'web' }), { hostPort: 5010 });
    const parsed = parseYaml(yaml) as {
      services: Record<string, { image?: string; environment?: Record<string, string>; depends_on?: string[]; ports?: string[] }>;
    };
    expect(parsed.services.web.ports).toEqual(['5010:80']);
    expect(parsed.services.db.image).toBe('postgres:16');
    expect(parsed.services.worker.image).toBe('acme/worker');
    // A service that published nothing is untouched
    expect('ports' in parsed.services.worker).toBe(false);
  });

  it('carries the rest of a service through — env, volumes, depends_on', () => {
    const source = `
services:
  web:
    image: nginx
    ports: ["8080:80"]
    environment:
      API: http://api:4000
    depends_on: [api]
    volumes:
      - ./site:/usr/share/nginx/html
  api:
    image: acme/api
    ports: ["4000:4000"]
`;
    const { yaml } = renderDeployableCompose(source, plan(source, { service: 'web' }), { hostPort: 5010 });
    const parsed = parseYaml(yaml) as {
      services: Record<string, { environment?: Record<string, string>; depends_on?: string[]; volumes?: string[]; ports?: string[] }>;
    };
    expect(parsed.services.web.environment).toEqual({ API: 'http://api:4000' });
    expect(parsed.services.web.depends_on).toEqual(['api']);
    expect(parsed.services.web.volumes).toEqual(['./site:/usr/share/nginx/html']);
    expect(parsed.services.api.ports).toBeUndefined();
  });
});
