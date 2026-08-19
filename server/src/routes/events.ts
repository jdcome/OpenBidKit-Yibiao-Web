import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { getUser } from '../auth/middleware';
import { eventBus } from '../events/bus';

// M1-P6 SSE 总线路由：单路复用 GET /api/events?projectId=<id>。
//
// 桌面按域分 IPC 通道（tasks:event / knowledge-base:event / ...）；Web 收口成一条
// SSE 流，每帧带 `event: <channel>` 区分域，客户端按 channel 解复用分发到各监听器。
// 一条连接服务所有域，比每域一条省。
//
// 鉴权：挂在受保护区（onRequest verifyToken）。projectId 走 URL 查询参数
// （原生 EventSource 不能设自定义头；@microsoft/fetch-event-source 也兼容此约定）。
// 路由自行解析 + 校验项目归属（SSE 长连接 hijack 较特殊，不走 requireProject preHandler）。
//
// 保活：每 25s 发 `: ping` 注释行——Nginx/反代的 proxy_read_timeout 默认 60s，
// 浏览器 EventSource 也能据此感知连接未被静默掐断。X-Accel-Buffering: no 关闭 Nginx 缓冲。
export async function eventRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;

  app.get('/events', {
    // SSE 长连接，禁用 Fastify 的请求级超时（用 keep-alive + 心跳自管）。
    config: { /* fastify 无内置 SSE 超时选项；依赖 connection: keep-alive */ },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = getUser(req);
    const query = (req.query as { projectId?: string } | undefined) || {};
    const projectIdNum = Number(query.projectId);
    if (!Number.isFinite(projectIdNum) || projectIdNum <= 0) {
      return reply.code(400).send({ error: '缺少有效的 projectId 查询参数' });
    }
    const project = await prisma.project.findUnique({ where: { id: projectIdNum } });
    if (!project) {
      return reply.code(404).send({ error: '项目不存在' });
    }
    if (project.ownerId !== user.id && user.role !== 'admin') {
      return reply.code(403).send({ error: '无权访问该项目' });
    }
    const projectId = String(projectIdNum);

    // hijack 后禁止 reply.send/返回值；直接写 reply.raw（Node ServerResponse）。
    // 注意：hijack 会绕过 @fastify/cors 的 onResponse 注入，CORS 响应头必须在此手写，
    // 否则浏览器跨域 GET 拿不到 ACAO/ACAC → net::ERR_FAILED（curl 不校验 CORS 故不暴露）。
    reply.hijack();

    const origin = req.headers.origin || '';
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // 与 @fastify/cors 配置一致：origin:true + credentials:true → 反射请求 Origin。
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    });
    // 立即 flush 一个注释行，让客户端确认流已建立。
    raw.write(': connected\n\n');

    // 心跳：25s 一次注释行。
    const heartbeat = setInterval(() => {
      if (raw.destroyed || raw.writableEnded) return;
      try {
        raw.write(`: ping ${Date.now()}\n\n`);
      } catch {
        /* 写失败（客户端已断）由 close 事件清理 */
      }
    }, 25000);

    // 订阅总线：每条事件写一帧 SSE（id / event / data）。
    const unsubscribe = eventBus.subscribe(projectId, (event) => {
      if (raw.destroyed || raw.writableEnded) return;
      const payload = JSON.stringify(event.data);
      const frame = `id: ${event.id}\nevent: ${event.channel}\ndata: ${payload}\n\n`;
      try {
        raw.write(frame);
      } catch {
        /* 忽略，由 close 清理 */
      }
    });

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
