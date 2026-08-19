import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

function publicAttempt(attempt: any) {
  if (!attempt) return attempt;
  const { responseFile: _responseFile, ...value } = attempt;
  return { ...value, hasFailureContent: Boolean(attempt.responseFile) };
}

export async function aiDiagnosticRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const service = (app as any).aiDiagnostics;

  app.get('/ai-diagnostics', async (req) => {
    const query = (req.query || {}) as Record<string, string>;
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const where: any = {};
    if (query.taskType) where.taskType = query.taskType;
    if (query.status) where.status = query.status;
    if (query.model) where.model = { contains: query.model, mode: 'insensitive' };
    if (query.from || query.to) where.startedAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
    if (query.projectCode) {
      const projects = await (app as any).prisma.project.findMany({ where: { code: { contains: query.projectCode, mode: 'insensitive' } }, select: { id: true } });
      where.projectId = { in: projects.map((project: any) => project.id) };
    }
    const rows = await service.listRuns({ where, orderBy: { startedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize });
    return { items: rows || [], page, pageSize };
  });

  app.get('/ai-diagnostics/:traceId', async (req, reply) => {
    const { traceId } = req.params as { traceId: string };
    const run = await service.getRun(traceId);
    if (!run) return reply.code(404).send({ error: '诊断记录不存在或已过期' });
    return { ...run, attempts: (run.attempts || []).map(publicAttempt) };
  });

  app.get('/ai-diagnostics/:traceId/attempts/:attemptId/content', async (req, reply) => {
    const { traceId, attemptId } = req.params as { traceId: string; attemptId: string };
    const run = await service.getRun(traceId);
    const attempt = run?.attempts?.find((item: any) => item.id === attemptId);
    if (!attempt?.responseFile) return reply.code(404).send({ error: '失败响应不存在或已过期' });
    try {
      return { content: await service.readFailure(attempt.responseFile) };
    } catch {
      return reply.code(404).send({ error: '失败响应不存在或已过期' });
    }
  });
}
