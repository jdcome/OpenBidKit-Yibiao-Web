// 标书查重命名空间的 Web 实现：window.yibiao.duplicateCheck.* 的底层。
// 按 userId 隔离（服务端按 JWT 过滤）。DTO 混合大小写：顶层 workspace 标量 camelCase，
// 分析子状态 envelope 混合（started_at/updated_at snake_case，contentExtraction 等 camelCase），
// item/row/file 详情全 snake_case。详见 shared/types/bid.ts:63-233（渲染器侧权威类型）。
// selectDuplicateCheckFiles（桌面 file: 命名空间下的文件选择对话框）由 file 命名空间桥接
// （见 bridge.ts 的 file.selectDuplicateCheckFiles），底层调本模块 selectFiles；
// tasks.startDuplicateAnalysis（查重流水线）属 P6 任务引擎，bridge 侧不定义（可选链 no-op）。
import { http } from './http';

// workspace state 形状复杂且渲染器已从 shared/types/bid.ts 持权威类型，此处用宽松返回。
export type DuplicateCheckWorkspaceState = Record<string, unknown>;

export interface DuplicateCheckClearResult {
  success: boolean;
  message: string;
  state: DuplicateCheckWorkspaceState;
}

export interface DuplicateCheckFilePayload {
  tenderFile?: unknown;
  tenderFiles?: unknown[];
  bidFiles?: unknown[];
  step?: string;
  activeAnalysisTab?: string;
}

export interface DuplicateCheckUiStatePayload {
  step?: string;
  activeAnalysisTab?: string;
}

// 与桌面 shared/types/bid.ts LocalFileSelection / FileSelectionResult 对齐（snake_case）。
export interface LocalFileSelection {
  id: string;
  file_name: string;
  file_path: string;
  extension: string;
  size: number;
  modified_at: string;
}

export interface FileSelectionResult {
  success: boolean;
  message: string;
  files?: LocalFileSelection[];
}

export const duplicateCheckApi = {
  loadState(): Promise<DuplicateCheckWorkspaceState> {
    return http.get<DuplicateCheckWorkspaceState>('/duplicate-check/state').then((r) => r.data);
  },
  saveFiles(payload: DuplicateCheckFilePayload): Promise<DuplicateCheckWorkspaceState> {
    return http.post<DuplicateCheckWorkspaceState>('/duplicate-check/files', payload).then((r) => r.data);
  },
  saveUiState(payload: DuplicateCheckUiStatePayload): Promise<DuplicateCheckWorkspaceState> {
    return http.post<DuplicateCheckWorkspaceState>('/duplicate-check/ui-state', payload).then((r) => r.data);
  },
  updateState(partial: Record<string, unknown>): Promise<DuplicateCheckWorkspaceState> {
    return http.post<DuplicateCheckWorkspaceState>('/duplicate-check/update', partial).then((r) => r.data);
  },
  clear(): Promise<DuplicateCheckClearResult> {
    return http.post<DuplicateCheckClearResult>('/duplicate-check/clear').then((r) => r.data);
  },
  selectFiles(files: File[]): Promise<FileSelectionResult> {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name));
    return http.post<FileSelectionResult>('/duplicate-check/select-files', fd).then((r) => r.data);
  },
};
