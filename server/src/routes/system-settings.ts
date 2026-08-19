import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';
import { getSystemSettings, saveSystemSettings } from '../config/store';

// 基本设置（系统名称 + Logo）。
// GET /api/system-settings：公开（登录页需要在鉴权前展示系统名称/Logo）。
export async function systemSettingsPublicRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/system-settings', async () => {
    return getSystemSettings(prisma);
  });
}

// PUT /api/system-settings：仅管理员（写平台级基本设置）。
export async function systemSettingsAdminRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.put('/system-settings', async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    if (user.role !== 'admin') {
      reply.code(403);
      return { success: false, message: '仅管理员可修改基本设置' };
    }
    const body = (req as FastifyRequest & { body: unknown }).body as { systemName?: string; logoDataUrl?: string | null } | null;
    const result = await saveSystemSettings(prisma, {
      systemName: typeof body?.systemName === 'string' ? body.systemName : undefined,
      logoDataUrl: body?.logoDataUrl === undefined ? undefined : body.logoDataUrl,
    });
    return { success: true, message: '基本设置已保存', ...result };
  });
}
