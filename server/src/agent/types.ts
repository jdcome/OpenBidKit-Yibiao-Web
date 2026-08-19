// OpenCode Agent 运行时类型契约（移植自桌面 client/electron/services/opencode + client/src/shared/types/ipc.ts:159-284）。
//
// agentService 在 TaskRunnerContext 里替换原 unknown。runner（outline/content）只真正调用 runTask；
// boot/close/getStatus/runSelfCheck/restart 等供运维路由 / 进程生命周期使用。
//
// 单 sidecar 串行：同一时刻仅 1 个 agent 任务运行，其余排队 → 队首命中占用时 resolve busy 哨兵。
// runner 既有契约（isAgentBusyResult）已假定单飞，故 busy 经返回值（非同步抛错）传递。

export interface AgentTaskFile {
  /** 相对 agent workspace 的路径；运行时会经 safeRelativePath 净化（拒 .. / opencode.json / agents.md / .opencode / .claude） */
  path: string;
  content: string;
}

export interface AgentActivityEvent {
  stage?: string;
  message?: string;
  source?: string;
  /** visible=false 的活动只驱动看门狗（不展示给用户），如 http 层心跳 */
  visible?: boolean;
  /** activity=false 表示非"实质活动"（不重置 idle 计时） */
  activity?: boolean;
  /** 活动令牌：AI proxy 经 getActivityContext 注入，touchActivity 校验是否属于当前活动任务（防过期活动污染） */
  task_token?: string;
  /** 附加元数据（request_id/attempt/route 等），透传给 onActivity 消费方 */
  meta?: Record<string, unknown>;
}

export interface AgentValidationCandidate {
  output_content?: string;
  assistant_text?: string;
}

export interface AgentValidationContext {
  attempt: number;
  max_retries: number;
  task_id: string;
  title: string;
  output_file: string;
  workspace_dir: string;
  session_id: string;
  retry_attempts: unknown[];
}

export interface AgentRunTaskPayload {
  task_id?: string;
  title?: string;
  /** prompt 优先；缺省时由 runtime 用 task 构造默认 prompt */
  prompt?: string;
  task?: string;
  /** 默认 'agent-result.md'；相对 workspace */
  output_file?: string;
  files?: AgentTaskFile[];
  /** 默认 10min；outline 用 FINAL_AGENT_TIMEOUT_MS，content 用 30min */
  timeout_ms?: number;
  /** 默认 1，钳制 [0,3]；max_retries=1 → 最多 2 次模型调用 */
  max_retries?: number;
  /** 默认 'build'（opencode agent persona） */
  agent?: string;
  /** content 路径传 AbortSignal；outline 不传。可中止排队中或运行中的任务 */
  signal?: AbortSignal;
  /** 校验回调；throw 视为校验失败并消耗一次重试（标 agentValidationFailed） */
  validateOutput?: (candidate: AgentValidationCandidate, context: AgentValidationContext) => unknown | Promise<unknown>;
  onActivity?: (event: AgentActivityEvent) => void;
  /** pi: JSON Schema 映射（相对 workspace 路径 → schema），供 json-validation 工具校验 agent 输出；opencode 忽略 */
  json_validation_schemas?: Record<string, object>;
  /** pi: 持久任务（可恢复）；V1 不传（一次性），V2 多阶段状态机用；opencode 忽略 */
  persistent_task?: {
    task_key: string;
    mode: 'create' | 'resume';
    session_file?: string;
    initial_stage?: string;
    state?: Record<string, unknown>;
  };
  /** pi: 当前任务所属项目 id（ask-user 提问经 SSE agent-question 通道回传该项目浏览器）；opencode 忽略 */
  project_id?: number;
}

export interface AgentRetryAttempt {
  attempt: number;
  at: string;
  error?: string;
  output_chars?: number;
}

export interface AgentRunTaskSuccessResult {
  success: true;
  task_id: string;
  title: string;
  /** 归档后的每任务 workspace 副本（tasksRoot/<id>/workspace） */
  workspace_dir: string;
  runtime_workspace_dir?: string;
  runtime_root?: string;
  output_file: string;
  /** runner 主读字段 */
  output_content: string;
  /** output_content 为空时的兜底 */
  assistant_text: string;
  diff: unknown[];
  session_id: string;
  retry_count: number;
  retry_attempts: AgentRetryAttempt[];
  validation_result?: unknown;
  opencode_request_log?: unknown[];
  opencode_stderr_tail?: string;
  opencode_stdout_tail?: string;
}

export interface AgentRunTaskBusyResult {
  success: false;
  status: 'busy';
  skipped: true;
  message: string;
  active_task?: unknown;
}

export type AgentRunTaskResult = AgentRunTaskSuccessResult | AgentRunTaskBusyResult;

/** busy 哨兵判定（runner 既有契约，镜像桌面 isAgentBusyResult） */
export function isAgentBusyResult(result: unknown): result is AgentRunTaskBusyResult {
  return (
    !!result &&
    typeof result === 'object' &&
    ((result as Record<string, unknown>).status === 'busy' ||
      (result as Record<string, unknown>).skipped === true)
  );
}

export type AgentRuntimePhase = 'stopped' | 'starting' | 'idle' | 'running' | 'restarting' | 'unhealthy' | 'closing';

export interface AgentActiveTaskInfo {
  task_id: string;
  title: string;
  started_at: string;
  retry_count?: number;
  stage?: string;
  progress_text?: string;
  last_activity_at?: string;
  last_progress_at?: string;
  elapsed_seconds?: number;
  idle_seconds?: number;
}

export interface AgentQueuedTaskInfo {
  task_id: string;
  title: string;
  queued_at: string;
  position: number;
}

export interface AgentServiceStatus {
  phase: AgentRuntimePhase;
  available: boolean;
  message?: string;
  updated_at?: string;
  last_health_at?: string;
  last_error?: string | null;
  restart_pending?: boolean;
  restart_pending_reason?: string;
  active_task?: AgentActiveTaskInfo | null;
  queued: number;
  queued_tasks?: AgentQueuedTaskInfo[];
  proxy?: { active: number; queued: number; limit: number };
  sidecar?: {
    pid?: number;
    port?: number;
    base_url?: string;
    ai_proxy_base_url?: string;
    last_exit_code?: number | null;
    last_exit_signal?: string;
  } | null;
  health_failure_count?: number;
}

export interface AgentSelfCheckStep {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message?: string;
  detail?: unknown;
}

export interface AgentSelfCheckReport {
  started_at: string;
  finished_at: string;
  overall: 'pass' | 'fail' | 'warn';
  steps: AgentSelfCheckStep[];
  diagnostics?: Record<string, unknown>;
}

export type AgentStatusListener = (status: AgentServiceStatus) => void;

export interface AgentQuestionOption {
  id?: string;
  label: string;
  description?: string;
  recommended?: boolean;
  /** true=用户选中后需输入具体要求；一次提问最多一个 custom=true */
  custom?: boolean;
}

/** pi ask-user 挂起的问题（经 SSE agent-question 通道下发前端） */
export interface AgentPendingQuestion {
  question_id: string;
  task_id: string;
  task_title?: string;
  /** pi: 提问所属项目（无则前端退化为轮询 GET /agent/pending-question） */
  project_id?: number;
  question: string;
  options: AgentQuestionOption[];
  /** 结构化问题的附加数据；普通 ask-user 不传。 */
  metadata?: unknown;
  asked_at: string;
}

/** pi ask-user 作答（POST /api/agent/answer） */
export interface AgentQuestionAnswer {
  question_id: string;
  option_id: string;
  custom_answer?: string;
  /** 结构化问题的结构化回答；普通 ask-user 不传。 */
  answer_payload?: unknown;
}

/** 服务端任务可直接发起的人机确认请求（不需要额外跑一次 Agent 模型）。 */
export interface AgentQuestionRequest {
  task_id?: string;
  task_title?: string;
  project_id?: number;
  question: string;
  options: AgentQuestionOption[];
  metadata?: unknown;
}

export interface AgentQuestionResolution {
  option_id: string;
  custom_answer?: string;
  answer_payload?: unknown;
}

export type AgentQuestionListener = (question: AgentPendingQuestion | null) => void;

/**
 * runner 依赖的最小契约 = runTask；其余方法供运维路由 / 进程生命周期。
 * TaskRunnerContext.agentService 类型即此接口（| undefined：sidecar 不可用时降级）。
 */
export interface AgentService {
  runTask(payload: AgentRunTaskPayload): Promise<AgentRunTaskResult>;
  /** 进程启动后调用：spawn sidecar + AI proxy + 健康巡检。失败不抛（标 unavailable） */
  boot(): Promise<void>;
  /** 优雅关闭：abort 活动任务、reject 队列、SIGTERM sidecar、关 proxy */
  close(): Promise<void>;
  getStatus(): AgentServiceStatus;
  runSelfCheck(): Promise<AgentSelfCheckReport>;
  restart(reason?: string): Promise<void>;
  markRestartPending(reason?: string): void;
  handleConfigChanged(next: Record<string, unknown>, prev: Record<string, unknown>): void;
  onStatus(listener: AgentStatusListener): () => void;
  warmup(): Promise<void>;
  /** pi ask-user 通道：返回当前挂起的问题（无则 null）；opencode 回退不实现 */
  getPendingQuestion?(): AgentPendingQuestion | null;
  /** pi ask-user 作答：resolve 挂起的 pending Promise；opencode 回退不实现 */
  answerQuestion?(payload: AgentQuestionAnswer): Promise<{ answered: boolean }>;
  /** pi ask-user 通道：服务端 runner 直接发起确认问题；opencode 回退不实现 */
  requestQuestion?(payload: AgentQuestionRequest): Promise<AgentQuestionResolution>;
  /** pi ask-user 订阅问题状态变化；opencode 回退不实现 */
  onQuestion?(listener: AgentQuestionListener): () => void;
}
