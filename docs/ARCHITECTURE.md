# Web 架构

## 1. 组件

- `client/`：React 19 + Vite 7，只负责 UI、请求编排和 SSE 展示。
- `server/`：Fastify 5 权威后端，负责鉴权、权限、文档解析、AI 请求、后台任务、导出和存储。
- `server/prisma/schema.prisma`：PostgreSQL schema 单一真相。
- Nginx：托管前端静态文件并反向代理 `/api` 和 SSE。
- PM2：使用项目本地 `tsx` 运行 `server/src/index.ts`。

## 2. 请求与数据边界

```text
Browser
  ├─ /             → Nginx → client/dist
  └─ /api + SSE    → Nginx → Fastify → Prisma → PostgreSQL
```

客户端不保存 API Key，不解析或导出权威文档。所有跨网络参数均由服务端重新校验。

## 3. 鉴权与权限

- JWT 分为两种用途：`purpose=access` 的正式会话令牌有效期为 7 天，用于常规受保护接口；`purpose=initial-password-change` 的受限令牌有效期为 10 分钟，只能用于首次改密接口，不能访问业务接口。为兼容升级，旧正式令牌未携带 `purpose` 时仍按正式会话处理。
- `mustChangePassword` 是用户的首次改密状态：全新安装时创建的默认管理员为 `true`，首次改密成功后原子更新为 `false`；已有用户和普通注册用户默认为 `false`。状态为 `true` 时不会签发正式会话令牌。
- 用户角色为 `admin` 或 `user`。
- 普通用户通过模块列表获得功能权限。服务端可授予模块白名单为 `template-settings`、`knowledge-base`、`bid-check`、`docs`、`faq`。
- 默认开放模块为仪表盘、标书生成和设置；用户管理与提示词管理仅管理员可用。
- 用户管理与提示词写操作仅管理员可用。
- 项目作用域 API 使用 `X-Project-Id`，服务端校验项目归属。
- 权限在服务端每次请求时生效，前端通过 `/api/me` 定时刷新菜单。
- 资源下载模块已移除，不在菜单、授权白名单或默认路由中出现。

## 4. 模块边界

- 标书生成：技术方案、已有方案扩写、投标计算器入口、响应与偏离表工作台。
- 格式管理：我的模板、新建模板、导出格式和共享模板。
- 知识库：方案模板库、工具模板库、公司资质库、人员资质库。
- 标书检查：标书查重和废标项检查。
- 使用文档与 FAQ：数据库文章、Markdown 渲染、管理员编辑和用户反馈。
- 管理模块：用户管理、提示词管理、基本设置。

“投标计算器”沿用原业务入口 `business-bid`，仅调整展示名称和功能定位；当前仍保持开发中弹窗。这样可以避免破坏已有路由和未来数据迁移路径。

## 5. 数据范围

- 用户域：用户、个人设置、平台配置、提示词、FAQ、导出模板、使用文档文章。
- 项目域：技术方案、已有方案扩写、响应与偏离表、标书查重、废标检查及后台任务。
- 公司共享域：知识库、工具资产、公司资质和人员资质。
- 大文件落在服务端运行数据目录，数据库只保存路径和结构化元数据。

## 6. 主题、品牌与开源归属

- 初始系统名称来自服务端默认配置：`易标投标工具箱web版`。
- 登录页、顶栏和导出元数据使用系统设置中的名称和 Logo；管理员可在“设置 - 基本设置”中修改。
- 客户端通过 `ThemeProvider` 管理主题，主题值为 `light` 或 `soc-dark`，存储键为 `yibiao_ui_theme`。
- `soc-dark` 主题通过 `html[data-theme='soc-dark']` 作用域覆盖历史浅色样式，尽量不改动各业务组件的结构。
- Markdown 文档和 Mermaid 预览会读取当前主题，保证使用文档在深色模式下可读。
- 开源说明组件在登录页和应用界面展示当前修改版源码、原始项目、AGPL、NOTICE 和作者归属。部署方可通过 `VITE_SOURCE_REPOSITORY_URL` 指向正在运行版本对应源码。

## 7. 使用文档种子

- 静态 Markdown 原稿位于 `server/prisma/seed-docs/`。
- 前端 `client/public/docs/` 保留同名静态文档和图片资源，便于 Markdown 图片路径稳定访问。
- 数据库文章由 `server/prisma/seed-docs.ts` 写入 `docs_articles`。
- seed 使用固定 id 幂等 upsert，刷新标题和正文，不覆盖管理员调整过的排序。

## 8. Agent 与 AI

AI 配置与真实密钥只存在服务端。Pi Agent 为默认运行时，OpenCode 兼容路径仅作为回退。开源仓库不包含桌面 vendor 二进制。

## 9. Web-only 边界

本仓库不包含 Electron Main、IPC、桌面更新、桌面许可证和安装包生成。浏览器兼容桥通过 HTTP/SSE 对接后端；桌面专属能力使用明确降级值，不能成为 Web 启动依赖。
