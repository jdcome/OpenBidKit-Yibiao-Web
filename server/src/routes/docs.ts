import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';

// 受保护路由（需登录）：使用文档文章（管理员可在 UI 编辑）。
// 3 个顶级 tab 固定：usage(使用) / config(配置) / faq(反馈-常见问题)。
// 登录用户可读；写操作（新建/改/删/排序）仅 admin。
//   GET    /api/docs               → 列表（不含 content，减负载）
//   GET    /api/docs/:id           → 详情（含 content）
//   POST   /api/docs               → 新建（admin, body: {section,title,content?}）
//   PATCH  /api/docs/:id           → 改（admin, body: {title?,content?,section?}）
//   DELETE /api/docs/:id           → 删除（admin）
//   PUT    /api/docs/reorder       → 批量排序（admin, body: {section, items:[{id,sortOrder}]}）
const ALLOWED_SECTION = new Set(['usage', 'config', 'faq']);

type RequestWithUser = FastifyRequest & { user: JwtPayload };
type RequestWithBody = RequestWithUser & { body: unknown };
const paramId = (req: FastifyRequest): string => (req.params as { id: string }).id;
const requireAdmin = (user: JwtPayload, reply: FastifyReply): boolean => {
  if (user.role !== 'admin') {
    reply.code(403).send({ error: '仅管理员可执行此操作' });
    return false;
  }
  return true;
};

export async function docsRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/docs', async () => {
    const rows = await prisma.docsArticle.findMany({
      orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        section: true,
        title: true,
        sortOrder: true,
        updatedAt: true,
      },
    });
    return rows;
  });

  // 静态路由 /reorder 必须先于 /:id 注册（虽然 find-my-way 静态优先，这里显式以求清晰）。
  app.put('/docs/reorder', async (req, reply) => {
    const user = (req as RequestWithBody).user;
    if (!requireAdmin(user, reply)) return;
    const body = (req as RequestWithBody).body as Record<string, unknown> | undefined;
    const section = typeof body?.section === 'string' ? body.section : '';
    if (!ALLOWED_SECTION.has(section)) return reply.code(400).send({ error: '无效的分区' });
    const rawItems = Array.isArray(body?.items) ? (body!.items as unknown[]) : [];
    const items = rawItems
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({ id: String(x.id), sortOrder: Number(x.sortOrder) }))
      .filter((x) => x.id && Number.isFinite(x.sortOrder));
    if (items.length === 0) return reply.send({ ok: true, updated: 0 });

    await prisma.$transaction(
      items.map((it) =>
        prisma.docsArticle.update({
          where: { id: it.id },
          data: { sortOrder: it.sortOrder, updatedById: user.id },
        }),
      ),
    );
    return { ok: true, updated: items.length };
  });

  app.get('/docs/:id', async (req, reply) => {
    const id = paramId(req);
    const art = await prisma.docsArticle.findUnique({ where: { id } });
    if (!art) return reply.code(404).send({ error: '文档不存在' });
    return {
      id: art.id,
      section: art.section,
      title: art.title,
      content: art.content,
      sortOrder: art.sortOrder,
      updatedAt: art.updatedAt,
    };
  });

  app.post('/docs', async (req, reply) => {
    const user = (req as RequestWithBody).user;
    if (!requireAdmin(user, reply)) return;
    const body = (req as RequestWithBody).body as Record<string, unknown> | undefined;
    const section = typeof body?.section === 'string' ? body.section : '';
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!ALLOWED_SECTION.has(section)) return reply.code(400).send({ error: '无效的分区' });
    if (!title) return reply.code(400).send({ error: '请填写标题' });
    const content = typeof body?.content === 'string' ? body.content : '';

    const maxRow = await prisma.docsArticle.aggregate({
      where: { section },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxRow._max.sortOrder ?? 0) + 1;

    const created = await prisma.docsArticle.create({
      data: { section, title, content, sortOrder, updatedById: user.id },
    });
    return { id: created.id };
  });

  app.patch('/docs/:id', async (req, reply) => {
    const user = (req as RequestWithBody).user;
    if (!requireAdmin(user, reply)) return;
    const id = paramId(req);
    const body = (req as RequestWithBody).body as Record<string, unknown> | undefined;
    const data: Record<string, unknown> = { updatedById: user.id };
    if (typeof body?.title === 'string') {
      const title = body.title.trim();
      if (!title) return reply.code(400).send({ error: '标题不能为空' });
      data.title = title;
    }
    if (typeof body?.content === 'string') data.content = body.content;
    if (typeof body?.section === 'string') {
      if (!ALLOWED_SECTION.has(body.section)) return reply.code(400).send({ error: '无效的分区' });
      data.section = body.section;
    }

    try {
      const updated = await prisma.docsArticle.update({ where: { id }, data });
      return { id: updated.id };
    } catch {
      return reply.code(404).send({ error: '文档不存在' });
    }
  });

  app.delete('/docs/:id', async (req, reply) => {
    const user = (req as RequestWithBody).user;
    if (!requireAdmin(user, reply)) return;
    const id = paramId(req);
    try {
      await prisma.docsArticle.delete({ where: { id } });
      return { id };
    } catch {
      return reply.code(404).send({ error: '文档不存在' });
    }
  });
}
