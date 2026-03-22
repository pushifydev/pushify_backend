import type { MarketplaceTemplate } from '../types';

export const redis: MarketplaceTemplate = {
  id: 'redis',
  name: 'Redis',
  description: 'In-memory data store for caching, sessions, queues, and real-time applications.',
  longDescription: 'Redis is an open-source, in-memory data structure store used as a database, cache, message broker, and streaming engine. It supports data structures such as strings, hashes, lists, sets, sorted sets, bitmaps, and more.',
  icon: 'Database',
  category: 'database',
  tags: ['cache', 'database', 'in-memory', 'key-value'],
  website: 'https://redis.io',
  documentation: 'https://redis.io/docs',
  dockerImage: 'redis:7-alpine',
  port: 6379,
  healthCheckPath: '/',
  envVars: [
    { key: 'REDIS_PASSWORD', label: 'Password', description: 'Redis server password (optional)', required: false, type: 'password', generate: 'password' },
  ],
  minMemoryMb: 64,
  minDiskGb: 1,
  version: '1.0.0',
  appVersion: '7.2',
  featured: false,
  volumes: ['/data'],
};
