module.exports = {
  apps: [{
    name: 'ai-cli-bridge',
    script: 'src/server.ts',
    interpreter: 'bun',
    env_file: '.env',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
    max_memory_restart: '256M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
