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

将 `server/.env.example` 复制为未跟踪的 `server/.env`，设置数据库和 JWT 配置。生产 `JWT_SECRET` 至少使用 32 个随机字符。

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

## 首次管理员强制改密

全新安装必须按以下顺序完成，随后才能将服务暴露到不受信任的网络：

1. 在 `server/` 目录依次运行 Prisma generate、schema push 和 seed（即上文的 `pnpm exec prisma generate`、`pnpm exec prisma db push`、`pnpm run db:seed`）；
2. 启动服务并打开 Web 登录页；
3. 使用 `admin/admin` 登录一次；
4. 设置至少 12 位、且同时包含大写字母、小写字母、数字和特殊字符的新密码；
5. 确认系统进入应用，并确认 `admin/admin` 已无法再次登录；
6. 在将服务暴露到不受信任的网络前完成以上步骤。

重复运行 seed 不会重置已存在管理员的密码。

## 更新

1. 备份 PostgreSQL 和运行数据目录；
2. 更新源码；
3. 安装依赖；
4. 执行 `prisma generate` 与 `prisma db push`；
5. 重新构建前端；
6. `pm2 restart openbidkit-yibiao-web --update-env`；
7. 验证基本设置接口、登录、权限菜单和静态资源哈希。

不要把真实 `.env`、数据库备份或上传文件放入 Git 仓库。
