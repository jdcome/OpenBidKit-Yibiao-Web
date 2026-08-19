// 废标项检查命名空间路由（受保护，按 projectId 隔离）。
// RPC 风格：每条写路由返回完整 RejectionCheckWorkspaceState（clear 多一层 envelope）。
// 移植自 client/electron/ipc/rejectionCheckIpc.cjs 的 7 通道 1:1 透传契约。
// tasks:start-rejection-items-extraction / tasks:start-rejection-check 属 P6 任务引擎，不在本路由。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { getProjectId } from '../auth/middleware';
import { createRejectionCheckStore } from '../rejection-check/store';
import { collectParsedImports } from '../document/multipart';

export async function rejectionCheckRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const store = createRejectionCheckStore(prisma);

  const bodyOf = (req: FastifyRequest) => (req as FastifyRequest & { body: unknown }).body as Record<string, unknown> | undefined;

  // GET /rejection-check/state → RejectionCheckWorkspaceState
  app.get('/rejection-check/state', async (req) => store.loadRejectionCheck(getProjectId(req)));

  // POST /rejection-check/remove-document {role, documentId?} → state
  app.post('/rejection-check/remove-document', async (req) => {
    const body = bodyOf(req) ?? {};
    return store.removeDocument(getProjectId(req), String(body.role || 'tender'), body.documentId ? String(body.documentId) : undefined);
  });

  // POST /rejection-check/ui-state {step?,activeDocumentTab?,activeResultTab?,activeCheckResultTab?,customCheckItems?,checkOptions?} → state
  app.post('/rejection-check/ui-state', async (req) => store.saveUiState(getProjectId(req), bodyOf(req) ?? {}));

  // POST /rejection-check/update {partial} → state（任务引擎流式更新抽取/检查进度用，P3 已移植写路径）
  app.post('/rejection-check/update', async (req) => store.updateRejectionCheck(getProjectId(req), bodyOf(req) ?? {}));

  // POST /rejection-check/clear → {success,message,state}
  app.post('/rejection-check/clear', async (req) => store.clearRejectionCheck(getProjectId(req)));

  // 文件导入（multipart）：bridge 侧 pickFiles(role) → FormData 上传，role 从 query 取（tender/bid）。
  // tender：多文件合并；bid：按 fileName+contentHash 去重追加。返回 {success,message,state}。
  app.post('/rejection-check/import-document', async (req, reply) => {
    const role = String((req.query as { role?: string } | undefined)?.role || 'tender');
    const { docs, errors, officeMissing } = await collectParsedImports(req);
    if (!docs.length) {
      return reply.code(officeMissing ? 415 : 422).send({
        error: errors.join('; ') || '未导入文件',
        code: officeMissing ? 'office_backend_missing' : 'parse_failed',
        officeBackendMissing: officeMissing,
      });
    }
    return store.importDocument(getProjectId(req), role, docs, errors.length);
  });

  // POST /rejection-check/import-tender-from-technical-plan → {success,message,state}
  // 跨域读 technical_plan 的招标文件正文 + 各源 + 放弃的投标段落，落进 rejection_check。
  app.post('/rejection-check/import-tender-from-technical-plan', async (req) =>
    store.importTenderFromTechnicalPlan(getProjectId(req)),
  );
}
