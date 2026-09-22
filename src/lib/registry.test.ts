import { describe, it, expect } from 'vitest';
import {
  buildLoginCommand,
  buildLogoutCommand,
  credentialsToApply,
  dockerConfigDir,
  dockerConfigPrefix,
  normalizeRegistry,
  registryOfImage,
  validateCredential,
  validateImageReference,
  validateRegistryHost,
  type RegistryCredential,
} from './registry';

const credential = (overrides: Partial<RegistryCredential> = {}): RegistryCredential => ({
  name: 'GHCR',
  registry: 'ghcr.io',
  username: 'pushify-bot',
  password: 'ghp_secret',
  ...overrides,
});

describe('normalizeRegistry', () => {
  it('keeps a host and drops scheme, path and case', () => {
    expect(normalizeRegistry('https://ghcr.io/')).toBe('ghcr.io');
    expect(normalizeRegistry('Registry.GitLab.com/group')).toBe('registry.gitlab.com');
    expect(normalizeRegistry('registry.example.com:5000')).toBe('registry.example.com:5000');
  });

  it("spells Docker Hub's several names the one way docker login takes", () => {
    for (const name of ['docker.io', 'index.docker.io', 'https://index.docker.io/v1/', 'registry-1.docker.io', '']) {
      expect(normalizeRegistry(name)).toBe('docker.io');
    }
  });
});

describe('registryOfImage', () => {
  it('reads the registry out of the reference', () => {
    expect(registryOfImage('ghcr.io/acme/api:1.2')).toBe('ghcr.io');
    expect(registryOfImage('registry.example.com:5000/team/app')).toBe('registry.example.com:5000');
    expect(registryOfImage('localhost:5000/app')).toBe('localhost:5000');
  });

  it('treats a first part that is not a host as a Docker Hub namespace', () => {
    expect(registryOfImage('nginx:1.27')).toBe('docker.io');
    expect(registryOfImage('library/nginx')).toBe('docker.io');
    expect(registryOfImage('myorg/app:latest')).toBe('docker.io');
  });
});

describe('validation', () => {
  it('accepts real references and refuses shell', () => {
    expect(validateImageReference('ghcr.io/acme/api:1.2')).toBeNull();
    expect(validateImageReference('nginx@sha256:abc123')).toBeNull();
    expect(validateImageReference('ghcr.io/acme/api; rm -rf /')).not.toBeNull();
    expect(validateImageReference('$(id)')).not.toBeNull();
    expect(validateImageReference('ghcr.io/../../etc')).not.toBeNull();
    expect(validateImageReference('')).not.toBeNull();
  });

  it('accepts hosts and refuses everything else', () => {
    expect(validateRegistryHost('ghcr.io')).toBeNull();
    expect(validateRegistryHost('registry.example.com:5000')).toBeNull();
    expect(validateRegistryHost('ghcr.io && curl evil.sh')).not.toBeNull();
    expect(validateRegistryHost('-flag.io')).not.toBeNull();
  });

  it('refuses a password that would close the here-doc early', () => {
    expect(validateCredential({ username: 'u', password: 'p' })).toBeNull();
    expect(validateCredential({ username: 'u', password: 'a\nPUSHIFY_REGISTRY_PW\nb' })).not.toBeNull();
    expect(validateCredential({ username: 'u\nsudo', password: 'p' })).not.toBeNull();
    expect(validateCredential({ username: '', password: 'p' })).not.toBeNull();
  });
});

describe('buildLoginCommand', () => {
  it('sends the password on stdin, so it is not in the command line', () => {
    const cmd = buildLoginCommand('/tmp/cfg', credential());
    expect(cmd).toContain("--password-stdin <<'PUSHIFY_REGISTRY_PW'\nghp_secret\nPUSHIFY_REGISTRY_PW");
    // the secret appears only inside the here-doc body, never as an argument
    expect(cmd.split("<<'PUSHIFY_REGISTRY_PW'")[0]).not.toContain('ghp_secret');
  });

  it("logs in inside the deploy's own config dir, not the server's", () => {
    const cmd = buildLoginCommand('/tmp/cfg', credential());
    expect(cmd).toContain("mkdir -p '/tmp/cfg' && chmod 700 '/tmp/cfg'");
    expect(cmd).toContain("docker --config '/tmp/cfg' login 'ghcr.io'");
  });

  it('uses the endpoint Docker Hub actually answers on', () => {
    expect(buildLoginCommand('/tmp/cfg', credential({ registry: 'docker.io' }))).toContain(
      "login 'https://index.docker.io/v1/'"
    );
  });

  it('quotes a username with a quote in it', () => {
    expect(buildLoginCommand('/tmp/cfg', credential({ username: "o'brien" }))).toContain("--username 'o'\\''brien'");
  });
});

describe("the deploy's own config dir", () => {
  it('is per deploy and holds no path tricks', () => {
    expect(dockerConfigDir('abc-123')).toBe('/tmp/pushify-registry-abc-123');
    expect(dockerConfigDir('../../etc/pass wd')).toBe('/tmp/pushify-registry-etcpasswd');
  });

  it('is removed afterwards, and without one docker keeps its usual configuration', () => {
    expect(buildLogoutCommand('/tmp/cfg')).toBe("rm -rf '/tmp/cfg'");
    expect(dockerConfigPrefix('/tmp/cfg')).toBe("DOCKER_CONFIG='/tmp/cfg' ");
    expect(dockerConfigPrefix(null)).toBe('');
  });
});

describe('credentialsToApply', () => {
  it('keeps one login per registry — the first the organization stored', () => {
    const applied = credentialsToApply([
      credential({ name: 'first' }),
      credential({ name: 'second', registry: 'https://ghcr.io/' }),
      credential({ name: 'hub', registry: 'index.docker.io' }),
    ]);
    expect(applied.map((c) => c.name)).toEqual(['first', 'hub']);
    expect(applied.map((c) => c.registry)).toEqual(['ghcr.io', 'docker.io']);
  });
});
