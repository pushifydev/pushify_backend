import type { MarketplaceTemplate } from '../types';

export const minio: MarketplaceTemplate = {
  id: 'minio',
  name: 'MinIO',
  description: 'High-performance S3-compatible object storage. Self-hosted AWS S3 alternative.',
  longDescription: 'MinIO is a high-performance, S3-compatible object storage system. It is designed for large-scale AI/ML, data lake, and backup workloads. MinIO is software-defined and runs on any cloud or on-premises infrastructure.',
  icon: 'HardDrive',
  category: 'storage',
  tags: ['s3', 'object-storage', 'backup', 'cloud-native'],
  website: 'https://min.io',
  documentation: 'https://min.io/docs/minio/linux/index.html',
  dockerImage: 'minio/minio:latest',
  dockerCommand: 'server /data --console-address ":9001"',
  port: 9000,
  healthCheckPath: '/minio/health/live',
  envVars: [
    { key: 'MINIO_ROOT_USER', label: 'Root User', description: 'Admin username (min 3 chars)', required: true, default: 'admin', type: 'text' },
    { key: 'MINIO_ROOT_PASSWORD', label: 'Root Password', description: 'Admin password (min 8 chars)', required: true, type: 'password', generate: 'password' },
  ],
  minMemoryMb: 256,
  minDiskGb: 10,
  version: '1.0.0',
  appVersion: '2024-01',
  featured: false,
  volumes: ['/data'],
};
