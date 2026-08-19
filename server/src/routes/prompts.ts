// 提示词管理路由：拆为「只读目录」+「管理操作」两个插件。
// 拆分原因：招标解析页(BidAnalysisPage)对所有登录用户可见，需要拉任务目录展示元数据；
// 而 promptText 正文与写操作仍仅管理员可访问。index.ts 分别挂 verifyToken / requireAdmin。
// 管线不变：runner 经 loadBidAnalysisCatalog/loadRejectionInvalidBidPrompt 读 DB，DB 失败兜底硬编码。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  listCatalog,
  getOne,
  createPrompt,
  updatePrompt,
  removePrompt,
  resetPrompt,
  resetAllPrompts,
  type PromptRunnerKey,
  type PromptOutput,
} from '../prompts/store';

const VALID_RUNNER_KEYS = new Set<string>(['bid-analysis', 'rejection-check']);

function badRequest(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(400).send({ error });
}

function prismaOf(app: FastifyInstance): PrismaClient {
  return (app as unknown as { prisma: PrismaClient }).prisma;
}

// GET /prompts?runnerKey=bid-analysis → { items }（不含 promptText，列表/解析页展示用）。
// 任何登录用户可读——招标解析页需据此渲染任务列表。
export async function promptReadRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = prismaOf(app);
  app.get('/prompts', async (req: FastifyRequest, reply: FastifyReply) => {
    const runnerKey = (req.query as { runnerKey?: string } | undefined)?.runnerKey;
    if (runnerKey !== undefined && !VALID_RUNNER_KEYS.has(runnerKey)) {
      return badRequest(reply, 'runnerKey 非法');
    }
    const items = await listCatalog(prisma, runnerKey as PromptRunnerKey | undefined);
    return { items };
  });
}

// 管理操作（admin-only，由 index.ts 装配时挂 createRequireAdmin preHandler）：
// GET /prompts/:id（含 promptText，编辑用）+ 全部写操作。
export async function promptAdminRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = prismaOf(app);

  // GET /prompts/:id → 含 promptText（编辑用）
  app.get('/prompts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as { id: string }).id;
    const item = await getOne(prisma, id);
    if (!item) return reply.code(404).send({ error: '提示词不存在' });
    return { item };
  });

  // POST /prompts → 新建自定义项（builtin 强制 false）
  app.post('/prompts', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
      runnerKey?: string;
      itemKey?: string;
      label?: string;
      description?: string;
      output?: string;
      required?: boolean;
      promptText?: string;
    };
    try {
      const item = await createPrompt(prisma, {
        runnerKey: String(body.runnerKey || ''),
        itemKey: String(body.itemKey || ''),
        label: String(body.label || ''),
        description: body.description,
        output: body.output === 'json' ? 'json' : (body.output as PromptOutput),
        required: body.required,
        promptText: String(body.promptText || ''),
      });
      return reply.code(201).send({ item });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建失败');
    }
  });

  // PUT /prompts/:id → 更新（system 项仅 promptText/label 可改，enabled 锁定）
  app.put('/prompts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      label?: string;
      description?: string;
      groupName?: string;
      output?: string;
      required?: boolean;
      promptText?: string;
      enabled?: boolean;
    };
    try {
      const item = await updatePrompt(prisma, id, {
        label: body.label,
        description: body.description,
        groupName: body.groupName,
        output: body.output === 'json' ? 'json' : body.output === 'markdown' ? 'markdown' : undefined,
        required: body.required,
        promptText: body.promptText,
        enabled: body.enabled,
      });
      return { item };
    } catch (error) {
      const message = error instanceof Error ? error.message : '更新失败';
      return message.includes('不存在') ? reply.code(404).send({ error: message }) : badRequest(reply, message);
    }
  });

  // DELETE /prompts/:id → 仅可删自定义项；内置项返回 400
  app.delete('/prompts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as { id: string }).id;
    try {
      await removePrompt(prisma, id);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败';
      return message.includes('不存在') ? reply.code(404).send({ error: message }) : badRequest(reply, message);
    }
  });

  // POST /prompts/:id/reset → 恢复单项默认 promptText（仅内置项）
  app.post('/prompts/:id/reset', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as { id: string }).id;
    try {
      const item = await resetPrompt(prisma, id);
      return { item };
    } catch (error) {
      const message = error instanceof Error ? error.message : '重置失败';
      return message.includes('不存在') ? reply.code(404).send({ error: message }) : badRequest(reply, message);
    }
  });

  // POST /prompts/reset-all?runnerKey= → 恢复全部内置项默认 promptText
  app.post('/prompts/reset-all', async (req: FastifyRequest, reply: FastifyReply) => {
    const runnerKey = (req.query as { runnerKey?: string } | undefined)?.runnerKey;
    if (runnerKey !== undefined && !VALID_RUNNER_KEYS.has(runnerKey)) {
      return badRequest(reply, 'runnerKey 非法');
    }
    const count = await resetAllPrompts(prisma, runnerKey as PromptRunnerKey | undefined);
    return { success: true, count };
  });
}
