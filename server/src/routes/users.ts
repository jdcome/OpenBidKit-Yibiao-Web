// 用户管理路由（受保护 + requireAdmin——在 index.ts 装配时挂 createRequireAdmin preHandler）。
// 对标 92 Users.vue：注册审批 + 状态切换 + 编辑账号（手机号不可改）+ 删除（禁删自己）。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { getUser } from '../auth/middleware';
import { ASSIGNABLE_MODULE_IDS, parseModules } from '../auth/permissions';

const VALID_ROLES = ['admin', 'user'];

function publicUser(u: any): any {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    phone: u.phone,
    department: u.department,
    role: u.role,
    status: u.status,
    modules: parseModules(u.modules),
    createdAt: u.createdAt,
  };
}

export async function userRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // GET /users?status=pending|active|disabled → { users, pendingCount }
  app.get('/users', async (req: FastifyRequest) => {
    const status = (req.query as { status?: string } | undefined)?.status;
    const where = status && ['pending', 'active', 'disabled'].includes(status) ? { status } : {};
    const [rows, pendingCount] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, username: true, displayName: true, phone: true, department: true,
          role: true, status: true, modules: true, createdAt: true,
        },
      }),
      prisma.user.count({ where: { status: 'pending' } }),
    ]);
    return { users: rows.map(publicUser), pendingCount };
  });

  const paramId = (req: FastifyRequest): number => Number((req.params as { id?: string }).id);

  // POST /users/:id/approve → pending→active
  app.post('/users/:id/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (user.status !== 'pending') return reply.code(409).send({ error: '该用户非待审批状态' });
    const updated = await prisma.user.update({ where: { id }, data: { status: 'active' } });
    return { success: true, user: publicUser(updated) };
  });

  // POST /users/:id/disable → active→disabled（停用账户，保留数据）
  app.post('/users/:id/disable', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req);
    const me = getUser(req);
    if (id === me.id) return reply.code(400).send({ error: '不能停用自己的账号' });
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (user.status !== 'active') return reply.code(409).send({ error: '仅正常状态账户可停用' });
    const updated = await prisma.user.update({ where: { id }, data: { status: 'disabled' } });
    return { success: true, user: publicUser(updated) };
  });

  // POST /users/:id/enable → disabled→active
  app.post('/users/:id/enable', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (user.status !== 'disabled') return reply.code(409).send({ error: '仅停用状态账户可启用' });
    const updated = await prisma.user.update({ where: { id }, data: { status: 'active' } });
    return { success: true, user: publicUser(updated) };
  });

  // PUT /users/:id → 编辑姓名/部门/角色/模板·格式权限位/重置密码。手机号不可改。
  app.put('/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req);
    const body = (req.body ?? {}) as {
      displayName?: string;
      department?: string;
      role?: string;
      modules?: string[];
      password?: string;
    };
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    const data: Record<string, unknown> = {};
    if (typeof body.displayName === 'string') data.displayName = body.displayName.trim() || null;
    if (typeof body.department === 'string') data.department = body.department.trim() || null;
    if (typeof body.role === 'string') {
      if (!VALID_ROLES.includes(body.role)) return reply.code(400).send({ error: '角色取值：admin/user' });
      data.role = body.role;
    }
    if (Array.isArray(body.modules)) {
      const allowed = new Set<string>(ASSIGNABLE_MODULE_IDS);
      const filtered: string[] = [];
      for (const m of body.modules) {
        if (typeof m !== 'string' || m === 'user-management') {
          return reply.code(400).send({ error: '非法模块权限项' });
        }
        if (allowed.has(m) && !filtered.includes(m)) filtered.push(m);
      }
      data.modules = JSON.stringify(filtered);
    }
    if (typeof body.password === 'string' && body.password.length >= 8) {
      data.password = await bcrypt.hash(body.password, 10);
    } else if (body.password !== undefined) {
      return reply.code(400).send({ error: '重置密码至少 8 位' });
    }
    if (!Object.keys(data).length) return reply.code(400).send({ error: '无待更新字段' });
    const updated = await prisma.user.update({ where: { id }, data });
    return { success: true, user: publicUser(updated) };
  });

  // DELETE /users/:id → 删除账户（禁删自己；admin 互删由前端确认）
  app.delete('/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = paramId(req);
    const me = getUser(req);
    if (id === me.id) return reply.code(400).send({ error: '不能删除自己的账号' });
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    await prisma.user.delete({ where: { id } });
    return { success: true, message: '账户已删除' };
  });
}
