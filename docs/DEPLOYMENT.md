# 部署指南

## 部署方式建议

优先建议部署在企业本地服务器、内网虚拟机或受控私有云中。标书系统会处理招标文件、客户资料、资质证书、知识库素材、导出 Word/PDF 和 AI 生成内容，本地部署更便于控制数据边界、备份策略、访问来源和大模型出网策略。

如果必须部署在公网云平台虚拟机中，应将它按“互联网暴露业务系统”处理：只开放 HTTPS 入口，数据库和后端内部端口不得直接暴露；管理入口建议通过 VPN、堡垒机、云厂商零信任访问或固定来源 IP 安全组限制。

## 环境要求

基础软件：

- Linux 服务器，建议 Ubuntu 22.04/24.04 LTS、Debian 12、Rocky Linux 9 或同等长期支持发行版；
- Node.js 20 或更高版本；
- npm 10 或更高版本；
- pnpm 10/11；
- PostgreSQL 15 或更高版本；
- Nginx；
- PM2；
- LibreOffice 24.x，用于 Office/PDF 文档解析与转换。

推荐硬件：

| 使用规模 | CPU | 运行内存 | 存储空间 | 说明 |
| --- | --- | --- | --- | --- |
| 单人试用/功能验证 | 2 核 | 4 GB | 40 GB SSD | 适合功能验证、少量项目和低并发解析 |
| 约 5 人共同协作 | 4 核 | 8 GB | 80 GB SSD 起 | 适合小团队日常使用，建议给 PostgreSQL、上传目录和备份目录预留独立空间 |
| 约 10 人共同协作 | 8 核 | 16 GB | 160 GB SSD 起 | 适合多项目并行、更多文档解析和后台 AI 任务 |

以上为起步建议，不是硬性上限。影响资源占用的主要因素包括：上传文件大小、Office/PDF 解析并发、知识库规模、后台 AI 任务并发、导出文件保留时间和备份保留周期。生产环境建议为数据库备份和上传文件备份额外预留空间，避免业务盘被备份文件占满。

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
pnpm exec tsx prisma/seed-docs.ts
```

将 `server/.env.example` 复制为未跟踪的 `server/.env`，设置数据库和 JWT 配置。生产 `JWT_SECRET` 至少使用 32 个随机字符。

`pnpm run db:seed` 负责默认管理员和提示词默认值。`pnpm exec tsx prisma/seed-docs.ts` 负责把内置使用文档写入数据库；它是幂等脚本，重复执行会更新文档标题与正文，但保留管理员手动排序。

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

## 通用大模型互通

系统通过服务端配置连接文本模型、生图模型和 Agent 运行时。管理员在 Web 端配置服务商、API Key、模型名称和 Base URL 后，服务端负责发起模型请求，浏览器端不保存模型密钥。

常见互通方式：

- 公网通用大模型：直接配置模型厂商的 API 地址和密钥，部署服务器需要允许访问对应 API 域名；
- 企业统一模型网关：Base URL 指向企业内部 OpenAI-compatible 网关，便于统一审计、限流、密钥轮换和模型路由；
- 本地或私有化模型：Base URL 指向内网推理服务，数据流转范围更可控，但需要自行评估模型质量、上下文长度和并发能力。

安全建议：

- 只在服务端保存 API Key，不要写入前端环境变量、Markdown 文档、截图或日志；
- 使用公网模型前，确认招标文件、客户资料、资质证书和生成内容是否允许出网；
- 通过代理或网关统一控制模型出口，便于审计和密钥轮换；
- 模型测试失败时只记录错误摘要，不输出完整请求头、API Key 或客户原文。

## 首次管理员强制改密

全新安装必须按以下顺序完成，随后才能将服务暴露到不受信任的网络：

1. 在 `server/` 目录依次运行 Prisma generate、schema push、默认数据 seed 和使用文档 seed；
2. 启动服务并打开 Web 登录页；
3. 使用 `admin/admin` 登录一次；
4. 设置至少 12 位、且同时包含大写字母、小写字母、数字和特殊字符的新密码；
5. 确认系统进入应用，并确认 `admin/admin` 已无法再次登录；
6. 在将服务暴露到不受信任的网络前完成以上步骤。

重复运行 seed 不会重置已存在管理员的密码。

## 默认品牌与主题

- 全新安装默认系统名称为“易标投标工具箱web版”。
- 管理员可在“设置 - 基本设置”中修改系统名称和系统 Logo。
- 已经部署过的系统如果数据库中已有自定义系统名称，升级代码不会自动覆盖该名称；需要管理员在设置中手动修改。
- 登录后的顶栏可切换浅色模式和 `soc-dark` 深色模式，选择保存在浏览器本地。

## 云平台虚拟机安全建议

如部署在云服务器或云平台虚拟机中，建议至少完成以下配置：

1. **网络暴露面**
   - 仅开放 80/443，且 80 只用于跳转 HTTPS；
   - 不开放 PostgreSQL、PM2 后端端口、Redis/队列端口或其他内部服务端口；
   - SSH/RDP 管理端口限制固定来源 IP，优先使用 VPN、堡垒机或零信任访问。

2. **传输与账号**
   - 配置可信 TLS 证书；
   - 使用强随机 `JWT_SECRET`；
   - PostgreSQL 使用独立业务账号和最小权限；
   - 首次上线前完成 `admin/admin` 强制改密。

3. **文件与备份**
   - `.env`、数据库备份、上传文件、导出文件和日志不进入 Git 仓库；
   - 定期备份 PostgreSQL 和上传目录；
   - 备份文件建议加密保存，并定期做恢复演练。

4. **模型与出网**
   - 接入公网大模型时，建议通过固定出口、代理网关或企业统一模型网关；
   - 定期轮换模型 API Key；
   - 对包含客户敏感信息的项目，优先使用本地模型或企业许可的私有模型服务。

## 更新

1. 备份 PostgreSQL 和运行数据目录；
2. 更新源码；
3. 安装依赖；
4. 执行 `prisma generate` 与 `prisma db push`；
5. 执行 `pnpm run db:seed` 和 `pnpm exec tsx prisma/seed-docs.ts`；
6. 重新构建前端；
7. `pm2 restart openbidkit-yibiao-web --update-env`；
8. 验证基本设置接口、登录、权限菜单、使用文档、主题切换和静态资源哈希。

不要把真实 `.env`、数据库备份或上传文件放入 Git 仓库。

## 发布范围

上传 GitHub 的内容应包含源码、Prisma schema、内置使用文档、部署示例、LICENSE、NOTICE、归属和 AGPL 合规说明。不要上传生产数据、测试数据、密钥、备份、日志、客户文件、`client/dist`、`node_modules` 或服务端运行数据目录。
