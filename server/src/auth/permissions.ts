import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';

// 可授予普通用户的功能模块 section id（user-management 恒不授予——仅管理员可用）。
// 与 client/src/shared/permissions.ts ASSIGNABLE_MODULES 保持同源。
export const ASSIGNABLE_MODULE_IDS = ['template-settings', 'knowledge-base', 'bid-check', 'resources', 'docs', 'faq'] as const;

// 默认对所有登录用户开放的模块（不进授予集）：仪表盘、标书生成、设置。
export const DEFAULT_OPEN_MODULE_IDS = ['dashboard', 'bid-generation'] as const;

// 安全解析 User.modules（JSON 字符串数组），过滤为白名单 id 并去重。
export function parseModules(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const allowed = new Set<string>(ASSIGNABLE_MODULE_IDS);
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v === 'string' && allowed.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

// onRequest preHandler 工厂：管理员放行；普通用户需其 modules 含 moduleId。
// 普通用户每请求至多一次 select 查库（admin 不查）。挂在特性路由组上做模块级门禁兜底。
export function createRequireModule(prisma: PrismaClient, moduleId: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (req as FastifyRequest & { user?: { id: number; role: string } }).user;
    if (!user) {
      reply.code(401).send({ error: '未登录' });
      return;
    }
    if (user.role === 'admin') return; // 管理员拥有全部权限
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { modules: true } });
    const granted = parseModules(row?.modules);
    if (!granted.includes(moduleId)) {
      reply.code(403).send({ error: '无该模块访问权限' });
    }
  };
}
