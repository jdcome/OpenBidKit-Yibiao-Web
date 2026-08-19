# 部署指南

## 目录约定

示例生产目录：

```text
/opt/openbidkit-yibiao-web/
├── client/
└── server/
```

## 后端

```bash
cd /opt/openbidkit-yibiao-web/server
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec prisma db push
pnpm run db:seed
```

将 `server/.env.example` 复制为未跟踪的 `server/.env`，设置数据库、JWT 和管理员初始化变量。生产 `JWT_SECRET` 至少使用 32 个随机字符，管理员初始密码至少 12 位。

复制 `deploy/pm2/ecosystem.config.example.cjs` 到部署目录并按实际路径检查后启动：

```bash
pm2 start deploy/pm2/ecosystem.config.example.cjs
pm2 save
```

## 前端

```bash
cd /opt/openbidkit-yibiao-web/client
npm ci
npm run build
```

将 `deploy/nginx/yibiao-web.conf.example` 安装到 Nginx 站点目录并替换示例域名。配置检查通过后 reload：

```bash
nginx -t
systemctl reload nginx
```

SSE 路由必须关闭 `proxy_buffering`，否则后台任务进度会被缓存。

## 更新

1. 备份 PostgreSQL 和运行数据目录；
2. 更新源码；
3. 安装依赖；
4. 执行 `prisma generate` 与 `prisma db push`；
5. 重新构建前端；
6. `pm2 restart openbidkit-yibiao-web --update-env`；
7. 验证基本设置接口、登录、权限菜单和静态资源哈希。

不要把真实 `.env`、数据库备份或上传文件放入 Git 仓库。
