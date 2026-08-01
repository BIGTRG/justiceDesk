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
      name: 'justicedesk-voice',
      cwd: './services/voice',
      script: 'dist/index.js',
      // Single instance: live calls are held in process memory keyed by Twilio call SID.
      // Clustering would route a mid-call webhook to a worker that has never heard of it.
      // Moving sessions to Redis is the prerequisite for scaling this out.
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      env_staging: {
        NODE_ENV: 'staging',
        VOICE_PORT: 4103,
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
        JOBS_METRICS_PORT: 4105,
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
