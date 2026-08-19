// 技术方案状态命名空间路由（受保护，按 projectId 隔离）。
// RPC 风格 POST：每条写路由返回完整 TechnicalPlanState（select-bid-section/clear 多一层 envelope）。
// 移植自 client/electron/ipc/technicalPlanIpc.cjs 的 1:1 透传契约。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { getProjectId } from '../auth/middleware';
import { createTechnicalPlanStore } from '../technical-plan/store';
import { collectParsedImports } from '../document/multipart';

export async function technicalPlanRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const store = createTechnicalPlanStore(prisma);

  const bodyOf = (req: FastifyRequest) => (req as FastifyRequest & { body: unknown }).body as Record<string, unknown> | undefined;

  app.get('/technical-plan/state', async (req) => store.loadTechnicalPlan(getProjectId(req)));

  app.post('/technical-plan/step', async (req) => store.updateStep(getProjectId(req), bodyOf(req)?.step));

  app.post('/technical-plan/workflow-kind', async (req) => store.setWorkflowKind(getProjectId(req), bodyOf(req)?.workflowKind));

  app.post('/technical-plan/switch-workflow-kind', async (req) => store.switchWorkflowKind(getProjectId(req), bodyOf(req)?.workflowKind));

  app.post('/technical-plan/bid-analysis-config', async (req) =>
    store.saveBidAnalysisConfig(
      getProjectId(req),
      bodyOf(req) as { mode?: unknown; selectedTaskIds?: unknown; bidSectionMode?: unknown },
    ),
  );

  app.post('/technical-plan/outline-config', async (req) =>
    store.saveOutlineConfig(
      getProjectId(req),
      bodyOf(req) as { referenceKnowledgeDocumentIds?: unknown; outlineExpansionMode?: unknown; mirrorProcurementEnabled?: unknown; outlineWordControlOptions?: unknown },
    ),
  );

  app.post('/technical-plan/outline', async (req) =>
    store.saveOutline(
      getProjectId(req),
      bodyOf(req) as { outlineData?: unknown; reason?: string; idMap?: Record<string, string>; affectedNodeIds?: string[] },
    ),
  );

  app.post('/technical-plan/global-facts', async (req) => store.saveGlobalFacts(getProjectId(req), bodyOf(req)?.globalFacts));

  app.post('/technical-plan/content-generation-options', async (req) =>
    store.saveContentGenerationOptions(getProjectId(req), bodyOf(req)?.options),
  );

  app.post('/technical-plan/chapter-content', async (req) =>
    store.saveChapterContent(getProjectId(req), bodyOf(req) as { nodeId?: string; content?: unknown }),
  );

  app.post('/technical-plan/select-bid-section', async (req) =>
    store.selectBidSection(getProjectId(req), bodyOf(req)?.selectedSection as { id?: string; title?: string }),
  );

  app.post('/technical-plan/clear', async (req) => store.clear(getProjectId(req)));

  // 文件导入（multipart）：bridge 侧 pickFiles → FormData 上传，route 解析后交 store 落盘+写库。
  app.post('/technical-plan/import-tender-document', async (req, reply) => {
    const { docs, errors, officeMissing } = await collectParsedImports(req);
    if (!docs.length) {
      return reply.code(officeMissing ? 415 : 422).send({
        error: errors.join('; ') || '未导入文件',
        code: officeMissing ? 'office_backend_missing' : 'parse_failed',
        officeBackendMissing: officeMissing,
      });
    }
    return store.importTenderDocument(getProjectId(req), docs);
  });

  app.post('/technical-plan/import-original-plan-document', async (req, reply) => {
    const { docs, errors, officeMissing } = await collectParsedImports(req);
    if (!docs.length) {
      return reply.code(officeMissing ? 415 : 422).send({
        error: errors.join('; ') || '未导入文件',
        code: officeMissing ? 'office_backend_missing' : 'parse_failed',
        officeBackendMissing: officeMissing,
      });
    }
    return store.importOriginalPlanDocument(getProjectId(req), docs);
  });

  // FS 读（P4-2：从工作区磁盘读回招标/原方案 markdown，可能为空串）
  app.get('/technical-plan/tender-markdown', async (req) => store.readTenderMarkdown(getProjectId(req)));
  app.get('/technical-plan/tender-source-markdown/:sourceId', async (req) =>
    store.readTenderSourceMarkdown(getProjectId(req), (req.params as { sourceId: string }).sourceId),
  );
  app.get('/technical-plan/original-plan-markdown', async (req) => store.readOriginalPlanMarkdown(getProjectId(req)));
  app.get('/technical-plan/bid-sections', async (req) => store.checkBidSections(getProjectId(req)));
}
