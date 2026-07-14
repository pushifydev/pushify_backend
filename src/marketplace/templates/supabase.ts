import type { MarketplaceTemplate } from '../types';

const composeFile = `services:
  studio:
    image: supabase/studio:20240326-5e5586d
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/api/profile', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]
      timeout: 5s
      interval: 5s
      retries: 3
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
    image: kong:2.8.1
    restart: unless-stopped
    ports:
      - \${KONG_HTTP_PORT:-8000}:8000/tcp
    volumes:
      - ./kong.yml:/home/kong/kong.yml:ro
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
    image: supabase/gotrue:v2.151.0
    depends_on:
      db:
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
      GOTRUE_URI_ALLOW_LIST: \${ADDITIONAL_REDIRECT_URLS:-}
      GOTRUE_DISABLE_SIGNUP: \${DISABLE_SIGNUP:-false}
      GOTRUE_JWT_SECRET: \${JWT_SECRET}
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      # ── Email auth ──
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_MAILER_AUTOCONFIRM: \${MAILER_AUTOCONFIRM:-true}
      GOTRUE_SMTP_HOST: \${SMTP_HOST:-}
      GOTRUE_SMTP_PORT: \${SMTP_PORT:-587}
      GOTRUE_SMTP_USER: \${SMTP_USER:-}
      GOTRUE_SMTP_PASS: \${SMTP_PASS:-}
      GOTRUE_SMTP_ADMIN_EMAIL: \${SMTP_ADMIN_EMAIL:-}
      GOTRUE_SMTP_SENDER_NAME: \${SMTP_SENDER_NAME:-Supabase}
      # ── Phone auth ──
      GOTRUE_EXTERNAL_PHONE_ENABLED: \${ENABLE_PHONE_SIGNUP:-false}
      GOTRUE_SMS_AUTOCONFIRM: "true"
      # ── Anonymous sign-ins ──
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: \${ENABLE_ANONYMOUS_USERS:-false}
      # ── Google OAuth ──
      GOTRUE_EXTERNAL_GOOGLE_ENABLED: \${GOOGLE_ENABLED:-false}
      GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: \${GOOGLE_CLIENT_ID:-}
      GOTRUE_EXTERNAL_GOOGLE_SECRET: \${GOOGLE_SECRET:-}
      GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── GitHub OAuth ──
      GOTRUE_EXTERNAL_GITHUB_ENABLED: \${GITHUB_ENABLED:-false}
      GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: \${GITHUB_CLIENT_ID:-}
      GOTRUE_EXTERNAL_GITHUB_SECRET: \${GITHUB_SECRET:-}
      GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── Discord OAuth ──
      GOTRUE_EXTERNAL_DISCORD_ENABLED: \${DISCORD_ENABLED:-false}
      GOTRUE_EXTERNAL_DISCORD_CLIENT_ID: \${DISCORD_CLIENT_ID:-}
      GOTRUE_EXTERNAL_DISCORD_SECRET: \${DISCORD_SECRET:-}
      GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── Apple OAuth ──
      GOTRUE_EXTERNAL_APPLE_ENABLED: \${APPLE_ENABLED:-false}
      GOTRUE_EXTERNAL_APPLE_CLIENT_ID: \${APPLE_CLIENT_ID:-}
      GOTRUE_EXTERNAL_APPLE_SECRET: \${APPLE_SECRET:-}
      GOTRUE_EXTERNAL_APPLE_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── Facebook OAuth ──
      GOTRUE_EXTERNAL_FACEBOOK_ENABLED: \${FACEBOOK_ENABLED:-false}
      GOTRUE_EXTERNAL_FACEBOOK_CLIENT_ID: \${FACEBOOK_CLIENT_ID:-}
      GOTRUE_EXTERNAL_FACEBOOK_SECRET: \${FACEBOOK_SECRET:-}
      GOTRUE_EXTERNAL_FACEBOOK_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── Twitter OAuth ──
      GOTRUE_EXTERNAL_TWITTER_ENABLED: \${TWITTER_ENABLED:-false}
      GOTRUE_EXTERNAL_TWITTER_CLIENT_ID: \${TWITTER_CLIENT_ID:-}
      GOTRUE_EXTERNAL_TWITTER_SECRET: \${TWITTER_SECRET:-}
      GOTRUE_EXTERNAL_TWITTER_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── LinkedIn OAuth ──
      GOTRUE_EXTERNAL_LINKEDIN_OIDC_ENABLED: \${LINKEDIN_ENABLED:-false}
      GOTRUE_EXTERNAL_LINKEDIN_OIDC_CLIENT_ID: \${LINKEDIN_CLIENT_ID:-}
      GOTRUE_EXTERNAL_LINKEDIN_OIDC_SECRET: \${LINKEDIN_SECRET:-}
      GOTRUE_EXTERNAL_LINKEDIN_OIDC_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── Slack OAuth ──
      GOTRUE_EXTERNAL_SLACK_ENABLED: \${SLACK_ENABLED:-false}
      GOTRUE_EXTERNAL_SLACK_CLIENT_ID: \${SLACK_CLIENT_ID:-}
      GOTRUE_EXTERNAL_SLACK_SECRET: \${SLACK_SECRET:-}
      GOTRUE_EXTERNAL_SLACK_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── Twitch OAuth ──
      GOTRUE_EXTERNAL_TWITCH_ENABLED: \${TWITCH_ENABLED:-false}
      GOTRUE_EXTERNAL_TWITCH_CLIENT_ID: \${TWITCH_CLIENT_ID:-}
      GOTRUE_EXTERNAL_TWITCH_SECRET: \${TWITCH_SECRET:-}
      GOTRUE_EXTERNAL_TWITCH_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── Spotify OAuth ──
      GOTRUE_EXTERNAL_SPOTIFY_ENABLED: \${SPOTIFY_ENABLED:-false}
      GOTRUE_EXTERNAL_SPOTIFY_CLIENT_ID: \${SPOTIFY_CLIENT_ID:-}
      GOTRUE_EXTERNAL_SPOTIFY_SECRET: \${SPOTIFY_SECRET:-}
      GOTRUE_EXTERNAL_SPOTIFY_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback
      # ── Notion OAuth ──
      GOTRUE_EXTERNAL_NOTION_ENABLED: \${NOTION_ENABLED:-false}
      GOTRUE_EXTERNAL_NOTION_CLIENT_ID: \${NOTION_CLIENT_ID:-}
      GOTRUE_EXTERNAL_NOTION_SECRET: \${NOTION_SECRET:-}
      GOTRUE_EXTERNAL_NOTION_REDIRECT_URI: \${API_EXTERNAL_URL}/auth/v1/callback

  rest:
    image: postgrest/postgrest:v12.0.1
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    environment:
      PGRST_DB_URI: postgres://authenticator:\${POSTGRES_PASSWORD}@db:5432/postgres
      PGRST_DB_SCHEMAS: public,storage,graphql_public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: "false"

  realtime:
    image: supabase/realtime:v2.28.32
    depends_on:
      db:
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
    image: supabase/postgres-meta:v0.80.0
    depends_on:
      db:
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
    image: supabase/edge-runtime:v1.45.2
    restart: unless-stopped
    environment:
      JWT_SECRET: \${JWT_SECRET}
      SUPABASE_URL: http://kong:8000
      SUPABASE_ANON_KEY: \${ANON_KEY}
      SUPABASE_SERVICE_ROLE_KEY: \${SERVICE_ROLE_KEY}
      SUPABASE_DB_URL: postgresql://postgres:\${POSTGRES_PASSWORD}@db:5432/postgres
      VERIFY_JWT: "false"
    command: ["start", "--main-service", "/home/deno/functions/main"]

  db:
    image: supabase/postgres:15.1.1.78
    restart: unless-stopped
    healthcheck:
      test: pg_isready -U postgres -h localhost
      interval: 5s
      timeout: 5s
      retries: 10
    environment:
      PGPORT: 5432
      POSTGRES_PORT: 5432
      PGPASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      PGDATABASE: postgres
      POSTGRES_DB: postgres
      JWT_SECRET: \${JWT_SECRET}
      JWT_EXP: 3600
    volumes:
      - supabase-db:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/zz-pushify-roles.sql:ro
    command:
      - postgres
      - -c
      - listen_addresses=*
      - -c
      - shared_preload_libraries=pg_stat_statements,pg_stat_monitor,pgaudit,plpgsql,plpgsql_check,pg_cron,pg_net,timescaledb,auto_explain,pg_tle,plan_filter
      - -c
      - log_min_messages=fatal

  # ── Connection Pooler (Supavisor) ──
  supavisor:
    image: supabase/supavisor:1.1.56
    healthcheck:
      test: ["CMD", "curl", "-sSfL", "http://localhost:4000/api/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    ports:
      - \${POOLER_PROXY_PORT_TRANSACTION:-6543}:6543
    environment:
      PORT: 4000
      POSTGRES_PORT: 5432
      POSTGRES_DB: \${POSTGRES_DB:-postgres}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      DATABASE_URL: ecto://supabase_admin:\${POSTGRES_PASSWORD}@db:5432/_supabase
      CLUSTER_POSTGRES: "true"
      SECRET_KEY_BASE: \${SECRET_KEY_BASE}
      VAULT_ENC_KEY: \${VAULT_ENC_KEY:-your-encryption-key-32-chars-min}
      API_JWT_SECRET: \${JWT_SECRET}
      METRICS_JWT_SECRET: \${JWT_SECRET}
      REGION: local
      ERL_AFLAGS: -proto_dist inet_tcp
      POOLER_TENANT_ID: \${POOLER_TENANT_ID:-default}
      POOLER_DEFAULT_POOL_SIZE: \${POOLER_DEFAULT_POOL_SIZE:-20}
      POOLER_MAX_CLIENT_CONN: \${POOLER_MAX_CLIENT_CONN:-100}
      POOLER_POOL_MODE: transaction
    command:
      - /bin/sh
      - -c
      - "/app/bin/migrate && /app/bin/supavisor eval \\"$$(cat /etc/pool_tenant.exs)\\" && /app/bin/server"

  # ── Log Collector (Vector) ──
  vector:
    image: timberio/vector:0.28.1-alpine
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://vector:9001/health"]
      timeout: 5s
      interval: 5s
      retries: 3
    restart: unless-stopped
    volumes:
      - ./vector.yml:/etc/vector/vector.yml:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command: ["--config", "/etc/vector/vector.yml"]
    environment:
      LOGFLARE_API_KEY: \${LOGFLARE_API_KEY}

  # ── Analytics (Logflare) ──
  analytics:
    image: supabase/logflare:1.4.0
    healthcheck:
      test: ["CMD", "curl", "http://localhost:4000/health"]
      timeout: 5s
      interval: 5s
      retries: 30
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
  // GoTrue/PostgREST accept dozens of tuning vars (e.g. GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK)
  // that aren't in the compose template — forward any the user sets in Environment.
  envPassthrough: {
    auth: ['GOTRUE_'],
    rest: ['PGRST_'],
  },
  // Runs AFTER docker compose up (postgres init may not have set passwords correctly)
  postDeploySql: `-- Pushify post-deploy: force-set Supabase role passwords
ALTER USER supabase_admin WITH PASSWORD '\${POSTGRES_PASSWORD}';
ALTER USER supabase_auth_admin WITH PASSWORD '\${POSTGRES_PASSWORD}';
ALTER USER supabase_storage_admin WITH PASSWORD '\${POSTGRES_PASSWORD}';
ALTER USER authenticator WITH PASSWORD '\${POSTGRES_PASSWORD}';
ALTER USER postgres WITH PASSWORD '\${POSTGRES_PASSWORD}';
SELECT 'Pushify post-deploy: ' || count(*) || ' role passwords reset' AS status
FROM pg_roles WHERE rolname IN ('supabase_admin','supabase_auth_admin','supabase_storage_admin','authenticator','postgres');
`,
  extraFiles: {
    'vector.yml': `# Pushify-managed Vector config for Supabase
api:
  enabled: true
  address: 0.0.0.0:9001

sources:
  docker_host:
    type: docker_logs
    exclude_containers:
      - supabase-vector

transforms:
  project_logs:
    type: remap
    inputs:
      - docker_host
    source: |-
      .project = "default"
      .event_message = del(.message)
      .appname = del(.container_name)
      del(.container_created_at)
      del(.container_id)
      del(.source_type)
      del(.stream)
      del(.label)
      del(.image)
      del(.host)
      del(.stream)

  router:
    type: route
    inputs:
      - project_logs
    route:
      kong: 'starts_with(string!(.appname), "supabase-kong")'
      auth: 'starts_with(string!(.appname), "supabase-auth")'
      rest: 'starts_with(string!(.appname), "supabase-rest")'
      realtime: 'starts_with(string!(.appname), "supabase-realtime")'
      storage: 'starts_with(string!(.appname), "supabase-storage")'
      functions: 'starts_with(string!(.appname), "supabase-functions")'
      db: 'starts_with(string!(.appname), "supabase-db")'

sinks:
  logflare_logs:
    type: 'http'
    inputs:
      - project_logs
    encoding:
      codec: 'json'
    method: 'post'
    request:
      retry_max_duration_secs: 10
    uri: 'http://analytics:4000/api/logs?source_name=postgREST.logs.prod&api_key=\${LOGFLARE_API_KEY?LOGFLARE_API_KEY is required}'
`,
    'init.sql': `-- Pushify init: ensure Supabase roles exist with correct passwords
-- Runs after the official supabase/postgres image's own init scripts
-- File is named with zz- prefix so it's the LAST init script to run
\\set ON_ERROR_STOP on

-- Create _supabase database (used by analytics/logflare/supavisor)
SELECT 'CREATE DATABASE _supabase'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '_supabase')\\gexec

-- Schemas in _supabase
\\c _supabase
CREATE SCHEMA IF NOT EXISTS _analytics;
CREATE SCHEMA IF NOT EXISTS _supavisor;
CREATE SCHEMA IF NOT EXISTS _realtime;

-- Back to main DB
\\c postgres
CREATE SCHEMA IF NOT EXISTS _realtime;

-- Force-set passwords for all Supabase roles to POSTGRES_PASSWORD
-- This is critical: the official supabase/postgres image creates these roles
-- with random/different passwords; we need them all to match POSTGRES_PASSWORD
-- so that auth/rest/storage/etc can connect.
DO $$
DECLARE
  pwd text := '\${POSTGRES_PASSWORD}';
BEGIN
  -- supabase_admin (full access)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    EXECUTE format('CREATE USER supabase_admin SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS LOGIN PASSWORD %L', pwd);
  ELSE
    EXECUTE format('ALTER USER supabase_admin WITH PASSWORD %L', pwd);
  END IF;

  -- supabase_auth_admin (for GoTrue)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE format('CREATE USER supabase_auth_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION PASSWORD %L', pwd);
  ELSE
    EXECUTE format('ALTER USER supabase_auth_admin WITH PASSWORD %L', pwd);
  END IF;
  CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
  GRANT CREATE ON DATABASE postgres TO supabase_auth_admin;
  ALTER USER supabase_auth_admin SET search_path = 'auth';

  -- supabase_storage_admin (for Storage API)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
    EXECUTE format('CREATE USER supabase_storage_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION PASSWORD %L', pwd);
  ELSE
    EXECUTE format('ALTER USER supabase_storage_admin WITH PASSWORD %L', pwd);
  END IF;
  CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;
  GRANT CREATE ON DATABASE postgres TO supabase_storage_admin;
  ALTER USER supabase_storage_admin SET search_path = 'storage';

  -- authenticator (for PostgREST)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE format('CREATE USER authenticator NOINHERIT LOGIN NOREPLICATION PASSWORD %L', pwd);
  ELSE
    EXECUTE format('ALTER USER authenticator WITH PASSWORD %L', pwd);
  END IF;

  -- anon, authenticated, service_role (PostgREST switching)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;

  GRANT anon, authenticated, service_role TO authenticator;

  -- Final pass: re-ALTER all critical users to be 100% sure passwords match
  -- (in case earlier statements were interrupted or run before role creation)
  EXECUTE format('ALTER USER postgres WITH PASSWORD %L', pwd);
  EXECUTE format('ALTER USER supabase_admin WITH PASSWORD %L', pwd);
  EXECUTE format('ALTER USER supabase_auth_admin WITH PASSWORD %L', pwd);
  EXECUTE format('ALTER USER supabase_storage_admin WITH PASSWORD %L', pwd);
  EXECUTE format('ALTER USER authenticator WITH PASSWORD %L', pwd);

  -- Permission grants
  GRANT ALL PRIVILEGES ON DATABASE postgres TO supabase_admin;
  GRANT ALL PRIVILEGES ON DATABASE _supabase TO supabase_admin;
  GRANT USAGE ON SCHEMA _realtime TO supabase_admin;
  GRANT ALL ON ALL TABLES IN SCHEMA _realtime TO supabase_admin;
END
$$;

-- Verify (logged to postgres logs for debugging)
SELECT 'Pushify init complete: ' || count(*)::text || ' supabase roles configured'
FROM pg_roles
WHERE rolname IN ('supabase_admin','supabase_auth_admin','supabase_storage_admin','authenticator','anon','authenticated','service_role');
`,
    'kong.yml': `_format_version: '2.1'
_transform: true

consumers:
  - username: DASHBOARD
  - username: anon
    keyauth_credentials:
      - key: \${ANON_KEY}
  - username: service_role
    keyauth_credentials:
      - key: \${SERVICE_ROLE_KEY}

acls:
  - consumer: anon
    group: anon
  - consumer: service_role
    group: admin

basicauth_credentials:
  - consumer: DASHBOARD
    username: \${DASHBOARD_USERNAME}
    password: \${DASHBOARD_PASSWORD}

services:
  - name: auth-v1
    url: http://auth:9999/
    routes:
      - name: auth-v1-all
        strip_path: true
        paths:
          - /auth/v1/
    plugins:
      - name: cors

  - name: rest-v1
    url: http://rest:3000/
    routes:
      - name: rest-v1-all
        strip_path: true
        paths:
          - /rest/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: true
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon

  - name: realtime-v1-ws
    url: http://realtime:4000/socket
    protocol: ws
    routes:
      - name: realtime-v1-ws
        strip_path: true
        paths:
          - /realtime/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: false

  - name: storage-v1
    url: http://storage:5000/
    routes:
      - name: storage-v1-all
        strip_path: true
        paths:
          - /storage/v1/
    plugins:
      - name: cors

  - name: functions-v1
    url: http://functions:9000/
    routes:
      - name: functions-v1-all
        strip_path: true
        paths:
          - /functions/v1/
    plugins:
      - name: cors

  - name: meta
    url: http://meta:8080/
    routes:
      - name: meta-all
        strip_path: true
        paths:
          - /pg/
    plugins:
      - name: key-auth
        config:
          hide_credentials: false
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin

  - name: dashboard
    url: http://studio:3000/
    routes:
      - name: dashboard-all
        strip_path: false
        paths:
          - /
    plugins:
      - name: cors
      - name: basic-auth
        config:
          hide_credentials: true
`,
  },

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
      key: 'LOGFLARE_API_KEY',
      label: 'Logflare API Key',
      description: 'Internal logging API key',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
    {
      key: 'VAULT_ENC_KEY',
      label: 'Vault Encryption Key',
      description: 'Key used by Supavisor pooler to encrypt secrets at rest',
      required: true,
      type: 'password',
      generate: 'secret',
      hidden: true,
    },
  ],
  minMemoryMb: 6144,
  minDiskGb: 15,
  version: '1.0.0',
  appVersion: '2024.03',
  featured: true,
  volumes: ['supabase-db', 'supabase-storage'],
};
