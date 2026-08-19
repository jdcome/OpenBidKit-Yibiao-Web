// 任务引擎类型契约。
// 任务 = 长耗时后台生成（招标解析/目录/全局事实/正文/废标项/查重等），AI 调用分钟级。
// engine（service.ts）只负责编排（建任务/组锁/进度上报/崩溃恢复/SSE 广播），
// 真正的生成逻辑由 runner 注入（L3 注册表为空，L4 移植 9 个 runner 落入）。
//
// 忠实对齐桌面 client/electron/services/taskService.cjs 的 BackgroundTaskState 形状
// （snake_case，与 client/src/features/technical-plan/types.ts 的 BackgroundTaskState 一致）。

import type { PrismaClient } from '@prisma/client';
import type { AgentService } from '../agent/types';

export type TaskType =
  | 'bid-section-extraction'
  | 'bid-analysis'
  | 'outline-generation'
  | 'global-facts-generation'
  | 'content-generation'
  | 'rejection-items-extraction'
  | 'rejection-check-run'
  | 'duplicate-analysis'
  | 'response-deviation-generation';

export type TaskGroup = 'technical-plan' | 'rejection-check' | 'duplicate-check' | 'response-deviation';

export interface TaskDefinition {
  label: string;
  group: TaskGroup;
  groupLabel: string;
  step: number;
  lockPolicy: 'group-exclusive' | 'scope-exclusive' | 'none';
  stateKey: 'technicalPlan' | 'rejectionCheck' | 'duplicateCheck' | 'responseDeviation';
  field?: string;
}

// 任务对象（snake_case，跨 technicalPlan/rejectionCheck/duplicateCheck 三域统一形状）。
// 前几字段是稳定契约（渲染器解构消费）；group/step/lock_policy/scope_id/payload_signature
// 是 createTask 打上的编排元数据（客户端一般不读，但随对象原样回传）。
export interface BackgroundTaskState {
  task_id: string;
  type: string;
  status: string;
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
  stats?: unknown;
  pause_requested: boolean;
  group?: string;
  step?: number;
  lock_policy?: string;
  scope_id?: string;
  payload_signature?: string;
  diagnostic_trace_id?: string;
  degraded?: boolean;
  reused?: boolean;
}

// 暂停控制句柄：runner 通过 taskControl.isPauseRequested() 在 AI 请求间隙轮询；
// requestPause() 由 pauseContentGeneration 触发，把任务标 pausing 并写库。
// pauseRequested 是可变标志（engine 内部 + updateTask 读取），故公开为字段。
export interface TaskControl {
  queueScopeId: string;
  pauseRequested: boolean;
  isPauseRequested(): boolean;
  requestPause(): Promise<BackgroundTaskState>;
}

// emit 快照里随任务一起回传的工作区增量（对齐桌面 buildSnapshot 输出）。
// technicalPlanPatch 是技术方案状态的部分字段；rejectionCheck/duplicateCheck 为整域状态。
export interface TaskSnapshot {
  technicalPlanPatch?: Record<string, unknown>;
  rejectionCheck?: unknown;
  duplicateCheck?: unknown;
  responseDeviation?: unknown;
  bidItem?: unknown;
  outlineData?: unknown;
  contentSection?: unknown;
  contentPlan?: unknown;
  contentRuntime?: unknown;
}

// SSE 'tasks' 通道单帧：扁平 { task, ...snapshot }，与桌面 tasks:event 包络一致
// （client/src/shared/types/ipc.ts:10-21 TaskEvent）。渲染器直接读 event.technicalPlanPatch 等。
export type TaskEvent = { task: BackgroundTaskState } & TaskSnapshot;

// runner 注入的更新回调：写库 + 广播（shouldPersist=true 时）。
// 仅更新内存任务（不发事件）时传 shouldPersist=false（如高频心跳节流场景）。
export type UpdateTaskFn = (
  partial: Partial<BackgroundTaskState>,
  shouldPersist?: boolean,
  eventPatch?: Record<string, unknown>,
) => Promise<BackgroundTaskState>;

// runner 上下文：engine 把 runner 需要的依赖 + 回调打包注入。
// aiService/agentService 在 L4 才真正使用；L3 引擎骨架不依赖它们。
// config: 任务启动时一次性 buildMerged(project.ownerId) 的快照（含真实 key），runner 读 flag 用。
// aiService: 经 wrapAiForRunner 包装成桌面签名 chat(request)/requestJson(request)
//   （web 原始签名是 chat(config,request)），自动注入 __sseProjectId + queueScopeId，
//   使上游 401 错路由给触发项目的 SSE 通道、pauseQueueScope 能 gate 排队中的 AI 请求。
// runner 不读 ctx.projectId，全靠 workspaceStore 门面（已按 projectId 预绑定）。
export interface DesktopAiService {
  chat: (request: Record<string, unknown>) => Promise<string>;
  requestJson: (request: Record<string, unknown>) => Promise<unknown>;
  collectJsonResponse: (request: Record<string, unknown>) => Promise<unknown>;
  parseJsonResponseContent: (request: Record<string, unknown>, content: unknown) => Promise<unknown>;
  getConfig: () => Record<string, unknown>;
  isDeveloperMode?: () => boolean;
  listModels: (config?: Record<string, unknown>) => Promise<unknown>;
  testImageModel?: (config?: Record<string, unknown>) => Promise<unknown>;
}

export interface TaskRunnerContext {
  projectId: number;
  prisma: PrismaClient; // 提示词管理：runner 加载 DB 驱动的 prompt 目录（兜底硬编码）
  aiService: DesktopAiService;
  agentService: AgentService | undefined;
  workspaceStore: unknown;
  knowledgeBaseService: unknown;
  config: Record<string, unknown>;
  updateTask: UpdateTaskFn;
  payload: Record<string, unknown>;
  taskControl: TaskControl;
  previousState: unknown;
  diagnosticTraceId?: string;
  aiDiagnostics?: {
    markFallback(traceId: string, stage: string, warnings: string[]): Promise<unknown> | unknown;
  };
}

export type TaskRunner = (ctx: TaskRunnerContext) => Promise<void>;
