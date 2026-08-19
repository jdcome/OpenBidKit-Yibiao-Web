// 废标项检查命名空间的 Web 实现：window.yibiao.rejectionCheck.* 的底层。
// 按 userId 隔离（服务端按 JWT 过滤）。DTO 混合大小写：顶层 workspace + 嵌套域对象全 camelCase
// （tenderDocument/bidDocuments/invalidBidAndRejectionItems/rejectionCheckResult.../findings），
// 唯一例外是 background-task 子对象全 snake_case（task_id/type/status/progress/logs/
// started_at/updated_at/error/stats）。详见 features/rejection-check/types.ts:48-64。
// importDocument/importTenderFromTechnicalPlan（Electron 文件对话框 + 解析）+ tasks:
// startRejectionItemsExtraction/startRejectionCheck（LLM 检查流水线）不在本命名空间——
// 前两者 P4 文件上传，后两者 P6 任务引擎，bridge 侧不定义（可选链 no-op）。
import { http } from './http';

// workspace state 形状复杂且渲染器已从 features/rejection-check/types.ts 持权威类型，此处用宽松返回。
export type RejectionCheckWorkspaceState = Record<string, unknown>;

export interface RejectionCheckClearResult {
  success: boolean;
  message: string;
  state: RejectionCheckWorkspaceState;
}

export interface RejectionCheckImportResult {
  success: boolean;
  message: string;
  state: RejectionCheckWorkspaceState;
}

export interface RejectionCheckRemoveDocumentPayload {
  role: string;
  documentId?: string;
}

export type RejectionCheckUiStatePayload = Record<string, unknown>;

export const rejectionCheckApi = {
  loadState(): Promise<RejectionCheckWorkspaceState> {
    return http.get<RejectionCheckWorkspaceState>('/rejection-check/state').then((r) => r.data);
  },
  removeDocument(payload: RejectionCheckRemoveDocumentPayload): Promise<RejectionCheckWorkspaceState> {
    return http.post<RejectionCheckWorkspaceState>('/rejection-check/remove-document', payload).then((r) => r.data);
  },
  saveUiState(payload: RejectionCheckUiStatePayload): Promise<RejectionCheckWorkspaceState> {
    return http.post<RejectionCheckWorkspaceState>('/rejection-check/ui-state', payload).then((r) => r.data);
  },
  updateState(partial: Record<string, unknown>): Promise<RejectionCheckWorkspaceState> {
    return http.post<RejectionCheckWorkspaceState>('/rejection-check/update', partial).then((r) => r.data);
  },
  clear(): Promise<RejectionCheckClearResult> {
    return http.post<RejectionCheckClearResult>('/rejection-check/clear').then((r) => r.data);
  },
  importDocument(role: string, files: File[]): Promise<RejectionCheckImportResult> {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name));
    return http
      .post<RejectionCheckImportResult>(`/rejection-check/import-document?role=${encodeURIComponent(role)}`, fd)
      .then((r) => r.data);
  },
  importTenderFromTechnicalPlan(): Promise<RejectionCheckImportResult> {
    return http.post<RejectionCheckImportResult>('/rejection-check/import-tender-from-technical-plan').then((r) => r.data);
  },
};
