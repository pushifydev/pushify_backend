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
      instances: 1,
      exec_mode: 'fork',
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
