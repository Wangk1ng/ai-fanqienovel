module.exports = {
  apps: [
    {
      name: "novel-writer",
      script: "npm",
      args: "start",
      cwd: "/workspace",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "token-monitor",
      script: "node",
      args: "scripts/token-monitor.js",
      cwd: "/workspace",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
