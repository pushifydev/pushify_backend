import type { MarketplaceTemplate } from '../types';

const composeFile = `services:
  studio:
    container_name: supabase-studio
    image: supabase/studio:20240326-5e5586d
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/api/profile', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]
      timeout: 5s
      interval: 5s
      retries: 3
    depends_on:
      analytics:
        condition: service_healthy
    environment:
      STUDIO_PG_META_URL: http://meta:8080
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      DEFAULT_ORGANIZATION_NAME: \${STUDIO_DEFAULT_ORGANIZATION:-Default Organization}
      DEFAULT_PROJECT_NAME: \${STUDIO_DEFAULT_PROJECT:-Default Project}
      SUPABASE_URL: http://kong:8000
      SUPABASE_PUBLIC_URL: \${SUPABASE_PUBLIC_URL}
      SUPABASE_ANON_KEY: \${ANON_KEY}
      SUPABASE_SERVICE_KEY: \${SERVICE_ROLE_KEY}
      LOGFLARE_API_KEY: \${LOGFLARE_API_KEY}
      LOGFLARE_URL: http://analytics:4000

  kong:
    container_name: supabase-kong
    image: kong:2.8.1
    restart: unless-stopped
    ports:
      - \${KONG_HTTP_PORT:-8000}:8000/tcp
      - \${KONG_HTTPS_PORT:-8443}:8443/tcp
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /home/kong/kong.yml
      KONG_DNS_ORDER: LAST,A,CNAME
      KONG_PLUGINS: request-transformer,cors,key-auth,acl,basic-auth
      KONG_NGINX_PROXY_PROXY_BUFFER_SIZE: 160k
      KONG_NGINX_PROXY_PROXY_BUFFERS: 64 160k
      SUPABASE_ANON_KEY: \${ANON_KEY}
      SUPABASE_SERVICE_KEY: \${SERVICE_ROLE_KEY}
      DASHBOARD_USERNAME: \${DASHBOARD_USERNAME}
      DASHBOARD_PASSWORD: \${DASHBOARD_PASSWORD}

  auth:
    container_name: supabase-auth
    image: supabase/gotrue:v2.151.0
    depends_on:
      db:
        condition: service_healthy
      analytics:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:9999/health"]
      timeout: 5s
      interval: 5s
      retries: 3
    restart: unless-stopped
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      API_EXTERNAL_URL: \${API_EXTERNAL_URL}
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:\${POSTGRES_PASSWORD}@db:5432/postgres
      GOTRUE_SITE_URL: \${SITE_URL}
      GOTRUE_DISABLE_SIGNUP: "false"
      GOTRUE_JWT_SECRET: \${JWT_SECRET}
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_MAILER_AUTOCONFIRM: "true"

  rest:
    container_name: supabase-rest
    image: postgrest/postgrest:v12.0.1
    depends_on:
      db:
        condition: service_healthy
      analytics:
        condition: service_healthy
    restart: unless-stopped
    environment:
      PGRST_DB_URI: postgres://authenticator:\${POSTGRES_PASSWORD}@db:5432/postgres
      PGRST_DB_SCHEMAS: public,storage,graphql_public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: "false"

  realtime:
    container_name: supabase-realtime
    image: supabase/realtime:v2.28.32
    depends_on:
      db:
        condition: service_healthy
      analytics:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sSfL", "--head", "-o", "/dev/null", "-H", "Authorization: Bearer \${ANON_KEY}", "http://localhost:4000/api/tenants/realtime-dev/health"]
      timeout: 5s
      interval: 5s
      retries: 3
    restart: unless-stopped
    environment:
      PORT: 4000
      DB_HOST: db
      DB_PORT: 5432
      DB_USER: supabase_admin
      DB_PASSWORD: \${POSTGRES_PASSWORD}
      DB_NAME: postgres
      DB_AFTER_CONNECT_QUERY: 'SET search_path TO _realtime'
      DB_ENC_KEY: supabaserealtime
      API_JWT_SECRET: \${JWT_SECRET}
      SECRET_KEY_BASE: \${SECRET_KEY_BASE}
      ERL_AFLAGS: -proto_dist inet_tcp
      DNS_NODES: "''"
      RLIMIT_NOFILE: "10000"
      APP_NAME: realtime
      SEED_SELF_HOST: "true"
      RUN_JANITOR: "true"

  storage:
    container_name: supabase-storage
    image: supabase/storage-api:v0.46.4
    depends_on:
      db:
        condition: service_healthy
      rest:
        condition: service_started
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:5000/status"]
      timeout: 5s
      interval: 5s
      retries: 3
    restart: unless-stopped
    volumes:
      - supabase-storage:/var/lib/storage
    environment:
      ANON_KEY: \${ANON_KEY}
      SERVICE_KEY: \${SERVICE_ROLE_KEY}
      POSTGREST_URL: http://rest:3000
      PGRST_JWT_SECRET: \${JWT_SECRET}
      DATABASE_URL: postgres://supabase_storage_admin:\${POSTGRES_PASSWORD}@db:5432/postgres
      FILE_SIZE_LIMIT: 52428800
      STORAGE_BACKEND: file
      FILE_STORAGE_BACKEND_PATH: /var/lib/storage
      TENANT_ID: stub
      REGION: stub
      GLOBAL_S3_BUCKET: stub
      ENABLE_IMAGE_TRANSFORMATION: "true"
      IMGPROXY_URL: http://imgproxy:5001

  imgproxy:
    container_name: supabase-imgproxy
    image: darthsim/imgproxy:v3.8.0
    restart: unless-stopped
    volumes:
      - supabase-storage:/var/lib/storage:z
    environment:
      IMGPROXY_BIND: ":5001"
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: /
      IMGPROXY_USE_ETAG: "true"
      IMGPROXY_ENABLE_WEBP_DETECTION: \${IMGPROXY_ENABLE_WEBP_DETECTION:-true}

  meta:
    container_name: supabase-meta
    image: supabase/postgres-meta:v0.80.0
    depends_on:
      db:
        condition: service_healthy
      analytics:
        condition: service_healthy
    restart: unless-stopped
    environment:
      PG_META_PORT: 8080
      PG_META_DB_HOST: db
      PG_META_DB_PORT: 5432
      PG_META_DB_NAME: postgres
      PG_META_DB_USER: supabase_admin
      PG_META_DB_PASSWORD: \${POSTGRES_PASSWORD}

  functions:
    container_name: supabase-edge-functions
    image: supabase/edge-runtime:v1.45.2
    restart: unless-stopped
    depends_on:
      analytics:
        condition: service_healthy
    environment:
      JWT_SECRET: \${JWT_SECRET}
      SUPABASE_URL: http://kong:8000
      SUPABASE_ANON_KEY: \${ANON_KEY}
      SUPABASE_SERVICE_ROLE_KEY: \${SERVICE_ROLE_KEY}
      SUPABASE_DB_URL: postgresql://postgres:\${POSTGRES_PASSWORD}@db:5432/postgres
      VERIFY_JWT: "false"
    command: ["start", "--main-service", "/home/deno/functions/main"]

  analytics:
    container_name: supabase-analytics
    image: supabase/logflare:1.4.0
    healthcheck:
      test: ["CMD", "curl", "http://localhost:4000/health"]
      timeout: 5s
      interval: 5s
      retries: 10
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      LOGFLARE_NODE_HOST: 127.0.0.1
      DB_USERNAME: supabase_admin
      DB_DATABASE: _supabase
      DB_HOSTNAME: db
      DB_PORT: 5432
      DB_PASSWORD: \${POSTGRES_PASSWORD}
      DB_SCHEMA: _analytics
      LOGFLARE_API_KEY: \${LOGFLARE_API_KEY}
      LOGFLARE_SINGLE_TENANT: "true"
      LOGFLARE_SUPABASE_MODE: "true"
      LOGFLARE_MIN_CLUSTER_SIZE: 1
      POSTGRES_BACKEND_URL: postgresql://supabase_admin:\${POSTGRES_PASSWORD}@db:5432/_supabase
      POSTGRES_BACKEND_SCHEMA: _analytics
      LOGFLARE_FEATURE_FLAG_OVERRIDE: multibackend=true

  db:
    container_name: supabase-db
    image: supabase/postgres:15.1.1.78
    restart: unless-stopped
    healthcheck:
      test: pg_isready -U postgres -h localhost
      interval: 5s
      timeout: 5s
      retries: 10
    depends_on:
      vector:
        condition: service_healthy
    environment:
      POSTGRES_HOST: /var/run/postgresql
      PGPORT: 5432
      POSTGRES_PORT: 5432
      PGPASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      PGDATABASE: postgres
      POSTGRES_DB: postgres
      JWT_SECRET: \${JWT_SECRET}
      JWT_EXP: 3600
    volumes:
      - supabase-db:/var/lib/postgresql/data:z
    command:
      - postgres
      - -c
      - config_file=/etc/postgresql/postgresql.conf
      - -c
      - log_min_messages=fatal

  vector:
    container_name: supabase-vector
    image: timberio/vector:0.28.1-alpine
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://vector:9001/health"]
      timeout: 5s
      interval: 5s
      retries: 3
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

volumes:
  supabase-db:
  supabase-storage:
`;

export const supabaseTemplate: MarketplaceTemplate = {
  id: 'supabase',
  name: 'Supabase',
  description: 'Open-source Firebase alternative with PostgreSQL, Auth, Realtime, Storage, and Edge Functions',
  longDescription: `Supabase is a complete open-source Firebase alternative. It provides:

- **PostgreSQL Database** with automatic API generation
- **Authentication** with email, social, and magic link login
- **Realtime** subscriptions to database changes
- **Storage** for files with automatic image transformation
- **Edge Functions** for server-side TypeScript functions
- **Studio** dashboard for managing your data

This deployment includes all 9 Supabase services orchestrated via Docker Compose, ready for production use.`,
  icon: 'Database',
  category: 'database',
  tags: ['backend', 'database', 'auth', 'realtime', 'storage', 'firebase-alternative'],
  website: 'https://supabase.com',
  documentation: 'https://supabase.com/docs/guides/self-hosting',

  deploymentType: 'docker-compose',
  composeFile,
  composePublicService: 'kong',
  composePublicPort: 8000,

  port: 8000,
  healthCheckPath: '/',
  envVars: [
    {
      key: 'POSTGRES_PASSWORD',
      label: 'PostgreSQL Password',
      description: 'Master password for the Supabase database',
      required: true,
      type: 'password',
      generate: 'password',
    },
    {
      key: 'JWT_SECRET',
      label: 'JWT Secret',
      description: 'Secret used to sign JWT tokens (min 32 chars)',
      required: true,
      type: 'password',
      generate: 'secret',
    },
    {
      key: 'ANON_KEY',
      label: 'Anonymous API Key',
      description: 'Public anonymous key for client-side requests',
      required: true,
      type: 'password',
      generate: 'secret',
    },
    {
      key: 'SERVICE_ROLE_KEY',
      label: 'Service Role Key',
      description: 'Service role key with full database access (keep secret!)',
      required: true,
      type: 'password',
      generate: 'secret',
    },
    {
      key: 'SECRET_KEY_BASE',
      label: 'Secret Key Base',
      description: 'Base secret for Realtime service',
      required: true,
      type: 'password',
      generate: 'secret',
    },
    {
      key: 'DASHBOARD_USERNAME',
      label: 'Studio Username',
      description: 'Username for accessing the Supabase Studio dashboard',
      required: true,
      type: 'text',
      default: 'supabase',
    },
    {
      key: 'DASHBOARD_PASSWORD',
      label: 'Studio Password',
      description: 'Password for accessing the Supabase Studio dashboard',
      required: true,
      type: 'password',
      generate: 'password',
    },
    {
      key: 'SITE_URL',
      label: 'Site URL',
      description: 'Your application URL (used for auth redirects)',
      required: true,
      type: 'url',
      default: 'http://localhost:3000',
    },
    {
      key: 'API_EXTERNAL_URL',
      label: 'API External URL',
      description: 'Public URL where your Supabase API will be accessible',
      required: true,
      type: 'url',
    },
    {
      key: 'SUPABASE_PUBLIC_URL',
      label: 'Supabase Public URL',
      description: 'Same as API External URL — public URL for the Studio',
      required: true,
      type: 'url',
    },
    {
      key: 'LOGFLARE_API_KEY',
      label: 'Logflare API Key',
      description: 'Internal logging API key',
      required: true,
      type: 'password',
      generate: 'secret',
    },
  ],
  minMemoryMb: 4096,
  minDiskGb: 10,
  version: '1.0.0',
  appVersion: '2024.03',
  featured: true,
  volumes: ['supabase-db', 'supabase-storage'],
};
