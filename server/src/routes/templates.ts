import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';
import { createTemplateStore } from '../templates/store';

// 受保护路由（需登录 + template-settings 模块门禁）：导出模板 CRUD + 共享开关。
// GET    /api/templates         → 列表（普通用户=自己+共享；admin=全量）
// GET    /api/templates/:id     → 取单个（null 表示不存在或无权读）
// POST   /api/templates         → 新建（body=模板 config；可选 is_shared:boolean，admin 默认 true）
// PUT    /api/templates/:id     → 更新（创建者+admin）
// DELETE /api/templates/:id     → 删除（创建者+admin）
// PATCH  /api/templates/:id/share → 翻共享开关（admin only）
export async function templateRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const store = createTemplateStore(prisma);

  function userOf(req: FastifyRequest) {
    const u = (req as FastifyRequest & { user: JwtPayload }).user;
    return { id: u.id, role: u.role };
  }

  app.get('/templates', async (req) => {
    return store.listTemplates(userOf(req));
  });

  app.get('/templates/:id', async (req) => {
    const { id } = req.params as { id: string };
    return store.getTemplate(userOf(req), id);
  });

  app.post('/templates', async (req) => {
    const body = (req as FastifyRequest & { body: any }).body ?? {};
    // is_shared 从 body 剥出，不混进模板 config blob。
    const { is_shared, ...config } = body;
    return store.createTemplate(userOf(req), config, typeof is_shared === 'boolean' ? is_shared : undefined);
  });

  app.put('/templates/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req as FastifyRequest & { body: any }).body ?? {};
    const { is_shared, ...config } = body;
    return store.updateTemplate(userOf(req), id, config);
  });

  app.delete('/templates/:id', async (req) => {
    const { id } = req.params as { id: string };
    return store.deleteTemplate(userOf(req), id);
  });

  app.patch('/templates/:id/share', async (req, reply) => {
    const user = userOf(req);
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可调整共享状态' });
    }
    const { id } = req.params as { id: string };
    const { isShared } = (req as FastifyRequest & { body: any }).body ?? {};
    if (typeof isShared !== 'boolean') {
      return reply.code(400).send({ error: '缺少 isShared 参数' });
    }
    try {
      return await store.setShared(user, id, isShared);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '调整共享失败';
      const code = msg.includes('不存在') ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });
}
