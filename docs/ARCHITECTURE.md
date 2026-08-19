# Web 架构

## 组件

- `client/`：React 19 + Vite 7，只负责 UI、请求编排和 SSE 展示。
- `server/`：Fastify 5 权威后端，负责鉴权、权限、文档解析、AI 请求、后台任务、导出和存储。
- `server/prisma/schema.prisma`：PostgreSQL schema 单一真相。
- Nginx：托管前端静态文件并反向代理 `/api` 和 SSE。
- PM2：使用本地 `tsx` 运行 `server/src/index.ts`。

## 请求与数据边界

```text
Browser
  ├─ /             → Nginx → client/dist
  └─ /api + SSE    → Nginx → Fastify → Prisma → PostgreSQL
```

客户端不保存 API Key，不解析或导出权威文档。所有跨网络参数均由服务端重新校验。

## 鉴权与权限

- JWT 分为两种用途：`purpose=access` 的正式会话令牌有效期为 7 天，用于常规受保护接口；`purpose=initial-password-change` 的受限令牌有效期为 10 分钟，只能用于首次改密接口，不能访问业务接口。为兼容升级，旧正式令牌未携带 `purpose` 时仍按正式会话处理。
- `mustChangePassword` 是用户的首次改密状态：全新安装时创建的默认管理员为 `true`，首次改密成功后原子更新为 `false`；已有用户和普通注册用户默认为 `false`。状态为 `true` 时不会签发正式会话令牌。
- 用户角色为 `admin` 或 `user`。
- 普通用户通过模块列表获得功能权限。
- 用户管理与提示词写操作仅管理员可用。
- 项目作用域 API 使用 `X-Project-Id`，服务端校验项目归属。
- 权限在服务端每次请求时生效，前端通过 `/api/me` 定时刷新菜单。

## 数据范围

- 用户域：用户、个人设置、平台配置、提示词、FAQ、导出模板。
- 项目域：技术方案、标书查重、废标检查及后台任务。
- 公司共享域：知识库、工具/公司资产和人员资质。
- 大文件落在服务端运行数据目录，数据库只保存路径和结构化元数据。

## Agent 与 AI

AI 配置与真实密钥只存在服务端。Pi Agent 为默认运行时，OpenCode 兼容路径仅作为回退。开源仓库不包含桌面 vendor 二进制。

## Web-only 边界

本仓库不包含 Electron Main、IPC、桌面更新、桌面许可证和安装包生成。浏览器兼容桥通过 HTTP/SSE 对接后端；桌面专属能力使用明确降级值，不能成为 Web 启动依赖。
