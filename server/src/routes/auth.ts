import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { signToken } from '../auth/middleware';
import type { JwtPayload } from '../auth/middleware';
import { parseModules } from '../auth/permissions';

// 公开路由（无需登录）：POST /api/login（手机号登录）、POST /api/register（手机号注册，待审批）。
const PHONE_RE = /^1[3-9]\d{9}$/;

export async function authRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  // POST /login { username(手机号), password } → { token, user }。
  // username 列对手机号注册用户存的就是手机号；seed 的 admin 同理。
  app.post('/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = ((req.body ?? {}) as { username?: string; password?: string });
    if (!username || !password) {
      return reply.code(400).send({ error: '手机号和密码必填' });
    }
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return reply.code(401).send({ error: '手机号或密码错误' });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return reply.code(401).send({ error: '手机号或密码错误' });
    }
    // status 门禁：pending→审批中，disabled→已停用。非 active 一律拦截在前端登录之外。
    if (user.status === 'pending') {
      return reply.code(403).send({ error: '账号待管理员审批' });
    }
    if (user.status === 'disabled') {
      return reply.code(403).send({ error: '账号已停用，请联系管理员' });
    }
    const token = signToken({ id: user.id, username: user.username, role: user.role });
    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        phone: user.phone,
        department: user.department,
        modules: parseModules(user.modules),
      },
    };
  });

  // POST /register { phone, password, displayName, department } → 建 status=pending / role=user 账号（username=手机号）。
  app.post('/register', async (req: FastifyRequest, reply: FastifyReply) => {
    const { phone, password, displayName, department } = ((req.body ?? {}) as {
      phone?: string;
      password?: string;
      displayName?: string;
      department?: string;
    });
    if (!phone || !PHONE_RE.test(phone)) {
      return reply.code(400).send({ error: '手机号格式不正确' });
    }
    if (!displayName || !displayName.trim()) {
      return reply.code(400).send({ error: '请输入姓名' });
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: '密码至少 8 位' });
    }
    const exists = await prisma.user.findUnique({ where: { phone } });
    if (exists) {
      return reply.code(409).send({ error: '该手机号已注册' });
    }
    const hashed = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        username: phone,
        phone,
        password: hashed,
        displayName: displayName.trim(),
        department: department?.trim() || null,
        role: 'user',
        status: 'pending',
      },
    });
    return { success: true, message: '注册成功，请等待管理员审批后登录' };
  });
}

// 受保护路由（需登录）：GET /api/me → 返回当前用户最新信息（权限即时生效的拉取端点）。
// 挂在 protectedApp 块（verifyToken 已注入 req.user），不进公开 authRoutes。
// 返回形状与 /login 的 user 完全一致；status 非 active → 401（前端据此 logout）。
export async function meRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = (req as FastifyRequest & { user: JwtPayload }).user;
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user || user.status === 'disabled') {
      return reply.code(401).send({ error: '账号不可用或已停用' });
    }
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        phone: user.phone,
        department: user.department,
        modules: parseModules(user.modules),
      },
    };
  });
}
