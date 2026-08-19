import 'dotenv/config';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET?.trim() || '';

if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters');
}

export interface JwtPayload {
  id: number;
  username: string;
  role: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

// onRequest hook：校验 Authorization: Bearer <token>，失败即 401。
export async function verifyToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: '未登录' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as JwtPayload;
    (req as FastifyRequest & { user: JwtPayload }).user = payload;
  } catch {
    reply.code(401).send({ error: 'token 无效或已过期' });
  }
}

// 携带 projectId 的请求类型（requireProject 成功后挂载）。
export type ProjectScopedRequest = FastifyRequest & { user: JwtPayload; projectId: number };

// 从已通过 requireProject 的请求读取 projectId。
export function getProjectId(req: FastifyRequest): number {
  return (req as ProjectScopedRequest).projectId;
}

// 非项目作用域路由（ai / knowledge-base）按需读取 X-Project-Id 头（best-effort，不做鉴权）：
// 仅用于把 AI 上游错误 / KB 抽取进度路由到发起人当前项目的 SSE 通道；缺头时返回 undefined（事件丢弃）。
export function getProjectIdHeader(req: FastifyRequest): string | undefined {
  const raw = req.headers['x-project-id'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(n) : undefined;
}

// 从已鉴权请求读取 userId。
export function getUserId(req: FastifyRequest): number {
  return (req as FastifyRequest & { user: JwtPayload }).user.id;
}

export function getUser(req: FastifyRequest): JwtPayload {
  return (req as FastifyRequest & { user: JwtPayload }).user;
}

// preHandler 工厂：仅管理员通过。挂在 admin 专属路由组（users 等）。
export function createRequireAdmin() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (req as FastifyRequest & { user?: JwtPayload }).user;
    if (!user || user.role !== 'admin') {
      reply.code(403).send({ error: '需要管理员权限' });
    }
  };
}

// preHandler 工厂：解析 X-Project-Id 头、校验用户对该项目的访问权，挂 req.projectId。
// 挂在项目作用域路由组（technical-plan / duplicate-check / rejection-check / export / tasks）。
// SSE (/events) 用 ?projectId= 查询参数，不走此 preHandler，自行解析。
export function createRequireProject(prisma: PrismaClient) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (req as FastifyRequest & { user?: JwtPayload }).user;
    if (!user) {
      reply.code(401).send({ error: '未登录' });
      return;
    }
    const raw = req.headers['x-project-id'];
    const headerValue = Array.isArray(raw) ? raw[0] : raw;
    const projectId = Number(headerValue);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      reply.code(400).send({ error: '缺少有效的 X-Project-Id 请求头' });
      return;
    }
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      reply.code(404).send({ error: '项目不存在' });
      return;
    }
    if (project.ownerId !== user.id && user.role !== 'admin') {
      reply.code(403).send({ error: '无权访问该项目' });
      return;
    }
    (req as ProjectScopedRequest).projectId = projectId;
  };
}
