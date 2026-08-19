# OpenBidKit 易标 Web 版

基于 [OpenBidKit_Yibiao](https://github.com/FB208/OpenBidKit_Yibiao) 二次开发的非官方社区 Web 版，提供 React + Fastify + Prisma + PostgreSQL 的多用户部署形态。

> 原作者：mark / yibiaoai。Web 二开贡献者：jdcome。本项目不是原作者的官方发布。

[当前修改版源码](https://github.com/jdcome/OpenBidKit-Yibiao-Web) · [原始项目](https://github.com/FB208/OpenBidKit_Yibiao) · [GNU AGPL-3.0](LICENSE) · [NOTICE](NOTICE) · [归属说明](ATTRIBUTION.md)

## 功能

- 仪表盘与多项目管理
- 标书生成、投标计算器、格式管理、标书检查与使用文档
- 企业知识库、工具库、公司资质库和人员资质库
- 问题 FAQ 与使用文档
- 用户注册、审批、角色与模块权限
- 提示词管理
- 默认系统名称“易标投标工具箱web版”，支持系统名称与 Logo 管理
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
- 为 `JWT_SECRET` 生成至少 32 个随机字符。

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

### 4. 完成首次管理员强制改密

全新安装必须按以下顺序完成，随后才能将服务暴露到不受信任的网络：

1. 在 `server/` 目录依次运行 Prisma generate、schema push 和 seed（即上一步中的 `pnpm exec prisma generate`、`pnpm exec prisma db push`、`pnpm run db:seed`）；
2. 打开 Web 登录页；
3. 使用 `admin/admin` 登录一次；
4. 设置至少 12 位、且同时包含大写字母、小写字母、数字和特殊字符的新密码；
5. 确认系统进入应用，并确认 `admin/admin` 已无法再次登录；
6. 在将服务暴露到不受信任的网络前完成以上步骤。

重复运行 seed 不会重置已存在管理员的密码。

## 生产部署

生产模式使用 Nginx 托管 `client/dist`，反向代理 `/api` 到 Fastify，PM2 使用项目内 `tsx` 启动 `server/src/index.ts`。详见 [部署指南](docs/DEPLOYMENT.md)。

## 开源义务

本项目使用 GNU Affero General Public License v3.0 only。

详见 [AGPL 合规说明](docs/AGPL-COMPLIANCE.md)。


## 安全

不要在 Issue、日志或提交中提供 API Key、Token、JWT Secret、数据库连接、客户标书或个人信息。安全问题请按 [SECURITY.md](SECURITY.md) 处理。

## 许可证与担保

本软件按 GNU AGPL-3.0-only 提供，不附带任何担保。原项目的作者归属以 [NOTICE](NOTICE) 为准。
