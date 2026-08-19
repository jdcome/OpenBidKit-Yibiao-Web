import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import { getProjectId } from '../auth/middleware';
import type { TaskService } from '../tasks/service';
import type { ProjectTenderSourceService, ResponseDeviationAvailability } from '../response-deviation/types';
import { RESPONSE_DEVIATION_EXTRACTOR_VERSION, type ResponseDeviationStore } from '../response-deviation/store';
import { parseTenderBlocks } from '../response-deviation/structure';
import { detectResponseDeviationAvailability } from '../response-deviation/detector';
import { buildResponseDeviationDocx, validateResponseDeviationExport } from '../response-deviation/export';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'response-deviation.docx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function computeResponseDeviationAvailability(
  projectId: number,
  sourceService: Pick<ProjectTenderSourceService, 'getSnapshot'>,
): Promise<ResponseDeviationAvailability> {
  const source = await sourceService.getSnapshot(projectId);
  if (!source) {
    return {
      available: false, reason: 'no-tender', kind: 'none', templateTitle: '', sourceChapterTitle: '',
      sourceBlockIds: [], sourceText: '', confidence: 'high', tenderHash: '', selectedSectionId: '',
    };
  }
  return detectResponseDeviationAvailability(parseTenderBlocks(source.markdown), source);
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const body = (req as FastifyRequest & { body?: unknown }).body;
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

export async function responseDeviationRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const deps = app as unknown as {
    responseDeviationStore: ResponseDeviationStore;
    tenderSourceService: ProjectTenderSourceService;
    taskService: TaskService;
  };
  const store = deps.responseDeviationStore;
  const sourceService = deps.tenderSourceService;

  app.get('/response-deviation/availability', async (req) => {
    const projectId = getProjectId(req);
    const availability = await computeResponseDeviationAvailability(projectId, sourceService);
    const workspace = await store.getWorkspace(projectId);
    const exists = Boolean((workspace as Record<string, unknown>).id);
    const stale = availability.tenderHash
      ? await store.markStaleIfSourceChanged(projectId, availability.tenderHash, availability.selectedSectionId)
      : false;
    return { ...availability, workspaceExists: exists, workspaceStatus: stale ? 'stale' : (workspace as Record<string, unknown>).status };
  });

  app.get('/response-deviation', async (req) => store.getWorkspace(getProjectId(req)));

  app.post('/response-deviation/generate', async (req) => {
    const projectId = getProjectId(req);
    const body = bodyOf(req);
    const source = await sourceService.getSnapshot(projectId);
    const workspace = await store.getWorkspace(projectId) as Record<string, unknown>;
    if (body.force !== true && source && workspace.id && workspace.tenderHash === source.tenderHash
      && String(workspace.selectedSectionId || '') === source.selectedSectionId
      && workspace.extractorVersion === RESPONSE_DEVIATION_EXTRACTOR_VERSION && workspace.status !== 'stale') {
      return { reused: true, workspace };
    }
    const task = await deps.taskService.startResponseDeviationGeneration(projectId, body);
    return { reused: false, task };
  });

  app.patch('/response-deviation/project-fields', async (req) => store.updateProjectFields(getProjectId(req), bodyOf(req)));

  app.patch('/response-deviation/rows/:rowId', async (req) => {
    const body = bodyOf(req);
    const allowed: Record<string, unknown> = {};
    for (const key of ['responseText', 'deviationStatus', 'deviationExplanation', 'notes']) {
      if (Object.prototype.hasOwnProperty.call(body, key)) allowed[key] = String(body[key] ?? '');
    }
    return store.patchRow(getProjectId(req), String((req.params as { rowId: string }).rowId), allowed);
  });

  app.post('/response-deviation/confirm', async (req) => store.confirmWorkspace(getProjectId(req)));

  app.get('/response-deviation/source/:rowId', async (req, reply) => {
    const row = await store.getRow(getProjectId(req), String((req.params as { rowId: string }).rowId));
    if (!row) return reply.code(404).send({ error: '偏离表行不存在或不属于当前项目' });
    return {
      id: row.id,
      clauseNo: row.clauseNo,
      title: row.requirementTitle,
      markdown: row.requirementMarkdown,
      plainText: row.requirementPlainText,
      evidence: row.sourceEvidenceJson,
      aggregation: row.aggregation,
      confidence: row.confidence,
    };
  });

  app.get('/response-deviation/export-validation', async (req) => {
    const workspace = await store.getWorkspace(getProjectId(req));
    return validateResponseDeviationExport(workspace as never);
  });

  app.post('/response-deviation/export', async (req, reply) => {
    const workspace = await store.getWorkspace(getProjectId(req));
    try {
      const result = await buildResponseDeviationDocx(workspace as never);
      return reply
        .header('Content-Type', DOCX_MIME)
        .header('Content-Disposition', contentDisposition(result.filename))
        .header('Content-Length', String(result.buffer.length))
        .send(result.buffer);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
