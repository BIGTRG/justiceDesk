// PM2 process definitions. Run: pm2 start ecosystem.config.js --env staging
//
// Note: no production env block is defined on purpose. Phase 1 ships to staging only
// until the compliance gate in COMPLIANCE.md clears.
module.exports = {
  apps: [
    {
      name: 'justicedesk-api',
      cwd: './services/api',
      script: 'dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      env_staging: {
        NODE_ENV: 'staging',
        API_PORT: 4101,
      },
    },
    {
      name: 'justicedesk-ai-gateway',
      cwd: './services/ai-gateway',
      script: 'dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      env_staging: {
        NODE_ENV: 'staging',
        AI_GATEWAY_PORT: 4102,
      },
    },
    {
      name: 'justicedesk-jobs',
      cwd: './services/jobs',
      script: 'dist/index.js',
      // Single instance: BullMQ workers set their own concurrency. Clustering here
      // would multiply concurrency and can double-send reminder SMS.
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      env_staging: {
        NODE_ENV: 'staging',
      },
    },
    {
      name: 'justicedesk-web',
      cwd: './apps/web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '1G',
      env_staging: {
        NODE_ENV: 'staging',
        PORT: 3000,
      },
    },
  ],
}
