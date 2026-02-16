module.exports = {
  apps: [{
    name: 'solana-momentum-bot',
    script: 'src/index.js',
    cwd: __dirname,
    exec_mode: 'fork',        // Fork mode — avoids EPIPE issues with cluster
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_restarts: 10,
    restart_delay: 5000
  }]
};
