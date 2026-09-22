/**
 * Copy to ecosystem.config.cjs on the server (gitignored).
 * All configuration values → .env in this directory.
 */
module.exports = {
  apps: [
    {
      name: 'pushify-api',
      cwd: __dirname,
      script: 'dist/index.js',
      // Two instances in cluster mode: `pm2 reload` restarts them one after the other, so a
      // deploy never leaves the API unanswered. Safe because this process serves HTTP only —
      // background jobs run in pushify-worker, and rate limits / WebSockets go through Redis.
      instances: 2,
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        PROCESS_ROLE: 'api',
        PORT: 4000,
      },
    },
    {
      name: 'pushify-worker',
      cwd: __dirname,
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        PROCESS_ROLE: 'worker',
      },
    },
  ],
};
