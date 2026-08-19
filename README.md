# OpenBidKit 易标 Web 版

基于 [OpenBidKit_Yibiao](https://github.com/FB208/OpenBidKit_Yibiao) 二次开发的非官方社区 Web 版，提供 React + Fastify + Prisma + PostgreSQL 的多用户部署形态。

> 原作者：mark / yibiaoai。Web 二开贡献者：jdcome。本项目不是原作者的官方发布。

[当前修改版源码](https://github.com/jdcome/OpenBidKit-Yibiao-Web) · [原始项目](https://github.com/FB208/OpenBidKit_Yibiao) · [GNU AGPL-3.0](LICENSE) · [NOTICE](NOTICE) · [归属说明](ATTRIBUTION.md)

## 功能介绍

本仓库提供可独立安装运行的 Web 版标书编制工作台，适合在企业内网或受控服务器中部署，供多人协作完成招标文件解析、方案编写、资料管理、标书检查和系统管理。重点功能包括：

- 仪表盘与多项目管理：展示项目统计、最近项目、资质到期提醒，并作为登录后的工作入口。
- 标书生成：包含生成技术方案、已有方案扩写、投标计算器和响应与偏离表工作台。
  - 生成技术方案：上传招标文件，解析招标内容，按步骤生成技术方案并导出 Word。
  - 已有方案扩写：上传已有方案，在保留原方案真实可落地内容的基础上扩充和优化。
  - 投标计算器：用于汇总综合报价、技术评分和商务评分规则，辅助计算标书最终得分；当前入口保留开发中提示。
  - 响应与偏离表工作台：复用招标原文和分析结果，生成技术响应与偏离表，人工填写响应内容。
- 格式管理：管理我的模板、新建导出模板、Word 排版和编号格式。
- 知识库：方案模板库、工具模板库、公司资质库、人员资质库，支持素材和资质集中管理。
- 标书检查：标书查重、废标项检查和响应完整性检查。
- 使用文档：内置使用教程与配置说明，初次部署后可通过 seed 写入数据库，管理员可继续在线编辑。
- 问题 FAQ：用户提交问题、图片附件，管理员回复并维护状态。
- 用户管理：注册审批、启停账号、角色和模块权限。
- 提示词管理：维护平台提示词，支持恢复默认。
- 深色/浅色模式：登录后可在顶栏切换，选择会保存在浏览器本地。

完整说明见 [功能清单](docs/FEATURES.md)、[架构文档](docs/ARCHITECTURE.md) 与 [功能设计说明](docs/superpowers/specs/2026-08-19-web-module-branding-theme-docs-design.md)。

## 环境要求

基础软件：

- Node.js 20 或更高版本
- npm 10 或更高版本
- pnpm 10/11
- PostgreSQL 15 或更高版本
- 文档解析需要 LibreOffice，生产部署建议 24.x

推荐硬件按“同时在线协作人数、上传文件体积、文档解析并发、AI 任务并发”共同决定。下面是内网部署的起步建议：

| 使用规模 | CPU | 运行内存 | 存储空间 | 适用场景 |
| --- | --- | --- | --- | --- |
| 单人试用/功能验证 | 2 核 | 4 GB | 40 GB SSD | 验证流程、少量项目、低并发文档解析 |
| 约 5 人共同协作 | 4 核 | 8 GB | 80 GB SSD 起 | 小团队日常编制，建议 PostgreSQL、上传目录和备份目录分开规划 |
| 约 10 人共同协作 | 8 核 | 16 GB | 160 GB SSD 起 | 多项目并行、更多文档解析和后台 AI 任务，建议预留独立备份空间 |

如果长期保存大量招标文件、Word/PDF、知识库资料和导出结果，存储空间应按实际文件量继续增加；备份空间不应只计算在业务盘内。

## 部署建议

优先建议本地或企业内网部署。这样做的好处是：

- 招标文件、客户资料、资质证书和生成结果优先保存在自己的服务器中；
- 数据库、上传目录、日志和备份策略可由企业自行控制；
- 可以通过防火墙、VPN、堡垒机和内网域名限制访问范围；
- 与本地 LibreOffice、内网文件服务器、企业代理和私有模型服务集成更方便。

系统可以与通用大模型互通：在 Web 端“设置”中配置文本模型或生图模型的服务商、API Key、模型名称和 Base URL。API Key 保存在服务端配置中，前端不应保存密钥。可连接公网大模型服务，也可连接企业自建的 OpenAI-compatible 网关或本地大模型服务。使用公网模型时，请确认招标文件、客户资料和生成内容是否允许出网。

如需部署在云平台虚拟机中，建议至少做到：

- 只开放 HTTPS 入口，不直接暴露 PostgreSQL、PM2 后端端口或服务器管理端口；
- 使用安全组限制来源 IP，管理入口优先走 VPN、堡垒机或云厂商零信任访问；
- 配置可信 TLS 证书、强随机 `JWT_SECRET`、独立数据库账号和最小权限；
- 首次上线前完成 `admin/admin` 强制改密，并关闭默认密码可用窗口；
- `.env`、数据库备份、上传文件和日志不得进入 Git 仓库；
- 定期备份 PostgreSQL 和上传目录，并测试恢复流程；
- 如果接入公网大模型，建议通过固定出口、代理审计和密钥轮换控制风险。

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

生产模式建议使用 Nginx 托管 `client/dist`，反向代理 `/api` 到 Fastify，PM2 使用项目内 `tsx` 启动 `server/src/index.ts`。详见 [部署指南](docs/DEPLOYMENT.md)。

## 开源义务

本项目仅使用 GNU Affero通用公共许可证v3.0‑only。

> 重要提示：若将本软件部署为Web网络服务提供访问，依据AGPL‑3.0第13条，应当向所有网络访问用户提供当前运行版本完整的对应源码。

详见 [AGPL 合规说明](docs/AGPL-COMPLIANCE.md)。


## 安全

不要在 Issue、日志或提交中提供 API Key、Token、JWT Secret、数据库连接、客户标书或个人信息。安全问题请按 [SECURITY.md](SECURITY.md) 处理。

## 许可证与担保

本软件按 GNU AGPL‑3.0‑only 提供，**不附带任何担保**。。原项目的作者归属以 [NOTICE](NOTICE) 为准。
