# OpenBidKit 易标 Web 版

基于 [OpenBidKit_Yibiao](https://github.com/FB208/OpenBidKit_Yibiao) 二次开发的非官方社区 Web 版，提供 React + Fastify + Prisma + PostgreSQL 的多用户部署形态。全新安装后的默认系统名称为“易标投标工具箱web版”，管理员可在 Web 端修改系统名称和 Logo。

> 原作者：mark / yibiaoai。Web 二开贡献者：jdcome。本项目不是原作者的官方发布。

[当前修改版源码](https://github.com/jdcome/OpenBidKit-Yibiao-Web) · [原始项目](https://github.com/FB208/OpenBidKit_Yibiao) · [GNU AGPL-3.0](LICENSE) · [NOTICE](NOTICE) · [归属说明](ATTRIBUTION.md)

## 功能介绍

本仓库面向“可独立安装运行的 Web 版”整理，重点功能包括：

- 仪表盘与多项目管理：展示项目统计、最近项目、资质到期提醒，并作为登录后的工作入口。
- 标书生成：包含生成技术方案、已有方案扩写、投标计算器和响应与偏离表工作台。
  - 生成技术方案：上传招标文件，解析招标内容，按步骤生成技术方案并导出 Word。
  - 已有方案扩写：上传已有方案，在保留原方案真实可落地内容的基础上扩充和优化。
  - 投标计算器：由原“商务标”入口调整而来，定位为“综合报价、技术、商务评分标准计算标书最终得分”；当前弹窗提示仍保持“正在开发中，敬请期待。”
  - 响应与偏离表工作台：复用招标原文和分析结果，生成技术响应与偏离表，人工填写响应内容。
- 格式管理：管理我的模板、新建导出模板、Word 排版和编号格式。
- 知识库：方案模板库、工具模板库、公司资质库、人员资质库，支持素材和资质集中管理。
- 标书检查：标书查重、废标项检查和响应完整性检查。
- 使用文档：内置使用教程与配置说明，初次部署后可通过 seed 写入数据库，管理员可继续在线编辑。
- 问题 FAQ：用户提交问题、图片附件，管理员回复并维护状态。
- 用户管理：注册审批、启停账号、角色和模块权限。
- 提示词管理：维护平台提示词，支持恢复默认。
- 深色/浅色模式：登录后可在顶栏切换，选择会保存在浏览器本地。
- 开源合规入口：登录页和应用界面保留原作者、原仓库、AGPL、NOTICE 和当前修改版源码链接。

资源下载模块已从当前 Web 版菜单、权限授予范围和相关代码中移除，不再作为默认功能发布。

完整说明见 [功能清单](docs/FEATURES.md)、[架构文档](docs/ARCHITECTURE.md) 与 [功能设计说明](docs/superpowers/specs/2026-08-19-web-module-branding-theme-docs-design.md)。

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
pnpm exec tsx prisma/seed-docs.ts
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

重复运行 `pnpm run db:seed` 不会重置已存在管理员的密码。重复运行 `pnpm exec tsx prisma/seed-docs.ts` 会刷新内置使用文档标题与正文，但不会覆盖管理员手动调整过的排序。

## 生产部署

生产模式使用 Nginx 托管 `client/dist`，反向代理 `/api` 到 Fastify，PM2 使用项目内 `tsx` 启动 `server/src/index.ts`。详见 [部署指南](docs/DEPLOYMENT.md)。

## 开源义务

本项目使用 GNU Affero General Public License v3.0 only。

详见 [AGPL 合规说明](docs/AGPL-COMPLIANCE.md)。


## 安全

不要在 Issue、日志或提交中提供 API Key、Token、JWT Secret、数据库连接、客户标书或个人信息。安全问题请按 [SECURITY.md](SECURITY.md) 处理。

## 许可证与担保

本软件按 GNU AGPL-3.0-only 提供，不附带任何担保。原项目的作者归属以 [NOTICE](NOTICE) 为准。
