# OpenBidKit 易标 Web 版

基于 [OpenBidKit_Yibiao](https://github.com/FB208/OpenBidKit_Yibiao) 二次开发的非官方社区 Web 版，提供 React + Fastify + Prisma + PostgreSQL 的多用户部署形态。

> 原作者：mark / yibiaoai。Web 二开贡献者：jdcome。本项目不是原作者的官方发布。

[当前修改版源码](https://github.com/jdcome/OpenBidKit-Yibiao-Web) · [原始项目](https://github.com/FB208/OpenBidKit_Yibiao) · [GNU AGPL-3.0](LICENSE) · [NOTICE](NOTICE) · [归属说明](ATTRIBUTION.md)

## 功能

- 仪表盘与多项目管理
- 标书生成、格式管理、标书检查与资源下载
- 企业知识库、工具库、公司资质库和人员资质库
- 问题 FAQ 与使用文档
- 用户注册、审批、角色与模块权限
- 提示词管理
- 系统名称与 Logo 管理
- Fastify API、Prisma schema、PostgreSQL 数据库
- 后台任务、SSE 进度、文档解析和 Word 导出
- Nginx + PM2 生产部署

完整说明见 [功能清单](docs/FEATURES.md) 与 [架构文档](docs/ARCHITECTURE.md)。

## 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- pnpm 10/11
- PostgreSQL 15 或更高版本
- 文档解析需要 LibreOffice，生产部署建议 24.x

## 本地启动

### 1. 配置 PostgreSQL

创建空数据库和独立数据库用户，然后复制服务端环境变量模板：

```powershell
Copy-Item server\.env.example server\.env
```

编辑 `server/.env`：

- 将 `DATABASE_URL` 改为本地数据库连接；
- 为 `JWT_SECRET` 生成至少 32 个随机字符；
- 为 `INITIAL_ADMIN_PASSWORD` 设置至少 12 位的随机密码。

真实 `.env` 已被 Git 忽略，禁止提交。

### 2. 启动后端

```powershell
cd server
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec prisma db push
pnpm run db:seed
pnpm run dev
```

后端默认监听 `http://127.0.0.1:3000`。可使用公开基本设置接口检查服务：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/system-settings
```

### 3. 启动前端

另开终端：

```powershell
Copy-Item client\.env.example client\.env
cd client
npm ci
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。

## 生产部署

生产模式使用 Nginx 托管 `client/dist`，反向代理 `/api` 到 Fastify，PM2 使用项目内 `tsx` 启动 `server/src/index.ts`。详见 [部署指南](docs/DEPLOYMENT.md)。


## 安全

不要在 Issue、日志或提交中提供 API Key、Token、JWT Secret、数据库连接、客户标书或个人信息。安全问题请按 [SECURITY.md](SECURITY.md) 处理。

## 许可证与担保

本软件按 GNU AGPL-3.0-only 提供，不附带任何担保。原项目的作者归属以 [NOTICE](NOTICE) 为准。
