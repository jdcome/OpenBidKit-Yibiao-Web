// 技术方案命名空间的 Web 实现：window.yibiao.technicalPlan.* 的底层。
// 按用户隔离——服务端用 JWT 里的 userId 过滤。DTO 形状与服务端 store 装配结果一致
// （顶层标量 camelCase，嵌套 task/plan/runtime/section/facts/outline 多为 snake_case）。
// 导入走 multipart（FormData），axios 自动设置 multipart/form-data 边界。
import { http } from './http';

export interface TechnicalPlanState {
  [key: string]: unknown;
}

export interface ImportResult {
  success: boolean;
  message?: string;
  state: TechnicalPlanState;
  markdown: string;
}

export const technicalPlanApi = {
  loadState(): Promise<TechnicalPlanState> {
    return http.get<TechnicalPlanState>('/technical-plan/state').then((r) => r.data);
  },
  updateStep(step: string): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/step', { step }).then((r) => r.data);
  },
  setWorkflowKind(workflowKind: string): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/workflow-kind', { workflowKind }).then((r) => r.data);
  },
  switchWorkflowKind(workflowKind: string): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/switch-workflow-kind', { workflowKind }).then((r) => r.data);
  },
  saveBidAnalysisConfig(payload: { mode: string; selectedTaskIds: string[]; bidSectionMode?: string }): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/bid-analysis-config', payload).then((r) => r.data);
  },
  saveOutlineConfig(payload: { referenceKnowledgeDocumentIds: string[]; outlineExpansionMode?: string; mirrorProcurementEnabled?: boolean; outlineWordControlOptions?: unknown }): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/outline-config', payload).then((r) => r.data);
  },
  saveOutline(payload: unknown): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/outline', payload).then((r) => r.data);
  },
  saveGlobalFacts(globalFacts: unknown): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/global-facts', { globalFacts }).then((r) => r.data);
  },
  saveContentGenerationOptions(options: unknown): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/content-generation-options', { options }).then((r) => r.data);
  },
  saveChapterContent(payload: { nodeId: string; content: string }): Promise<TechnicalPlanState> {
    return http.post<TechnicalPlanState>('/technical-plan/chapter-content', payload).then((r) => r.data);
  },
  selectBidSection(selectedSection: unknown): Promise<{ success: boolean; message?: string; state: TechnicalPlanState; markdown: string }> {
    return http
      .post<{ success: boolean; message?: string; state: TechnicalPlanState; markdown: string }>('/technical-plan/select-bid-section', { selectedSection })
      .then((r) => r.data);
  },
  clear(): Promise<{ success: boolean; message?: string; state: TechnicalPlanState }> {
    return http.post<{ success: boolean; message?: string; state: TechnicalPlanState }>('/technical-plan/clear').then((r) => r.data);
  },
  readTenderMarkdown(): Promise<string> {
    return http.get<string>('/technical-plan/tender-markdown').then((r) => r.data ?? '');
  },
  readTenderSourceMarkdown(sourceId: string): Promise<string> {
    return http.get<string>(`/technical-plan/tender-source-markdown/${encodeURIComponent(sourceId)}`).then((r) => r.data ?? '');
  },
  readOriginalPlanMarkdown(): Promise<string> {
    return http.get<string>('/technical-plan/original-plan-markdown').then((r) => r.data ?? '');
  },
  checkBidSections(): Promise<{ hasMultiple: boolean; totalDeclared: number | null }> {
    return http.get<{ hasMultiple: boolean; totalDeclared: number | null }>('/technical-plan/bid-sections').then((r) => r.data);
  },
  importTenderDocument(files: File[]): Promise<ImportResult> {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name));
    return http.post<ImportResult>('/technical-plan/import-tender-document', fd).then((r) => r.data);
  },
  importOriginalPlanDocument(files: File[]): Promise<ImportResult> {
    const fd = new FormData();
    if (files[0]) fd.append('file', files[0], files[0].name);
    return http.post<ImportResult>('/technical-plan/import-original-plan-document', fd).then((r) => r.data);
  },
};
