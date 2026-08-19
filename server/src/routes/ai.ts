import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/middleware';
import { getProjectIdHeader } from '../auth/middleware';
import type { PrismaClient } from '@prisma/client';
import { buildMerged } from '../config/store';
import { getAiService } from '../ai/service';

// 受保护路由（需登录）：AI 代理。服务端持真实 key，浏览器永远拿不到明文 key。
// POST /api/ai/chat             → 文本对话（上游流式内部聚合，返回完整 content 字符串）
// POST /api/ai/request-json     → JSON 结构化请求（带重试 + 修复，返回解析后对象）
// POST /api/ai/list-models      → 拉取上游模型列表（body 为表单 config 覆盖，可选）
// POST /api/ai/test-image-model → 生图模型连通性测试（body 为表单 config，含真实 key）
export async function aiRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const ai = getAiService();

  // aiService 抛出的 Error 带 .status/.message + 可能的 aiHttpError（上游响应）。
  // 关键：绝不能把上游 401（API key 无效）透传成路由 401——客户端 http 拦截器会把 401
  // 当作"JWT 失效"自动登出。上游错误统一映射为 502（网关），本地配置/校验错误 400。
  function sendError(reply: any, error: any) {
    let code = 500;
    if (error?.aiHttpError || error?.ai_http_error) code = 502;
    else if (error?.status === 400 || error?.statusCode === 400) code = 400;
    reply.code(code);
    return { success: false, message: error?.message || 'AI 请求失败' };
  }

  // 在 config 上打戳当前项目 id（best-effort 读 X-Project-Id 头；/ai 非项目作用域，不强求），
  // 供 aiService 深栈里的 emitAiHttpError 据此向触发项目的 SSE 通道 fan-out AI 上游错误。
  function stampProjectId(config: any, req: FastifyRequest): any {
    const projectId = getProjectIdHeader(req);
    if (config && typeof config === 'object' && projectId) {
      config.__sseProjectId = projectId;
    }
    return config;
  }

  app.post('/ai/chat', async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const body = (req as FastifyRequest & { body: unknown }).body;
    try {
      const config = stampProjectId(await buildMerged(prisma, user.id), req);
      const content = await ai.chat(config, body);
      return { content };
    } catch (error: any) {
      return sendError(reply, error);
    }
  });

  app.post('/ai/request-json', async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const body = (req as FastifyRequest & { body: unknown }).body;
    try {
      const config = stampProjectId(await buildMerged(prisma, user.id), req);
      const result = await ai.requestJson(config, body);
      return { result };
    } catch (error: any) {
      return sendError(reply, error);
    }
  });

  app.post('/ai/list-models', async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    const body = (req as FastifyRequest & { body: unknown }).body as any;
    try {
      // body 为表单 config 覆盖（含用户正要测试的真实 key/base_url）；缺省回落到存储配置。
      const config = stampProjectId(
        (body && (body.api_key || body.base_url)) ? body : await buildMerged(prisma, user.id),
        req,
      );
      return await ai.listModels(config);
    } catch (error: any) {
      return sendError(reply, error);
    }
  });

  app.post('/ai/test-image-model', async (req, reply) => {
    const body = (req as FastifyRequest & { body: unknown }).body as any;
    try {
      // 表单 config（含真实 key）由前端提供；服务端只做代理测试，不落盘。
      return await ai.testImageModel(stampProjectId(body || {}, req));
    } catch (error: any) {
      return sendError(reply, error);
    }
  });
}
