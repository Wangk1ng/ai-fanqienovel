{
  "apps": [
    {
      "name": "novel-writer",
      "script": "npm",
      "args": "start",
      "cwd": "/workspace",
      "instances": 1,
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "1G",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "token-monitor",
      "script": "node",
      "args": "scripts/token-monitor.js",
      "cwd": "/workspace",
      "instances": 1,
      "autorestart": true,
      "watch": false,
      "cron_restart": "*/10 * * * *",
      "env": {
        "NODE_ENV": "production"
      }
    }
  ]
}
