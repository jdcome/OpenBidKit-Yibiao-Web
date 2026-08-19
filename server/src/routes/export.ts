// 导出 Word 路由（受保护、项目作用域——requireProject preHandler 挂 req.projectId）。
// POST /api/export/word → 服务端渲染 docx 并以 attachment 流回浏览器。
// 进度经 EventBus 的 export-progress 通道推 SSE（按 projectId 路由，requestId 过滤）。
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { getProjectId } from '../auth/middleware';
import { exportWordToBuffer } from '../export/service';
import type { ExportWordPayload } from '../export/format';
import { eventBus } from '../events/bus';
import { normalizeSubjectReplacements } from '../tasks/utils/subjectReplacement';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// RFC 5987 编码中文文件名：filename="fallback"; filename*=UTF-8''%E6%A0%87...
function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'export.docx';
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export async function exportRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: import('@prisma/client').PrismaClient }).prisma;
  app.post('/export/word', { bodyLimit: 50 * 1024 * 1024 }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req as FastifyRequest & { body: unknown }).body as ExportWordPayload | undefined;
    const projectId = String(getProjectId(req));
    const requestId = body?.requestId;

    // 编号(projectCode)仅服务端从 DB 取（客户端不传）；名称优先用客户端值，兜底 DB。
    let projectCode: string | undefined;
    let projectName: string | undefined = body?.project_name;
    let subjectReplacementCommentTerms: string[] = [];
    try {
      const project = await prisma.project.findUnique({
        where: { id: Number(projectId) },
        select: { projectCode: true, name: true, subjectReplacements: true },
      });
      if (project?.projectCode) projectCode = project.projectCode;
      if (!projectName && project?.name) projectName = project.name;
      subjectReplacementCommentTerms = [...new Set(
        normalizeSubjectReplacements(project?.subjectReplacements)
          .map((item) => String(item.fullname || '').trim())
          .filter(Boolean),
      )];
    } catch (err) {
      req.log.warn({ err, projectId }, '读取项目编号/名称失败（不影响导出）');
    }

    const payload: ExportWordPayload = {
      requestId,
      project_code: projectCode,
      project_name: projectName,
      outline: Array.isArray(body?.outline) ? body.outline : [],
      export_format: body?.export_format ?? null,
      base_dir: body?.base_dir || body?.baseDir,
      subject_replacement_comment_terms: subjectReplacementCommentTerms,
    };

    // onProgress → SSE export-progress 通道（按 requestId 过滤，UI 只关心自己发起的那次）。
    const onProgress = (event: { phase?: string; progress?: number; message?: string; warnings?: string[] }) => {
      eventBus.emit(projectId, 'export-progress', {
        requestId,
        phase: event.phase || 'running',
        progress: typeof event.progress === 'number' ? event.progress : 0,
        message: event.message || '',
        warnings: event.warnings || [],
      });
    };

    let result;
    try {
      result = await exportWordToBuffer(payload, { onProgress });
    } catch (error) {
      const message = (error as Error).message || '导出失败';
      req.log.error({ err: error, projectId }, 'export/word failed');
      eventBus.emit(projectId, 'export-progress', { requestId, phase: 'error', progress: 100, message, warnings: [] });
      return reply.code(400).send({ error: message });
    }

    // 记录最近一次成功导出时间（best-effort，失败不阻断下载）。仪表盘进度据此判定：正文完成 + 导出过 → 100%。
    try {
      await prisma.project.update({ where: { id: Number(projectId) }, data: { lastExportedAt: new Date() } });
    } catch (err) {
      req.log.warn({ err, projectId }, '记录导出时间失败（不影响下载）');
    }

    return reply
      .header('Content-Type', DOCX_MIME)
      .header('Content-Disposition', buildContentDisposition(result.filename))
      .header('Content-Length', String(result.buffer.length))
      .send(result.buffer);
  });
}
