module.exports = {
  apps: [
    {
      name: 'openbidkit-yibiao-web',
      cwd: '/opt/openbidkit-yibiao-web/server',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        YIBIAO_DATA_DIR: '/opt/openbidkit-yibiao-web/data',
      },
      max_memory_restart: '2G',
      autorestart: true,
      time: true,
    },
  ],
};
