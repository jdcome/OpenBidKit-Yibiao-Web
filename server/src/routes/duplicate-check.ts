// 标书查重命名空间路由（受保护，按 projectId 隔离）。
// RPC 风格：每条写路由返回完整 DuplicateCheckWorkspaceState（clear 多一层 envelope）。
// 移植自 client/electron/ipc/duplicateCheckIpc.cjs 的 5 通道 1:1 透传契约。
// runAnalysisTask（tasks:start-duplicate-analysis）属 P6 任务引擎，不在本路由。
// select-files（桌面 file:select-duplicate-check-files）只挑文件+落盘原始字节，不解析
// （查重解析/哈希在分析流水线里做，属 P6）——这里持久化到 duplicate-check/sources/<id><ext>。
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { getProjectId } from '../auth/middleware';
import { createDuplicateCheckStore } from '../duplicate-check/store';
import { createWorkspacePaths } from '../document/paths';
import { collectRawUploads } from '../document/multipart';

// 与桌面 fileService.cjs duplicateCheckSupportedExtensions 对齐（无 .txt）。
const DUPLICATE_CHECK_EXTENSIONS = new Set([
  '.doc', '.docx', '.wps', '.pdf', '.md', '.markdown', '.xls', '.xlsx',
]);

interface LocalFileSelection {
  id: string;
  file_name: string;
  file_path: string;
  extension: string;
  size: number;
  modified_at: string;
}

interface FileSelectionResult {
  success: boolean;
  message: string;
  files: LocalFileSelection[];
}

export async function duplicateCheckRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const store = createDuplicateCheckStore(prisma);

  const bodyOf = (req: FastifyRequest) => (req as FastifyRequest & { body: unknown }).body as Record<string, unknown> | undefined;

  // GET /duplicate-check/state → DuplicateCheckWorkspaceState
  app.get('/duplicate-check/state', async (req) => store.loadDuplicateCheck(getProjectId(req)));

  // POST /duplicate-check/files {tenderFile?,tenderFiles?,bidFiles?,step?,activeAnalysisTab?} → state
  app.post('/duplicate-check/files', async (req) => store.saveFiles(getProjectId(req), bodyOf(req) ?? {}));

  // POST /duplicate-check/ui-state {step?,activeAnalysisTab?} → state
  app.post('/duplicate-check/ui-state', async (req) => store.saveUiState(getProjectId(req), bodyOf(req) ?? {}));

  // POST /duplicate-check/update {partial} → state（任务引擎流式更新分析进度用，P3 已移植写路径）
  app.post('/duplicate-check/update', async (req) => store.updateDuplicateCheck(getProjectId(req), bodyOf(req) ?? {}));

  // POST /duplicate-check/clear → {success,message,state}
  app.post('/duplicate-check/clear', async (req) => store.clearDuplicateCheck(getProjectId(req)));

  // POST /duplicate-check/select-files (multipart) → {success,message,files}
  // 选文件 → 服务端按内容 sha1 命名落盘到 duplicate-check/sources/，返回桌面 LocalFileSelection 形状。
  // content_hash 留给 P6 分析流水线在算（与桌面 saveFiles 写 null 一致）。
  app.post('/duplicate-check/select-files', async (req, reply) => {
    const projectId = getProjectId(req);
    const paths = createWorkspacePaths(projectId);
    const { files: uploaded, errors } = await collectRawUploads(req);
    const accepted = uploaded.filter((f) => DUPLICATE_CHECK_EXTENSIONS.has(f.ext));
    if (!accepted.length) {
      return reply.code(422).send({
        success: false,
        message: errors[0] || '未选择支持的文件类型',
        files: [],
      } satisfies FileSelectionResult);
    }
    await fs.mkdir(paths.duplicateCheckSourcesDir, { recursive: true });
    const files: LocalFileSelection[] = [];
    for (const f of accepted) {
      const id = crypto.createHash('sha1').update(f.buffer).digest('hex');
      const relPath = path.relative(paths.workspaceDir, path.join(paths.duplicateCheckSourcesDir, `${id}${f.ext}`));
      await fs.writeFile(paths.resolve(relPath), f.buffer);
      files.push({
        id,
        file_name: f.fileName,
        file_path: relPath,
        extension: f.ext,
        size: f.buffer.length,
        modified_at: new Date().toISOString(),
      });
    }
    return {
      success: true,
      message: `已选择 ${files.length} 个文件`,
      files,
    } satisfies FileSelectionResult;
  });
}
