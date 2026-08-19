import { http } from './http';

export interface AiDiagnosticAttempt {
  id: string; attemptNo: number; phase: string; stage: string; status: string;
  requestChars: number; responseChars: number; responseShape?: unknown; issues?: Array<{ code: string; stage: string; message: string; path?: string }>;
  hasFailureContent: boolean; createdAt: string;
}
export interface AiDiagnosticRun {
  traceId: string; projectId?: number; taskId?: string; taskType?: string; operation: string;
  provider: string; model: string; requestMode: string; status: string; stage: string;
  errorCode?: string; errorMessage?: string; degraded: boolean; metadata?: unknown;
  startedAt: string; finishedAt?: string; attempts?: AiDiagnosticAttempt[];
}

export const aiDiagnosticsApi = {
  list(params: Record<string, string | number | undefined> = {}) {
    return http.get<{ items: AiDiagnosticRun[]; page: number; pageSize: number }>('/ai-diagnostics', { params }).then((r) => r.data);
  },
  detail(traceId: string) { return http.get<AiDiagnosticRun>(`/ai-diagnostics/${encodeURIComponent(traceId)}`).then((r) => r.data); },
  content(traceId: string, attemptId: string) {
    return http.get<{ content: string }>(`/ai-diagnostics/${encodeURIComponent(traceId)}/attempts/${encodeURIComponent(attemptId)}/content`).then((r) => r.data);
  },
};
