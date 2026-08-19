import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';
import { buildMerged, redactSecrets, saveAppConfig, saveUserConfig } from '../config/store';

// 受保护路由（需登录）：真实配置读写。
// GET  /api/config       → 合并 AppConfig+UserConfig 并归一化；非管理员脱敏 AI key
// PUT  /api/config       → 仅管理员：写平台配置（含 key），空 key 不覆盖现有
// PUT  /api/config/user  → 任意用户：写个人偏好白名单字段
export async function configRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/config', async (req) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const merged = await buildMerged(prisma, user.id);
    const config = user.role === 'admin' ? merged : redactSecrets(merged);
    app.log.info({ username: user.username, role: user.role }, 'load config');
    return { config };
  });

  app.put('/config', async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    if (user.role !== 'admin') {
      reply.code(403);
      return { success: false, message: '仅管理员可修改平台配置' };
    }
    const result = await saveAppConfig(prisma, (req as FastifyRequest & { body: unknown }).body);
    return result;
  });

  app.put('/config/user', async (req) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const result = await saveUserConfig(prisma, user.id, (req as FastifyRequest & { body: unknown }).body);
    return result;
  });
}
