// PM2 ecosystem config for prompt-workbench
// 用法: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "prompt-workbench",
      script: "npm",
      args: "run start",
      cwd: "/srv/hermes-zdd/workspace/prompt-workbench",
      env: {
        PORT: 8110,
        NODE_ENV: "production",
      },
      watch: false,
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      error_file: "/srv/hermes-zdd/workspace/logs/pw-error.log",
      out_file: "/srv/hermes-zdd/workspace/logs/pw-out.log",
    },
  ],
};
