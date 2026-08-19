// 知识库命名空间路由（受保护、公司共享——不按 userId 过滤，但必须登录）。
// 纯 DB CRUD + 读路径 + P4 上传/重试管线（步骤 1-3）+ P6 LLM 抽取/匹配（步骤 4-9）。
// 抽取为 fire-and-forget 后台任务：upload/retry 在 prepareDocument 成功后触发，
// 进度经 EventBus 推 'kb-document' 通道给触发用户的 SSE 订阅者。
import path from 'node:path';
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createKnowledgeBaseStore } from '../knowledge-base/store';
import { collectRawUploads } from '../document/multipart';
import {
  ingestUpload,
  prepareDocument,
  retryDocument,
  isKnowledgeBaseSupported,
} from '../knowledge-base/pipeline';
import { runKnowledgeExtraction, emitProgress } from '../knowledge-base/extraction';
import { getAiService } from '../ai/service';
import { buildMerged } from '../config/store';
import type { JwtPayload } from '../auth/middleware';
import { getProjectIdHeader } from '../auth/middleware';

export async function knowledgeBaseRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const store = createKnowledgeBaseStore(prisma);
  const aiService = getAiService();

  const bodyOf = (req: FastifyRequest) => (req as FastifyRequest & { body: unknown }).body as Record<string, unknown> | undefined;
  const userOf = (req: FastifyRequest) => (req as FastifyRequest & { user: JwtPayload }).user;

  // fire-and-forget 抽取：失败已在 runKnowledgeExtraction 内部落 status=error + 推事件，
  // 此处 catch 仅防未预期 rejection 冒泡。config 复用触发用户的合并配置（含真实 key）。
  const kickoffExtraction = (documentId: string, projectId: string, config: Record<string, unknown>, batchSize?: number, force?: boolean): void => {
    void runKnowledgeExtraction({ store, aiService, config, projectId, documentId, batchSize, force }).catch(() => undefined);
  };

  // GET /knowledge-base → { folders, documents }（内部先 recoverInterruptedDocuments）
  app.get('/knowledge-base', async () => store.list());

  // POST /knowledge-base/folders { name } → FolderDto
  app.post('/knowledge-base/folders', async (req) => store.createFolder(bodyOf(req)?.name));

  // PATCH /knowledge-base/folders/:folderId { name } → FolderDto
  app.patch('/knowledge-base/folders/:folderId', async (req) => {
    const { folderId } = (req as FastifyRequest & { params: { folderId: string } }).params;
    return store.renameFolder(folderId, bodyOf(req)?.name);
  });

  // POST /knowledge-base/folders/reorder { draggedFolderId, targetFolderId, position } → { success, message, index }
  app.post('/knowledge-base/folders/reorder', async (req) => {
    const b = bodyOf(req) ?? {};
    return store.reorderFolder(
      String(b.draggedFolderId ?? b.dragged ?? ''),
      String(b.targetFolderId ?? b.target ?? ''),
      b.position,
    );
  });

  // DELETE /knowledge-base/folders/:folderId → { success, message }（级联清子表）
  app.delete('/knowledge-base/folders/:folderId', async (req) => {
    const { folderId } = (req as FastifyRequest & { params: { folderId: string } }).params;
    return store.deleteFolder(folderId);
  });

  // DELETE /knowledge-base/documents/:documentId → { success, message }（级联清子表）
  app.delete('/knowledge-base/documents/:documentId', async (req) => {
    const { documentId } = (req as FastifyRequest & { params: { documentId: string } }).params;
    return store.deleteDocument(documentId);
  });

  // POST /knowledge-base/documents/move { documentId, targetFolderId, targetDocumentId?, position? } → { success, message, index, document }
  app.post('/knowledge-base/documents/move', async (req) => {
    const b = bodyOf(req) ?? {};
    return store.moveDocument(
      String(b.documentId ?? ''),
      String(b.targetFolderId ?? ''),
      b.targetDocumentId === undefined || b.targetDocumentId === null ? null : String(b.targetDocumentId),
      b.position,
    );
  });

  // GET /knowledge-base/documents/:documentId/markdown → string（P3 stub ''）
  app.get('/knowledge-base/documents/:documentId/markdown', async (req) => {
    const { documentId } = (req as FastifyRequest & { params: { documentId: string } }).params;
    return store.readMarkdown(documentId);
  });

  // GET /knowledge-base/documents/:documentId/items → KnowledgeItem[]
  app.get('/knowledge-base/documents/:documentId/items', async (req) => {
    const { documentId } = (req as FastifyRequest & { params: { documentId: string } }).params;
    return store.readItems(documentId);
  });

  // GET /knowledge-base/documents/:documentId/analysis → KnowledgeAnalysisSnapshot
  app.get('/knowledge-base/documents/:documentId/analysis', async (req) => {
    const { documentId } = (req as FastifyRequest & { params: { documentId: string } }).params;
    return store.readAnalysis(documentId);
  });

  // POST /knowledge-base/outline-references { documentIds } → { items }（technical_plan 跨域消费）
  app.post('/knowledge-base/outline-references', async (req) => store.getOutlineReferences(bodyOf(req)?.documentIds));

  // GET /knowledge-base/migration-status → KnowledgeBaseMigrationStatus（Web 恒 needsMigration:false）
  app.get('/knowledge-base/migration-status', async () => store.getMigrationStatus());

  // POST /knowledge-base/folders/:folderId/documents/upload (multipart files)
  // → { success, message, documents }（移植自桌面 uploadDocuments）。
  // 每个 file：过滤扩展名 → ingestUpload（落 document 行 + 写 source 字节，同步）→ 立即响应；
  // prepareDocument（copy/convert/build_blocks 三步，停在 awaiting_extraction）改为 fire-and-forget
  // 后台推进，完成后接 fire-and-forget 抽取（步骤 4-9，进度走 SSE）。避免大文档解析超过客户端超时。
  app.post('/knowledge-base/folders/:folderId/documents/upload', async (req, reply) => {
    const { folderId } = (req as FastifyRequest & { params: { folderId: string } }).params;
    const folder = await prisma.knowledgeFolder.findUnique({ where: { folderId } });
    if (!folder) {
      return reply.code(404).send({ success: false, message: '请先选择知识库文件夹', documents: [] });
    }

    const user = userOf(req);
    const projectId = getProjectIdHeader(req) ?? '';
    const config = await buildMerged(prisma, user.id);

    const collected = await collectRawUploads(req);
    const created: Awaited<ReturnType<typeof prepareDocument>>['document'][] = [];
    const skipped: string[] = [];
    for (const upload of collected.files) {
      if (!isKnowledgeBaseSupported(upload.ext)) {
        skipped.push(`${upload.fileName}（不支持的格式 ${upload.ext || '无扩展名'}）`);
        continue;
      }
      try {
        const fileName = path.basename(upload.fileName) || `source${upload.ext}`;
        const { document } = await ingestUpload(store, folderId, fileName, upload.ext, upload.buffer);
        created.push(document);
        // 文档解析（copy/convert/build_blocks）对大 docx/pdf 可能耗时数十秒，同步等待会超过客户端
        // 30s 超时。与 LLM 抽取一致改为后台推进：先推一条 converting 进度让前端即时反馈，
        // prepareDocument 跑完三步后接 fire-and-forget 抽取；全程进度经 EventBus 'kb-document' 通道推送。
        void (async () => {
          await emitProgress(store, projectId, document.id, {
            status: 'converting',
            progress: 10,
            message: '正在解析文档',
            error: null,
          });
          const result = await prepareDocument(store, document.id);
          if (result.success) kickoffExtraction(document.id, projectId, config);
        })().catch(() => undefined);
      } catch (error) {
        // ingestUpload 失败（写盘/建库）；记录后继续处理下一个
        const message = error instanceof Error ? error.message : String(error);
        skipped.push(`${upload.fileName}: ${message}`);
      }
    }

    const errors = [...collected.errors, ...skipped];
    if (!created.length) {
      return reply.code(422).send({
        success: false,
        message: errors.length ? `未导入任何文档：${errors.join('；')}` : '未选择支持的文档类型',
        documents: [],
      });
    }
    return {
      success: true,
      message: `已导入 ${created.length} 个文档${errors.length ? `（${errors.length} 个跳过）` : ''}`,
      documents: created,
    };
  });

  // POST /knowledge-base/documents/:documentId/retry → { success, message, document }（移植自桌面 retryDocument）。
  // 仅 error 态可重试；重跑 prepareDocument（幂等，跳过已完成步骤），成功后 fire-and-forget 抽取。
  app.post('/knowledge-base/documents/:documentId/retry', async (req) => {
    const { documentId } = (req as FastifyRequest & { params: { documentId: string } }).params;
    const result = await retryDocument(store, documentId);
    if (result.success) {
      const user = userOf(req);
      const config = await buildMerged(prisma, user.id);
      kickoffExtraction(documentId, getProjectIdHeader(req) ?? '', config);
    }
    return result;
  });

  // POST /knowledge-base/documents/:documentId/match { batchSize? } → { success, message, document }。
  // 移植自桌面 startMatching：仅 ready_for_matching/success/error 态可触发；success 态 force 重跑匹配，
  // 其余从 checkpoint 续跑。fire-and-forget，进度走 SSE。
  app.post('/knowledge-base/documents/:documentId/match', async (req, reply) => {
    const { documentId } = (req as FastifyRequest & { params: { documentId: string } }).params;
    const document = await store.getDocument(documentId);
    if (!['ready_for_matching', 'success', 'error'].includes(document.status)) {
      return reply.code(409).send({ success: false, message: '请等待候选知识条目提取完成', document });
    }
    const user = userOf(req);
    const projectId = getProjectIdHeader(req) ?? '';
    const config = await buildMerged(prisma, user.id);
    const batchSize = Number(bodyOf(req)?.batchSize) || undefined;
    kickoffExtraction(documentId, projectId, config, batchSize, document.status === 'success');
    return { success: true, message: '已开始分批匹配段落', document };
  });
}
