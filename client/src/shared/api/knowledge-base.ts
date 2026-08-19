// 知识库命名空间的 Web 实现：window.yibiao.knowledgeBase.* 的底层。
// 公司共享（无 userId 过滤，服务端按 JWT 鉴权但不隔离）。DTO 全 snake_case，
// 与桌面 knowledge-base/types.ts 一致（不像 technical_plan 的混合大小写）。
// upload/retry/startMatching/migrateLegacy 暂不实现（P4 文件上传 + P6 任务引擎）；
// onEvent 推送待 P6 SSE。getOutlineReferences 供 technical_plan 跨域参考文档选择。
import { http } from './http';

export interface KnowledgeFolderDto {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocumentDto {
  id: string;
  folder_id: string;
  file_name: string;
  status: string;
  progress: number;
  message: string;
  item_count: number;
  block_count: number;
  filtered_block_count: number;
  candidate_item_count: number;
  discarded_block_count: number;
  system_discarded_after_retry_count: number;
  last_batch_size?: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface KnowledgeBaseIndex {
  folders: KnowledgeFolderDto[];
  documents: KnowledgeDocumentDto[];
}

export interface KnowledgeBaseMutationResult {
  success: boolean;
  message: string;
}

export interface KnowledgeBaseUploadResult {
  success: boolean;
  message: string;
  documents?: KnowledgeDocumentDto[];
}

export interface KnowledgeBaseRetryDocumentResult {
  success: boolean;
  message: string;
  document?: KnowledgeDocumentDto;
}

export interface KnowledgeBaseIndexMutationResult extends KnowledgeBaseMutationResult {
  index: KnowledgeBaseIndex;
  document?: KnowledgeDocumentDto;
}

export const knowledgeBaseApi = {
  list(): Promise<KnowledgeBaseIndex> {
    return http.get<KnowledgeBaseIndex>('/knowledge-base').then((r) => r.data);
  },
  getMigrationStatus(): Promise<Record<string, unknown>> {
    return http.get<Record<string, unknown>>('/knowledge-base/migration-status').then((r) => r.data);
  },
  createFolder(name: string): Promise<KnowledgeFolderDto> {
    return http.post<KnowledgeFolderDto>('/knowledge-base/folders', { name }).then((r) => r.data);
  },
  renameFolder(folderId: string, name: string): Promise<KnowledgeFolderDto> {
    return http.patch<KnowledgeFolderDto>(`/knowledge-base/folders/${encodeURIComponent(folderId)}`, { name }).then((r) => r.data);
  },
  reorderFolder(draggedFolderId: string, targetFolderId: string, position: 'before' | 'after'): Promise<KnowledgeBaseIndexMutationResult> {
    return http
      .post<KnowledgeBaseIndexMutationResult>('/knowledge-base/folders/reorder', { draggedFolderId, targetFolderId, position })
      .then((r) => r.data);
  },
  deleteFolder(folderId: string): Promise<KnowledgeBaseMutationResult> {
    return http.delete<KnowledgeBaseMutationResult>(`/knowledge-base/folders/${encodeURIComponent(folderId)}`).then((r) => r.data);
  },
  deleteDocument(documentId: string): Promise<KnowledgeBaseMutationResult> {
    return http.delete<KnowledgeBaseMutationResult>(`/knowledge-base/documents/${encodeURIComponent(documentId)}`).then((r) => r.data);
  },
  moveDocument(
    documentId: string,
    targetFolderId: string,
    targetDocumentId?: string | null,
    position?: 'before' | 'after',
  ): Promise<KnowledgeBaseIndexMutationResult> {
    return http
      .post<KnowledgeBaseIndexMutationResult>('/knowledge-base/documents/move', {
        documentId,
        targetFolderId,
        targetDocumentId: targetDocumentId ?? null,
        position,
      })
      .then((r) => r.data);
  },
  readMarkdown(documentId: string): Promise<string> {
    return http.get<string>(`/knowledge-base/documents/${encodeURIComponent(documentId)}/markdown`).then((r) => r.data ?? '');
  },
  readItems(documentId: string): Promise<unknown[]> {
    return http.get<unknown[]>(`/knowledge-base/documents/${encodeURIComponent(documentId)}/items`).then((r) => r.data);
  },
  readAnalysis(documentId: string): Promise<Record<string, unknown>> {
    return http.get<Record<string, unknown>>(`/knowledge-base/documents/${encodeURIComponent(documentId)}/analysis`).then((r) => r.data);
  },
  getOutlineReferences(documentIds: string[]): Promise<{ items: Array<{ id: string; title: string; resume: string }> }> {
    return http.post<{ items: Array<{ id: string; title: string; resume: string }> }>('/knowledge-base/outline-references', { documentIds }).then((r) => r.data);
  },
  uploadDocuments(folderId: string, files: File[]): Promise<KnowledgeBaseUploadResult> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    // 文档解析（prepareDocument）已改后台 fire-and-forget，请求只剩 body 上传 + 落盘。
    // 但大 docx（数百页）的 body 上传——尤其从 SMB 网络共享读取时——可能数倍于全局 30s 超时。
    // 上传是用户主动等待的交互操作，此处放宽到 10 分钟仅作用于本请求。
    return http
      .post<KnowledgeBaseUploadResult>(`/knowledge-base/folders/${encodeURIComponent(folderId)}/documents/upload`, form, {
        timeout: 600000,
      })
      .then((r) => r.data);
  },
  retryDocument(documentId: string): Promise<KnowledgeBaseRetryDocumentResult> {
    return http
      .post<KnowledgeBaseRetryDocumentResult>(`/knowledge-base/documents/${encodeURIComponent(documentId)}/retry`)
      .then((r) => r.data);
  },
  startMatching(documentId: string, batchSize: number): Promise<KnowledgeBaseRetryDocumentResult> {
    return http
      .post<KnowledgeBaseRetryDocumentResult>(`/knowledge-base/documents/${encodeURIComponent(documentId)}/match`, { batchSize })
      .then((r) => r.data);
  },
};
