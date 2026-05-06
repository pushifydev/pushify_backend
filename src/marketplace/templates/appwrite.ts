import type { MarketplaceTemplate } from '../types';

const composeFile = `services:
  appwrite:
    image: appwrite/appwrite:1.5
    container_name: appwrite
    restart: unless-stopped
    ports:
      - \${KONG_HTTP_PORT:-8080}:80
    depends_on:
      - mariadb
      - redis
    volumes:
      - appwrite-uploads:/storage/uploads
      - appwrite-cache:/storage/cache
      - appwrite-config:/storage/config
      - appwrite-certificates:/storage/certificates
      - appwrite-functions:/storage/functions
    environment:
      _APP_ENV: production
      _APP_WORKER_PER_CORE: 6
      _APP_LOCALE: en
      _APP_OPTIONS_ABUSE: enabled
      _APP_OPTIONS_FORCE_HTTPS: disabled
      _APP_OPENSSL_KEY_V1: \${APPWRITE_SECRET_KEY}
      _APP_DOMAIN: \${APP_DOMAIN:-localhost}
      _APP_DOMAIN_TARGET: \${APP_DOMAIN:-localhost}
      _APP_DOMAIN_FUNCTIONS: \${APP_DOMAIN:-localhost}
      _APP_OPTIONS_ROUTER_PROTECTION: disabled
      _APP_CONSOLE_WHITELIST_ROOT: enabled
      _APP_CONSOLE_WHITELIST_EMAILS: \${APPWRITE_ADMIN_EMAIL}
      _APP_SYSTEM_EMAIL_NAME: Appwrite
      _APP_SYSTEM_EMAIL_ADDRESS: \${APPWRITE_ADMIN_EMAIL}
      _APP_SYSTEM_RESPONSE_FORMAT: ""
      _APP_SYSTEM_SECURITY_EMAIL_ADDRESS: \${APPWRITE_ADMIN_EMAIL}
      _APP_USAGE_STATS: enabled
      _APP_LOGGING_PROVIDER: ""
      _APP_LOGGING_CONFIG: ""
      _APP_USAGE_AGGREGATION_INTERVAL: 30
      _APP_DB_HOST: mariadb
      _APP_DB_PORT: 3306
      _APP_DB_SCHEMA: appwrite
      _APP_DB_USER: user
      _APP_DB_PASS: \${MARIADB_PASSWORD}
      _APP_REDIS_HOST: redis
      _APP_REDIS_PORT: 6379
      _APP_SMTP_HOST: \${SMTP_HOST:-}
      _APP_SMTP_PORT: \${SMTP_PORT:-587}
      _APP_SMTP_USERNAME: \${SMTP_USER:-}
      _APP_SMTP_PASSWORD: \${SMTP_PASS:-}

  mariadb:
    image: mariadb:10.11
    container_name: appwrite-mariadb
    restart: unless-stopped
    volumes:
      - appwrite-mariadb:/var/lib/mysql:rw
    environment:
      MYSQL_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}
      MYSQL_DATABASE: appwrite
      MYSQL_USER: user
      MYSQL_PASSWORD: \${MARIADB_PASSWORD}
    command: 'mysqld --innodb-flush-method=fsync --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci'
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: appwrite-redis
    restart: unless-stopped
    command: >
      redis-server
      --maxmemory            512mb
      --maxmemory-policy     allkeys-lru
      --maxmemory-samples    5
    volumes:
      - appwrite-redis:/data:rw

volumes:
  appwrite-uploads:
  appwrite-cache:
  appwrite-config:
  appwrite-certificates:
  appwrite-functions:
  appwrite-mariadb:
  appwrite-redis:
`;

export const appwrite: MarketplaceTemplate = {
  id: 'appwrite',
  name: 'Appwrite',
  description: 'Open-source backend-as-a-service — Auth, Database, Storage, Functions',
  longDescription: `Appwrite is an open-source backend platform for building Web, Mobile, and Flutter apps.

- **Authentication** — Email/password, OAuth2, magic URLs, phone, anonymous
- **Database** — Document-based with SQL-like queries
- **Storage** — File storage with image processing
- **Functions** — Serverless cloud functions in 15+ languages
- **Realtime** — WebSocket subscriptions to any resource
- **Messaging** — Push notifications, SMS, email
- **GEO & Localization** — Built-in i18n support

Used by **30,000+** developers worldwide.`,
  icon: 'Database',
  category: 'database',
  tags: ['baas', 'firebase-alternative', 'auth', 'storage', 'functions'],
  website: 'https://appwrite.io',
  documentation: 'https://appwrite.io/docs/advanced/self-hosting',

  deploymentType: 'docker-compose',
  composeFile,
  composePublicService: 'appwrite',
  composePublicPort: 80,

  port: 80,
  healthCheckPath: '/v1/health',
  envVars: [
    {
      key: 'APPWRITE_ADMIN_EMAIL',
      label: 'Admin Email',
      description: 'Email for the Appwrite Console root user',
      required: true,
      type: 'email',
    },
    {
      key: 'APPWRITE_SECRET_KEY',
      label: 'Encryption Key',
      description: 'Master encryption key (32 hex chars)',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'MARIADB_PASSWORD',
      label: 'Database Password',
      description: 'Password for Appwrite database user',
      required: true,
      type: 'password',
      generate: 'password',
      hidden: true,
    },
    {
      key: 'MARIADB_ROOT_PASSWORD',
      label: 'Database Root Password',
      description: 'Root password for MariaDB',
      required: true,
      type: 'password',
      generate: 'password',
      hidden: true,
    },
  ],
  minMemoryMb: 2048,
  minDiskGb: 10,
  version: '1.0.0',
  appVersion: '1.5',
  featured: true,
  volumes: ['appwrite-uploads', 'appwrite-mariadb'],
};
