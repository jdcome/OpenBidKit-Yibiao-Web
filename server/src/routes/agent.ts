import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtPayload } from '../auth/middleware';
import type { AgentPendingQuestion, AgentService, AgentServiceStatus } from '../agent/types';

// Agent sidecar 运维路由（平台级，非项目作用域）。
// GET  /api/agent/status     — 登录用户可读：前端管理员状态卡轮询。
// POST /api/agent/self-check — admin-only：跑固定步骤自检管线（binary/write/tool/direct-model/env），返回报告。
// POST /api/agent/restart    — admin-only：重启 sidecar（SIGTERM 旧进程 → 重 spawn + 健康巡检）。
//
// agentService 始终被 index.ts 无条件 decorate（即便 sidecar 不可用对象也在），故此处仅做存在性兜底；
// 真实可用性由 getStatus().available / .phase 反映（boot 失败、binPath 缺失 → unavailable）。
export async function agentRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const agentService = (app as unknown as { agentService?: AgentService }).agentService;
  const prisma = (app as unknown as { prisma?: PrismaClient }).prisma;

  function stoppedStatus(reason: string): AgentServiceStatus {
    return { phase: 'stopped', available: false, message: reason, queued: 0 };
  }

  async function canAccessAgentQuestion(req: FastifyRequest, question: AgentPendingQuestion | null): Promise<boolean> {
    if (!question) return false;
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    if (user.role === 'admin') return true;
    if (!question.project_id || !prisma?.project) return false;
    const project = await prisma.project.findUnique({
      where: { id: question.project_id },
      select: { ownerId: true },
    });
    return project?.ownerId === user.id;
  }

  app.get('/agent/status', async () => {
    if (!agentService?.getStatus) return stoppedStatus('Agent sidecar 未初始化');
    return agentService.getStatus();
  });

  app.post('/agent/self-check', async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    if (user.role !== 'admin') {
      reply.code(403);
      return { success: false, message: '仅管理员可运行 Agent 自检' };
    }
    if (!agentService?.runSelfCheck) {
      reply.code(503);
      return { success: false, message: 'Agent sidecar 未初始化，无法运行自检' };
    }
    try {
      const report = await agentService.runSelfCheck();
      return { success: true, report };
    } catch (err) {
      reply.code(500);
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/agent/restart', async (req, reply) => {
    const user = (req as FastifyRequest & { user: JwtPayload }).user;
    if (user.role !== 'admin') {
      reply.code(403);
      return { success: false, message: '仅管理员可重启 Agent sidecar' };
    }
    if (!agentService?.restart) {
      reply.code(503);
      return { success: false, message: 'Agent sidecar 未初始化，无法重启' };
    }
    try {
      await agentService.restart('manual-restart-from-ops-route');
      return { success: true, status: agentService.getStatus() };
    } catch (err) {
      reply.code(500);
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // pi ask-user 提问通道（opencode 回退运行时不实现这两个方法 → 503 降级）。
  // GET  /api/agent/pending-question — 登录用户可读：当前挂起的提问（无则 null）。
  // POST /api/agent/answer           — 登录用户作答：{question_id, option_id, custom_answer?}。
  app.get('/agent/pending-question', async (req) => {
    if (!agentService?.getPendingQuestion) return { question: null };
    const question = agentService.getPendingQuestion();
    if (!question) return { question: null };
    const allowed = await canAccessAgentQuestion(req, question);
    return { question: allowed ? question : null };
  });

  app.post('/agent/answer', async (req, reply) => {
    if (!agentService?.answerQuestion) {
      reply.code(503);
      return { success: false, message: '当前 Agent 运行时不支持 ask-user 提问' };
    }
    const body = (req.body || {}) as { question_id?: string; option_id?: string; custom_answer?: string };
    if (!body.question_id || !body.option_id) {
      reply.code(400);
      return { success: false, message: '缺少 question_id 或 option_id' };
    }
    const question = agentService.getPendingQuestion?.() || null;
    if (!question || question.question_id !== body.question_id) {
      reply.code(409);
      return { success: false, message: '该提问已失效或已被作答' };
    }
    const allowed = await canAccessAgentQuestion(req, question);
    if (!allowed) {
      reply.code(403);
      return { success: false, message: '无权回答该项目的 Agent 提问' };
    }
    try {
      const result = await agentService.answerQuestion({
        question_id: body.question_id,
        option_id: body.option_id,
        custom_answer: body.custom_answer,
      });
      if (!result.answered) {
        reply.code(409);
        return { success: false, message: '该提问已失效或已被作答' };
      }
      return { success: true };
    } catch (err) {
      reply.code(500);
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}
