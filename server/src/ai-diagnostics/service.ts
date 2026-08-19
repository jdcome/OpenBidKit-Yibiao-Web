import type { AiDiagnosticContext, AiDiagnosticIssue } from './types';

const RETENTION_MS = 7 * 86400000;
const CLEANUP_INTERVAL_MS = 3600000;

export function createAiDiagnosticsService({ prisma, storage, logger }: { prisma: any; storage: any; logger: { error: (value: unknown) => void } }) {
  let lastCleanupAt = 0;
  const safe = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (error) { logger.error(error); return undefined; }
  };
  return {
    startRun(context: AiDiagnosticContext, meta: any) {
      return safe(() => prisma.aiDiagnosticRun.create({ data: { ...context, ...meta, expiresAt: new Date(Date.now() + RETENTION_MS) } }));
    },
    async startAttempt(traceId: string, meta: any): Promise<string | undefined> {
      const { messageCount, messageRoles, requestHash, ...fields } = meta || {};
      const row: any = await safe(() => prisma.aiDiagnosticAttempt.create({ data: {
        traceId, stage: 'request', status: 'running', ...fields,
        requestMeta: { messageCount, messageRoles, requestHash },
      } }));
      return row?.id;
    },
    recordAttemptStage(id: string, stage: string, patch: any = {}) { return safe(() => prisma.aiDiagnosticAttempt.update({ where: { id }, data: { stage, ...patch } })); },
    completeAttempt(id: string, meta: any = {}) { return safe(() => prisma.aiDiagnosticAttempt.update({ where: { id }, data: { ...meta, responseFile: null, stage: 'complete', status: 'success' } })); },
    async failAttempt(traceId: string, id: string, issue: AiDiagnosticIssue, response?: unknown) {
      const responseFile = response === undefined ? null : await safe(() => storage.writeFailure(traceId, id, response));
      return safe(() => prisma.aiDiagnosticAttempt.update({ where: { id }, data: { stage: issue.stage, status: 'error', issues: [issue], responseFile: responseFile || null } }));
    },
    finishRun(traceId: string, data: any) { return safe(() => prisma.aiDiagnosticRun.update({ where: { traceId }, data: { ...data, finishedAt: new Date() } })); },
    markFallback(traceId: string, stage: string, warnings: string[]) { return safe(() => prisma.aiDiagnosticRun.update({ where: { traceId }, data: { status: 'degraded', stage: 'fallback', degraded: true, metadata: { fallbackStage: stage, warnings } } })); },
    listRuns(args: any) { return safe(() => prisma.aiDiagnosticRun.findMany(args)); },
    getRun(traceId: string) { return safe(() => prisma.aiDiagnosticRun.findUnique({ where: { traceId }, include: { attempts: true } })); },
    async cleanupExpired(now = new Date(), force = false) {
      if (!force && now.getTime() - lastCleanupAt < CLEANUP_INTERVAL_MS) return 0;
      lastCleanupAt = now.getTime();
      const files = await safe(() => storage.deleteExpired(now));
      const rows: any = await safe(() => prisma.aiDiagnosticRun.deleteMany({ where: { expiresAt: { lt: now } } }));
      return Number(files || 0) + Number(rows?.count || 0);
    },
    readFailure(relativePath: string) { return storage.readFailure(relativePath); },
  };
}
