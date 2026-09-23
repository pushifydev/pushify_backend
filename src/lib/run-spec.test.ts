import { describe, it, expect } from 'vitest';
import { decodeRunSpec, encodeRunSpec, replicaIndex, replicaName, type ContainerRunSpec } from './run-spec';

const spec: ContainerRunSpec = {
  imageName: 'pushify-shop:abc1234',
  containerName: 'pushify-shop',
  containerPort: 3000,
  slot: 'blue',
  bindAddress: '127.0.0.1',
  envVars: { DATABASE_URL: 'postgres://u:p@db:5432/app', NODE_ENV: 'production' },
  volumes: ['pushify-vol-shop-data:/data'],
  networkMode: 'pushify-apps',
};

describe('run spec storage', () => {
  it('survives a round trip, secrets included', () => {
    expect(decodeRunSpec(encodeRunSpec(spec))).toEqual(spec);
  });

  it('does not store the environment in the clear', () => {
    // The row is readable by anyone with database access; the env is the project's secrets
    expect(encodeRunSpec(spec)).not.toContain('postgres://');
    expect(encodeRunSpec(spec)).not.toContain('NODE_ENV');
  });

  it('refuses to guess at a spec it cannot read', () => {
    // "Do not scale" is the right answer here, not a container started with half a spec
    expect(decodeRunSpec(null)).toBeNull();
    expect(decodeRunSpec('')).toBeNull();
    expect(decodeRunSpec('not-encrypted')).toBeNull();
    expect(decodeRunSpec(encodeRunSpec({ ...spec, imageName: '' }))).toBeNull();
  });
});

describe('replica names', () => {
  it('numbers replicas from the primary container', () => {
    expect(replicaName('pushify-shop', 'blue', 1)).toBe('pushify-shop-blue');
    expect(replicaName('pushify-shop', 'blue', 2)).toBe('pushify-shop-blue-2');
    expect(replicaName('pushify-shop', 'green', 5)).toBe('pushify-shop-green-5');
  });

  it('reads the index back out of a name', () => {
    expect(replicaIndex('pushify-shop-blue', 'pushify-shop', 'blue')).toBe(1);
    expect(replicaIndex('pushify-shop-blue-3', 'pushify-shop', 'blue')).toBe(3);
  });

  it('does not mistake another container for a replica', () => {
    expect(replicaIndex('pushify-shop-green', 'pushify-shop', 'blue')).toBeNull();
    expect(replicaIndex('pushify-shop-blue-worker', 'pushify-shop', 'blue')).toBeNull();
    expect(replicaIndex('pushify-shopify-blue', 'pushify-shop', 'blue')).toBeNull();
    expect(replicaIndex('pushify-db-shop', 'pushify-shop', 'blue')).toBeNull();
  });
});
