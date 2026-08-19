// 任务引擎命名空间的 Web 实现：window.yibiao.tasks.* 的底层（10 个 RPC + SSE 订阅）。
// 1:1 对齐桌面 client/electron/ipc/taskIpc.cjs：9 个 start-* / pause / get-active。
// SSE 'tasks' 通道由 sseManager 统一订阅，bridge.tasks.onTaskEvent 注册监听器分发。
//
// 任务进度实时性：start 返回初始 BackgroundTaskState 后，后续 running→progress→success/error
// 全部经 SSE 'tasks' 通道推送（service.ts 每次 updateTask(shouldPersist=true) 都 emit）。
// 客户端无需轮询 getActiveTasks——SSE 断线重连 + mount 时各页自调 getActiveTasks 兜底。
import { http } from './http';

export interface BackgroundTaskState {
  task_id: string;
  type: string;
  status: string;
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
  diagnostic_trace_id?: string;
  degraded?: boolean;
  reused?: boolean;
  stats?: unknown;
  pause_requested?: boolean;
  [key: string]: unknown;
}

export const tasksApi = {
  startBidSectionExtraction(payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/start-bid-section-extraction', payload ?? {}).then((r) => r.data);
  },
  startBidAnalysis(payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/start-bid-analysis', payload ?? {}).then((r) => r.data);
  },
  startOutlineGeneration(payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/start-outline-generation', payload ?? {}).then((r) => r.data);
  },
  startGlobalFactsGeneration(payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/start-global-facts-generation', payload ?? {}).then((r) => r.data);
  },
  startContentGeneration(payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/start-content-generation', payload ?? {}).then((r) => r.data);
  },
  pauseContentGeneration(): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/pause-content-generation', {}).then((r) => r.data);
  },
  startRejectionItemsExtraction(payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/start-rejection-items-extraction', payload ?? {}).then((r) => r.data);
  },
  startRejectionCheck(payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/start-rejection-check', payload ?? {}).then((r) => r.data);
  },
  startDuplicateAnalysis(payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return http.post<BackgroundTaskState>('/tasks/start-duplicate-analysis', payload ?? {}).then((r) => r.data);
  },
  getActiveTasks(): Promise<BackgroundTaskState[]> {
    return http.get<BackgroundTaskState[]>('/tasks/active').then((r) => r.data);
  },
};
