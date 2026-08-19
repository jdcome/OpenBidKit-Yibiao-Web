// Pi Agent 运行时编排器（移植自桌面 electron/services/pi/piRuntimeService.cjs）。
// 职责：进程级单例 AI Proxy 生命周期 + 单飞任务执行（runTask）+ 重试 + 活动看门狗 +
// 健康巡检 + ask-user 提问通道 + 自检。
//
// 与 opencode runtimeService 共享骨架（phase 机 / busy 哨兵 / staging-archive /
// watchdog / 状态广播 / 配置热更），核心差异：
//  ① 无 sidecar：ensureStarted = loadPiModules + preparePiEnvironment + createAiServiceOpenAiProxy.start。
//  ② 无 sqlite 轮询：pi Session 经 subscribe 把 tool/text/retry 事件转 touchActivity。
//  ③ 无 HTTP client：直接 session.prompt；diff 由 tool_execution_end 事件累积。
//  ④ ask-user：pi 自定义工具调 requestUserQuestion → waitForUserQuestion 内部挂起
//     （pending Promise），POST /api/agent/answer 经 answerQuestion resolve。
//  ⑤ runSelfCheck 委托 piSelfCheck 探针（环境/SDK/runtime/工具/模型/loopback/agent）；
//     diagnosis(LLM)/repair/recheck 在 M1 跳过（自检正常即绿）。
//  ⑥ persistent_task（V2 多阶段状态机）M1 不启用：V1 一次性任务，payload 不传该字段。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from '../document/paths';
import { createAiServiceOpenAiProxy, type AgentProxyHandle } from './aiProxy';
import { preparePiEnvironment, type PreparedPiEnvironment } from './pi/piEnvironment';
import { createPiSession, loadPiModules, type PiProxyInfo, type PiSession, type PiSessionSnapshot } from './pi/piSessionFactory';
import {
  createPersistentAgentTask,
  loadPersistentAgentTask,
  updatePersistentAgentTask,
  type PersistentAgentTaskPaths,
  type PersistentAgentTaskState,
} from './pi/piPersistentTaskStore';
import type { RequestUserQuestion, PiUserQuestionRequest, PiUserQuestionResolution } from './pi/piUserQuestionTool';
import { restorePiErrorMessage } from './pi/piRetryErrorNormalizer';
import {
  createPiEnvironmentSnapshot,
  createPiSelfCheckSteps,
  runPiLoopbackSelfCheck,
  runPiTextModelSelfCheck,
  runPiToolEnvironmentSelfCheck,
  serializeDiagnosticError,
  summarizeTextModelConfig,
  validatePiSessionSnapshot,
  type PiSelfCheckConfig,
} from './pi/piSelfCheck';
import type { AgentAiConfig } from '../config/store';
import type {
  AgentActivityEvent,
  AgentActiveTaskInfo,
  AgentPendingQuestion,
  AgentQuestionAnswer,
  AgentQuestionListener,
  AgentQuestionOption,
  AgentQuestionRequest,
  AgentQuestionResolution,
  AgentRetryAttempt,
  AgentRunTaskPayload,
  AgentRunTaskResult,
  AgentRunTaskSuccessResult,
  AgentSelfCheckReport,
  AgentSelfCheckStep,
  AgentService,
  AgentServiceStatus,
  AgentStatusListener,
  AgentValidationCandidate,
  AgentValidationContext,
} from './types';

const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
const HEALTH_INTERVAL_MS = 30 * 1000;
const HEALTH_FAILURE_LIMIT = 3;
const STATUS_TICK_MS = 1000;
const WORKSPACE_WATCH_INTERVAL_MS = 2000;
const BUSY_MESSAGE = 'Agent 正在处理其他任务，请耐心等待';
const DEFAULT_AGENT_MAX_RETRIES = 1;
const MAX_AGENT_MAX_RETRIES = 3;

const SELF_CHECK_TASK_ID = 'pi-self-check';
const SELF_CHECK_OUTPUT_FILE = 'agent-self-check-result.json';
const SELF_CHECK_OK_MESSAGE = 'YIBIAO_PI_AGENT_SELF_CHECK_OK';
const SELF_CHECK_INPUT = 'YIBIAO_PI_AGENT_SELF_CHECK_INPUT';
const SELF_CHECK_NODE_MARKER = 'YIBIAO_PI_NODE_OK';
const SELF_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const SELF_CHECK_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['message', 'input', 'node'],
  additionalProperties: false,
  properties: {
    message: { const: SELF_CHECK_OK_MESSAGE },
    input: { const: SELF_CHECK_INPUT },
    node: { const: SELF_CHECK_NODE_MARKER },
  },
};

type InternalPhase = 'stopped' | 'starting' | 'idle' | 'running' | 'restarting' | 'unhealthy' | 'closing';

// pi Session 的运行时调用面（createPiSession 返回的 PiSession 经此强类型化使用）。
interface PiSessionRuntime {
  sessionId?: string;
  sessionFile?: string;
  messages?: Array<Record<string, unknown>>;
  prompt(text: string, options?: Record<string, unknown>): Promise<unknown>;
  subscribe(handler: (event: Record<string, unknown>) => void): () => void;
  dispose?(): void;
  abort?(): Promise<void>;
  abortCompaction?(): void;
  getActiveToolNames?(): string[];
}

interface ActiveTask {
  task_id: string;
  title: string;
  stage: string;
  progress_text: string;
  started_at: string;
  last_activity_at: string;
  last_progress_at: string;
  timeout_ms: number;
  activity_token: string;
  activity_handler: ((event: AgentActivityEvent) => void) | null;
  waiting_for_user: boolean;
  user_question_answers: Array<Record<string, unknown>>;
  workspace_dir: string;
  project_id: number | undefined;
}

interface DiagnosticEvent {
  at: string;
  event: string;
  [key: string]: unknown;
}

interface RuntimeDiagnostics {
  events: DiagnosticEvent[];
  record(event: string, payload?: Record<string, unknown>): void;
}

interface SelfCheckStepInternal {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'warning';
  message: string;
  detail?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTimeoutMs(value: unknown, fallback = DEFAULT_AGENT_IDLE_TIMEOUT_MS): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeMaxRetries(value: unknown, fallback = DEFAULT_AGENT_MAX_RETRIES): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_AGENT_MAX_RETRIES, Math.floor(number)));
}

function compactText(value: unknown, maxLength = 300): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function compactErrorText(error: unknown, maxLength = 1200): string {
  const err = error as { message?: string; cause?: { message?: string; code?: string } } | null;
  const lines = [err?.message || String(error ?? '未知错误'), err?.cause?.message || err?.cause?.code || ''].filter(Boolean);
  const text = lines.join('\n').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function markAgentValidationError(error: unknown): unknown {
  if (error && typeof error === 'object') {
    (error as Record<string, unknown>).agentValidationFailed = true;
  }
  return error;
}

function buildAgentRetryPrompt(input: { outputFile: string; attempt: number; maxRetries: number; error: unknown }): string {
  return `上一轮 Agent 执行没有通过程序校验或执行过程中失败。

失败信息：
${compactErrorText(input.error, 800)}

请继续使用当前会话和当前工作区已有文件，不要重新开始任务，不要清空工作区。
请先检查 ${input.outputFile} 和必要的输入文件，定位失败原因，只做必要修复。
修复后仍然把最终结果写入 ${input.outputFile}。

这是第 ${input.attempt}/${input.maxRetries} 次自动修复机会。`;
}

function createRetryAttemptSummary(input: { attempt: number; error: unknown; outputContent: string }): AgentRetryAttempt {
  return {
    attempt: input.attempt,
    at: nowIso(),
    error: compactErrorText(input.error, 600),
    output_chars: String(input.outputContent || '').length,
  };
}

// pi 保留路径与 opencode 不同（.pi / .agents），其余净化逻辑一致。
function safeRelativePath(value: unknown): string {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..')) {
    throw new Error(`非法文件路径：${value}`);
  }
  const lower = raw.toLowerCase();
  if (
    lower === 'agents.md' ||
    lower === 'claude.md' ||
    lower.startsWith('.pi/') ||
    lower.startsWith('.agents/')
  ) {
    throw new Error(`Pi Agent 保留路径不允许作为任务输入：${value}`);
  }
  return raw;
}

function safeTaskPathSegment(value: unknown): string {
  return (
    String(value || crypto.randomUUID())
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || crypto.randomUUID()
  );
}

function ensureInsideRoot(rootDir: string, targetPath: string, sourcePath: unknown): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`文件路径越界：${sourcePath}`);
  }
  return resolvedTarget;
}

function writeWorkspaceFiles(workspaceDir: string, files: { path: string; content: string }[] = []): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const file of files) {
    const relativePath = safeRelativePath(file.path);
    const targetPath = ensureInsideRoot(workspaceDir, path.join(workspaceDir, relativePath), file.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, String(file.content || ''), 'utf-8');
  }
}

function clearDirectoryContents(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function createDefaultAgentPrompt(input: { task: string; outputFile: string }): string {
  return `请只在当前工作目录内工作。

任务：
${input.task}

要求：
1. 先阅读当前目录中的输入文件。
2. 自主判断下一步需要做什么。
3. 如需产出结果，请写入 ${input.outputFile}。
4. 不要访问当前工作目录外的文件。
5. 不要联网。
6. 最终回复请包含：发现的问题、处理动作、输出文件路径。`;
}

function readOutputContent(workspaceDir: string, outputFile: string): { path: string; content: string } {
  const relativePath = safeRelativePath(outputFile);
  const outputPath = ensureInsideRoot(workspaceDir, path.join(workspaceDir, relativePath), outputFile);
  let content = '';
  try {
    content = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
  } catch (error) {
    if ((error as { code?: string })?.code !== 'ENOENT') throw error;
  }
  return { path: outputPath, content };
}

// ---- pi 消息提取（session.messages → 文本 / 错误）----

function extractMessageText(message: Record<string, unknown> | undefined): string {
  const content = Array.isArray(message?.content) ? message!.content : [];
  return content
    .filter((part) => (part as Record<string, unknown>)?.type === 'text')
    .map((part) => String((part as Record<string, unknown>).text || ''))
    .join('\n')
    .trim();
}

function extractAssistantText(messages: Array<Record<string, unknown>> = []): string {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  return extractMessageText(assistant);
}

function getAssistantError(messages: Array<Record<string, unknown>> = []): string {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  return assistant?.stopReason === 'error'
    ? restorePiErrorMessage(assistant.errorMessage || 'Pi Agent 模型请求失败')
    : '';
}

function getAssistantErrorDetails(messages: Array<Record<string, unknown>> = []): Record<string, unknown> | null {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  if (!assistant || assistant.stopReason !== 'error') return null;
  return {
    stop_reason: assistant.stopReason,
    error_message: restorePiErrorMessage(assistant.errorMessage || 'Pi Agent 模型请求失败'),
    api: assistant.api || '',
    provider: assistant.provider || '',
    model: assistant.model || '',
    timestamp: assistant.timestamp || 0,
  };
}

function annotateAgentError(error: unknown, meta: Record<string, unknown> = {}): Error {
  const err = error as Error & Record<string, unknown>;
  if (!err || typeof err !== 'object') return err;
  err.agentTaskId = meta.taskId || err.agentTaskId || '';
  err.agentTitle = meta.title || err.agentTitle || '';
  err.agentWorkspaceDir = meta.workspaceDir || err.agentWorkspaceDir || '';
  err.agentRuntimeRoot = meta.runtimeRoot || err.agentRuntimeRoot || '';
  err.agentOutputFile = meta.outputFile || err.agentOutputFile || '';
  err.agentOutputPath = meta.outputPath || err.agentOutputPath || '';
  err.agentPartialOutput = meta.outputContent || err.agentPartialOutput || '';
  err.agentPartialOutputChars = String(meta.outputContent || err.agentPartialOutput || '').length;
  err.agentValidationFailed = Boolean(err.agentValidationFailed);
  err.agentRetryAttempts = Array.isArray(err.agentRetryAttempts) ? err.agentRetryAttempts : [];
  return err;
}

function isUserCancelOrPause(error: unknown): boolean {
  const err = error as { code?: string; cause?: { code?: string }; message?: string } | null;
  const code = err?.code || err?.cause?.code;
  const message = String(err?.message || error || '');
  return (
    code === 'CONTENT_GENERATION_PAUSED' ||
    code === 'AI_QUEUE_SCOPE_PAUSED' ||
    code === 'ABORT_ERR' ||
    code === 'AGENT_DISCONNECTED' ||
    message === 'CONTENT_GENERATION_PAUSED' ||
    message.includes('请求已取消') ||
    message.includes('任务已取消')
  );
}

function isWatchdogStall(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'AGENT_STALLED';
}

function createStallError(): Error {
  const error = new Error('Agent 长时间无进展，已停止本轮任务');
  (error as { code?: string }).code = 'AGENT_STALLED';
  return error;
}

function createRuntimeDiagnostics(limit = 2000): RuntimeDiagnostics {
  const events: DiagnosticEvent[] = [];
  return {
    events,
    record(event, payload = {}) {
      events.push({ at: nowIso(), event, ...payload });
      if (events.length > limit) {
        events.splice(0, events.length - limit);
      }
    },
  };
}

function createAbortReason(signal: AbortSignal | undefined, fallbackMessage = 'Agent 任务已取消'): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason ? String(reason) : fallbackMessage);
  if (reason && typeof reason === 'object' && (reason as { code?: string }).code) {
    (error as { code?: string }).code = (reason as { code?: string }).code;
  }
  return error;
}

export interface CreatePiRuntimeServiceOptions {
  dataDir?: string;
  loadConfig?: () => AgentAiConfig | null;
}

export function createPiRuntimeService(options: CreatePiRuntimeServiceOptions = {}): AgentService {
  const dataDir = options.dataDir || getDataDir();
  const loadConfig = options.loadConfig || (() => null);

  const diagnostics = createRuntimeDiagnostics();
  const listeners = new Set<AgentStatusListener>();
  const questionListeners = new Set<AgentQuestionListener>();

  let environment: PreparedPiEnvironment | null = null;
  let phase: InternalPhase = 'stopped';
  let message = 'Pi Agent 服务未启动';
  let updatedAt = nowIso();
  let lastHealthAt = '';
  let lastHealthError = '';
  let restartPending = false;
  let restartPendingReason = '';
  let proxy: AgentProxyHandle | null = null;
  let proxyInfo: PiProxyInfo | null = null;
  let startPromise: Promise<PiProxyInfo | null> | null = null;
  let closePromise: Promise<void> | null = null;
  let activeTask: ActiveTask | null = null;
  let activeTaskAbortController: AbortController | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let healthFailureCount = 0;
  let healthRestartAttempted = false;
  let emitStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let sdkVersion = '';

  // ---- ask-user 提问挂起表 ----
  // key = question_id；value = { resolve(resolution), reject(error), question, options }
  const pendingQuestions = new Map<
    string,
    {
      question: AgentPendingQuestion;
      options: AgentQuestionOption[];
      resolve: (resolution: AgentQuestionResolution) => void;
      reject: (error: Error) => void;
    }
  >();

  function ensureEnvironment(): PreparedPiEnvironment {
    if (!environment) {
      environment = preparePiEnvironment(dataDir);
    }
    return environment;
  }

  function appendRuntimeEvent(event: Record<string, unknown> = {}): void {
    diagnostics.record('runtime.event', event);
  }

  function getActiveTaskSummary(): AgentActiveTaskInfo | null {
    if (!activeTask) return null;
    const now = Date.now();
    const startedAt = new Date(activeTask.started_at).getTime();
    const lastActivityAt = new Date(activeTask.last_activity_at).getTime();
    return {
      task_id: activeTask.task_id,
      title: activeTask.title,
      stage: activeTask.stage,
      progress_text: activeTask.progress_text,
      started_at: activeTask.started_at,
      last_activity_at: activeTask.last_activity_at,
      last_progress_at: activeTask.last_progress_at,
      elapsed_seconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
      idle_seconds: Math.max(0, Math.floor((now - lastActivityAt) / 1000)),
    };
  }

  function isAvailable(): boolean {
    return phase === 'idle' || phase === 'running';
  }

  function getStatus(): AgentServiceStatus {
    return {
      phase,
      available: isAvailable(),
      message,
      updated_at: updatedAt,
      last_health_at: lastHealthAt,
      last_error: lastHealthError || null,
      restart_pending: restartPending,
      restart_pending_reason: restartPendingReason,
      active_task: getActiveTaskSummary(),
      queued: 0,
      queued_tasks: [],
      proxy: proxy?.getStatus?.() || { active: 0, queued: 0, limit: 0 },
      sidecar: null,
      health_failure_count: healthFailureCount,
    };
  }

  function emitStatus(): void {
    const status = getStatus();
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        /* 监听器异常不影响运行时 */
      }
    }
  }

  function emitStatusThrottled(): void {
    if (emitStatusTimer) return;
    emitStatusTimer = setTimeout(() => {
      emitStatusTimer = null;
      emitStatus();
    }, 200);
  }

  function emitQuestion(question: AgentPendingQuestion | null): void {
    for (const listener of questionListeners) {
      try {
        listener(question);
      } catch {
        /* ignore */
      }
    }
  }

  function setPhase(nextPhase: InternalPhase, nextMessage?: string): void {
    phase = nextPhase;
    message = nextMessage || message;
    updatedAt = nowIso();
    appendRuntimeEvent({ phase, message, source: 'runtime.phase' });
    emitStatusThrottled();
    if (phase === 'idle' && restartPending && !activeTask) {
      setTimeout(() => {
        if (phase === 'idle' && restartPending && !activeTask) {
          void restart(restartPendingReason || 'config changed').catch((error) => {
            lastHealthError = error?.message || String(error || 'Pi Agent 服务重启失败');
            setPhase('unhealthy', 'Pi Agent 服务重启失败');
          });
        }
      }, 0);
    }
  }

  function touchActivity(event: AgentActivityEvent = {}): void {
    if (!activeTask) {
      appendRuntimeEvent({ ...event, at: nowIso(), ignored: true, reason: 'no-active-task' });
      return;
    }
    if (!event.task_token || event.task_token !== activeTask.activity_token) {
      appendRuntimeEvent({ ...event, at: nowIso(), stale: true });
      return;
    }
    const now = nowIso();
    if (event.activity !== false) {
      activeTask.last_activity_at = now;
    }
    if (event.visible !== false) {
      activeTask.stage = event.stage || activeTask.stage;
      activeTask.progress_text = event.message || activeTask.progress_text;
      activeTask.last_progress_at = now;
      message = activeTask.progress_text;
      updatedAt = now;
    }
    appendRuntimeEvent({ ...event, at: now });
    if (typeof activeTask.activity_handler === 'function') {
      try {
        activeTask.activity_handler(event);
      } catch (error) {
        appendRuntimeEvent({ at: nowIso(), source: 'task-activity-handler', message: (error as Error)?.message || String(error) });
      }
    }
    emitStatusThrottled();
  }

  function createTaskActivity(taskRef: ActiveTask): (event: AgentActivityEvent) => void {
    const taskToken = taskRef.activity_token;
    return (event = {}) => touchActivity({ ...event, task_token: taskToken });
  }

  function createActiveTask(input: { taskId: string; title: string; timeoutMs: number; workspaceDir: string; projectId: number | undefined; onActivity?: AgentRunTaskPayload['onActivity'] }): ActiveTask {
    const now = nowIso();
    return {
      task_id: input.taskId,
      title: input.title,
      stage: 'starting',
      progress_text: '',
      started_at: now,
      last_activity_at: now,
      last_progress_at: now,
      timeout_ms: input.timeoutMs,
      activity_token: crypto.randomUUID(),
      activity_handler: typeof input.onActivity === 'function' ? input.onActivity : null,
      waiting_for_user: false,
      user_question_answers: [],
      workspace_dir: input.workspaceDir,
      project_id: input.projectId,
    };
  }

  function createBusyResult(): AgentRunTaskResult {
    return {
      success: false,
      status: 'busy',
      skipped: true,
      message: BUSY_MESSAGE,
      active_task: getActiveTaskSummary(),
    };
  }

  function onStatus(listener: AgentStatusListener): () => void {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function startStatusTimer(): void {
    if (statusTimer) return;
    statusTimer = setInterval(() => {
      if (activeTask) emitStatus();
    }, STATUS_TICK_MS);
    if (typeof statusTimer.unref === 'function') statusTimer.unref();
  }

  function stopStatusTimer(): void {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  }

  async function checkProxyHealth(): Promise<void> {
    if (!proxyInfo) throw new Error('Pi AI Proxy 未启动');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Agent 服务健康检查超时')), 5000);
    try {
      const response = await fetch(`${proxyInfo.baseUrl}/health`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Agent proxy health status ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function stopIdleHealthTimer(): void {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
  }

  function startIdleHealthTimer(): void {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      if (phase !== 'idle' || activeTask || !proxyInfo) return;
      void checkProxyHealth()
        .then(() => {
          healthFailureCount = 0;
          healthRestartAttempted = false;
          lastHealthAt = nowIso();
          lastHealthError = '';
          updatedAt = lastHealthAt;
          emitStatusThrottled();
        })
        .catch((error) => {
          healthFailureCount += 1;
          lastHealthError = (error as Error)?.message || String(error || 'Agent 服务健康检查失败');
          updatedAt = nowIso();
          appendRuntimeEvent({ at: updatedAt, source: 'health', message: lastHealthError, failure_count: healthFailureCount });
          if (healthFailureCount >= HEALTH_FAILURE_LIMIT) {
            setPhase('unhealthy', 'Agent 服务健康检查失败');
            if (!healthRestartAttempted) {
              healthRestartAttempted = true;
              void restart('idle health failed').catch((restartError) => {
                lastHealthError = (restartError as Error)?.message || String(restartError || lastHealthError);
                setPhase('unhealthy', 'Pi Agent 服务异常');
              });
            }
          }
          emitStatusThrottled();
        });
    }, HEALTH_INTERVAL_MS);
    if (typeof healthTimer.unref === 'function') healthTimer.unref();
  }

  async function ensureStarted(): Promise<PiProxyInfo | null> {
    if (proxy && proxyInfo && phase !== 'unhealthy' && phase !== 'stopped' && phase !== 'closing') return proxyInfo;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      setPhase(phase === 'unhealthy' ? 'restarting' : 'starting', phase === 'unhealthy' ? '正在重启 Pi Agent 服务' : '正在启动 Pi Agent 服务');
      if (!loadConfig()) {
        throw new Error('Agent AI 配置缺失（平台文本模型未配置）');
      }
      ensureEnvironment();
      const { codingAgent } = await loadPiModules();
      sdkVersion = codingAgent.VERSION || '';
      proxy = createAiServiceOpenAiProxy({
        loadConfig,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
        diagnostics,
        onActivity: touchActivity,
        getActivityContext: () =>
          activeTask
            ? { task_token: activeTask.activity_token, task_id: activeTask.task_id }
            : null,
      });
      const started = await proxy.start();
      proxyInfo = { baseUrl: started.baseUrl, port: started.port, token: started.token };
      healthFailureCount = 0;
      healthRestartAttempted = false;
      lastHealthAt = nowIso();
      lastHealthError = '';
      setPhase(activeTask ? 'running' : 'idle', activeTask ? 'Pi Agent 正在执行任务' : 'Pi Agent 服务空闲');
      startIdleHealthTimer();
      startStatusTimer();
      return proxyInfo;
    })();

    try {
      return await startPromise;
    } catch (error) {
      try {
        await proxy?.close?.();
      } catch {
        /* ignore */
      }
      proxy = null;
      proxyInfo = null;
      if (phase !== 'closing' && phase !== 'stopped') {
        setPhase('unhealthy', (error as Error)?.message || 'Pi Agent 服务启动失败');
      }
      throw error;
    } finally {
      startPromise = null;
    }
  }

  function bindParentSignal(parentSignal: AbortSignal | undefined, controller: AbortController, getSession: () => PiSessionRuntime | null): () => void {
    const abortSession = () => {
      const session = getSession();
      try {
        session?.abortCompaction?.();
      } catch {
        /* ignore */
      }
      void session?.abort?.().catch(() => undefined);
    };
    const abort = () => {
      if (!controller.signal.aborted) {
        controller.abort(parentSignal?.reason || new Error('Agent 任务已取消'));
      }
      abortSession();
    };
    if (parentSignal) {
      if (parentSignal.aborted) abort();
      else parentSignal.addEventListener('abort', abort, { once: true });
    }
    const onSelfAbort = () => abortSession();
    controller.signal.addEventListener('abort', onSelfAbort, { once: true });
    return () => {
      try {
        parentSignal?.removeEventListener('abort', abort);
      } catch {
        /* ignore */
      }
      controller.signal.removeEventListener('abort', onSelfAbort);
    };
  }

  function startActivityWatchdog(input: {
    timeoutMs: number;
    taskToken: string;
    abort: (error: Error) => void;
  }): () => void {
    const timer = setInterval(() => {
      if (!activeTask || activeTask.waiting_for_user) return;
      const idleMs = Date.now() - new Date(activeTask.last_activity_at).getTime();
      if (idleMs >= input.timeoutMs) {
        touchActivity({
          task_token: input.taskToken,
          stage: 'stalled',
          message: 'Agent 长时间无进展，正在停止本轮任务',
          source: 'watchdog',
          visible: true,
          activity: false,
        });
        input.abort(createStallError());
      }
    }, 2000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  function startOutputWatcher(outputFile: string, taskActivity: (event: AgentActivityEvent) => void): () => void {
    let previousKey = '';
    const outputPath = ensureInsideRoot(
      activeTask?.workspace_dir || ensureEnvironment().layout.workspaceDir,
      path.join(activeTask?.workspace_dir || ensureEnvironment().layout.workspaceDir, safeRelativePath(outputFile)),
      outputFile,
    );
    const timer = setInterval(() => {
      try {
        if (!fs.existsSync(outputPath)) return;
        const stat = fs.statSync(outputPath);
        const nextKey = `${stat.size}:${stat.mtimeMs}`;
        if (previousKey && nextKey !== previousKey) {
          taskActivity({
            stage: 'tool',
            message: `输出文件已更新：${path.basename(outputFile)}（${stat.size} 字节）`,
            source: 'workspace.output',
            activity: true,
            meta: { size: stat.size },
          });
        }
        previousKey = nextKey;
      } catch {
        /* ignore */
      }
    }, WORKSPACE_WATCH_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  // pi Session 事件 → touchActivity（tool / assistant_text / model_retry / compaction 等）。
  function subscribeSession(session: PiSessionRuntime, taskToken: string, diffEntries: Array<Record<string, unknown>>): () => void {
    let streamedText = '';
    return session.subscribe((event) => {
      const type = String(event.type || '');
      if (type === 'message_start' && (event.message as Record<string, unknown> | undefined)?.role === 'assistant') {
        streamedText = '';
        return;
      }
      if (type === 'message_update' && (event.assistantMessageEvent as Record<string, unknown> | undefined)?.type === 'text_delta') {
        streamedText += String((event.assistantMessageEvent as Record<string, unknown>).delta || '');
        return;
      }
      if (type === 'message_end' && (event.message as Record<string, unknown> | undefined)?.role === 'assistant') {
        const completedText = extractMessageText(event.message as Record<string, unknown>) || streamedText.trim();
        streamedText = '';
        touchActivity({
          task_token: taskToken,
          stage: 'assistant_text',
          message: compactText(completedText, 200),
          source: 'pi.message',
          visible: Boolean(completedText),
          activity: true,
        });
        return;
      }
      if (type === 'tool_execution_start') {
        touchActivity({
          task_token: taskToken,
          stage: 'tool',
          message: `正在调用工具：${event.toolName || ''}`,
          source: 'pi.tool.start',
          visible: true,
          activity: true,
          meta: { tool: event.toolName },
        });
        return;
      }
      if (type === 'tool_execution_update') {
        touchActivity({ task_token: taskToken, stage: 'tool', message: '', source: 'pi.tool.update', visible: false, activity: true });
        return;
      }
      if (type === 'tool_execution_end') {
        const details = (event.result as Record<string, unknown> | undefined)?.details as Record<string, unknown> | undefined;
        if (details && (details.diff || details.patch)) {
          diffEntries.push({ tool: event.toolName, diff: details.diff || '', patch: details.patch || '' });
        }
        touchActivity({
          task_token: taskToken,
          stage: 'tool',
          message: `${event.toolName || ''} ${event.isError ? '执行失败' : '执行完成'}`,
          source: 'pi.tool.end',
          visible: true,
          activity: true,
          meta: { tool: event.toolName, is_error: Boolean(event.isError) },
        });
        return;
      }
      if (type === 'auto_retry_start') {
        const errorMessage = restorePiErrorMessage(event.errorMessage || '模型服务暂时不可用');
        const delaySeconds = Math.max(0, Math.round(Number(event.delayMs || 0) / 1000));
        touchActivity({
          task_token: taskToken,
          stage: 'model_retry',
          message: `模型请求遇到临时错误，${delaySeconds} 秒后进行第 ${event.attempt}/${event.maxAttempts} 次重试：${compactText(errorMessage, 160)}`,
          source: 'pi.auto-retry.start',
          visible: true,
          activity: true,
          meta: { attempt: event.attempt, maximum: event.maxAttempts, delay_ms: event.delayMs, error: errorMessage },
        });
        return;
      }
      if (type === 'auto_retry_end') {
        const finalError = restorePiErrorMessage(event.finalError || '');
        const retryMessage = event.success
          ? `模型请求已恢复，第 ${event.attempt} 次重试成功`
          : `模型请求重试 ${event.attempt} 次后仍失败${finalError ? `：${compactText(finalError, 160)}` : ''}`;
        touchActivity({
          task_token: taskToken,
          stage: 'model_retry',
          message: retryMessage,
          source: 'pi.auto-retry.end',
          visible: true,
          activity: true,
          meta: { attempt: event.attempt, success: Boolean(event.success), error: finalError },
        });
        return;
      }
      if (['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'compaction_start', 'compaction_end'].includes(type)) {
        touchActivity({ task_token: taskToken, stage: type, message: '', source: `pi.${type}`, visible: false, activity: true });
      }
    });
  }

  // ---- ask-user 提问通道 ----
  // requestUserQuestion 契约实现：挂起当前工具调用直到 answerQuestion 到达或 signal abort。
  const requestUserQuestion: RequestUserQuestion = (request: PiUserQuestionRequest, signal?: AbortSignal) =>
    waitForUserQuestion(request, signal, activeTask?.activity_token || '');

  async function waitForUserQuestion(
    request: PiUserQuestionRequest,
    signal: AbortSignal | undefined,
    taskToken: string,
  ): Promise<PiUserQuestionResolution> {
    if (!activeTask || activeTask.activity_token !== taskToken) {
      throw new Error('当前 Agent 任务已结束，无法继续提问');
    }
    const questionId = crypto.randomUUID();
    const options: AgentQuestionOption[] = (request.options || []).map((option, index) => ({
      id: `option-${index}`,
      label: option.label,
      description: option.description,
      recommended: index === 0,
      custom: option.custom,
    }));
    const pendingQuestion: AgentPendingQuestion = {
      question_id: questionId,
      task_id: activeTask.task_id,
      task_title: activeTask.title,
      project_id: activeTask.project_id,
      question: request.question,
      options,
      asked_at: nowIso(),
    };
    activeTask.waiting_for_user = true;
    touchActivity({
      task_token: taskToken,
      stage: 'waiting_for_user',
      message: 'Agent 正在等待您的回答',
      source: 'pi.user-question.waiting',
      visible: true,
      activity: true,
      meta: { question_id: questionId },
    });
    let answered = false;
    return new Promise<PiUserQuestionResolution>((resolve, reject) => {
      const onAbort = () => {
        if (answered) return;
        pendingQuestions.delete(questionId);
        if (activeTask?.activity_token === taskToken) {
          activeTask.waiting_for_user = false;
        }
        reject(new Error('Agent 提问已被取消'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      pendingQuestions.set(questionId, {
        question: pendingQuestion,
        options,
        resolve: (resolution) => {
          answered = true;
          signal?.removeEventListener?.('abort', onAbort);
          pendingQuestions.delete(questionId);
          if (activeTask?.activity_token === taskToken) {
            const selectedOption = options.find((option) => option.id === resolution.option_id);
            activeTask.user_question_answers.push({
              question: String(request.question || ''),
              answer: resolution.custom_answer || selectedOption?.label || '',
              selected_option: resolution.option_id || '',
              is_custom: Boolean(selectedOption?.custom),
              answered_at: nowIso(),
            });
            activeTask.waiting_for_user = false;
            touchActivity({
              task_token: taskToken,
              stage: 'running',
              message: '已收到回答，Agent 正在继续执行',
              source: 'pi.user-question.settled',
              visible: true,
              activity: true,
            });
          }
          emitQuestion(null);
          resolve(resolution);
        },
        reject: (error) => {
          answered = true;
          signal?.removeEventListener?.('abort', onAbort);
          pendingQuestions.delete(questionId);
          if (activeTask?.activity_token === taskToken) {
            activeTask.waiting_for_user = false;
          }
          emitQuestion(null);
          reject(error);
        },
      });
      emitQuestion(pendingQuestion);
    });
  }

  function getPendingQuestion(): AgentPendingQuestion | null {
    for (const entry of pendingQuestions.values()) {
      return entry.question;
    }
    return null;
  }

  async function answerQuestion(payload: AgentQuestionAnswer): Promise<{ answered: boolean }> {
    const entry = payload?.question_id ? pendingQuestions.get(payload.question_id) : null;
    if (!entry) {
      return { answered: false };
    }
    entry.resolve({ option_id: payload.option_id, custom_answer: payload.custom_answer, answer_payload: payload.answer_payload });
    return { answered: true };
  }

  async function requestQuestion(payload: AgentQuestionRequest): Promise<AgentQuestionResolution> {
    const question = String(payload?.question || '').trim();
    if (!question) throw new Error('Agent 提问内容不能为空');
    const rawOptions = Array.isArray(payload?.options) ? payload.options : [];
    const options: AgentQuestionOption[] = rawOptions
      .map((option, index) => ({
        id: String(option?.id || `option-${index}`).trim() || `option-${index}`,
        label: String(option?.label || '').trim(),
        description: option?.description ? String(option.description) : undefined,
        recommended: option?.recommended === true || index === 0,
        custom: option?.custom === true,
      }))
      .filter((option) => option.label);
    if (!options.length) throw new Error('Agent 提问至少需要一个可选项');
    const questionId = crypto.randomUUID();
    const pendingQuestion: AgentPendingQuestion = {
      question_id: questionId,
      task_id: String(payload?.task_id || `server-question-${questionId}`).trim(),
      task_title: payload?.task_title ? String(payload.task_title) : '需要确认后继续',
      project_id: typeof payload?.project_id === 'number' ? payload.project_id : undefined,
      question,
      options,
      metadata: payload?.metadata,
      asked_at: nowIso(),
    };
    return new Promise<AgentQuestionResolution>((resolve, reject) => {
      pendingQuestions.set(questionId, {
        question: pendingQuestion,
        options,
        resolve: (resolution) => {
          pendingQuestions.delete(questionId);
          emitQuestion(null);
          resolve({ option_id: resolution.option_id, custom_answer: resolution.custom_answer, answer_payload: resolution.answer_payload });
        },
        reject: (error) => {
          pendingQuestions.delete(questionId);
          emitQuestion(null);
          reject(error);
        },
      });
      emitQuestion(pendingQuestion);
    });
  }

  function onQuestion(listener: AgentQuestionListener): () => void {
    if (typeof listener !== 'function') return () => {};
    questionListeners.add(listener);
    return () => {
      questionListeners.delete(listener);
    };
  }

  function abortPendingQuestions(reason: string): void {
    for (const entry of pendingQuestions.values()) {
      try {
        entry.reject(new Error(reason));
      } catch {
        /* ignore */
      }
    }
    pendingQuestions.clear();
  }

  function prepareStagingWorkspace(workspaceDir: string, payload: AgentRunTaskPayload): void {
    clearDirectoryContents(workspaceDir);
    writeWorkspaceFiles(workspaceDir, payload.files || []);
  }

  function cleanupStagingWorkspace(workspaceDir: string): void {
    clearDirectoryContents(workspaceDir);
  }

  function archiveTaskWorkspace(taskId: string): string {
    const layout = ensureEnvironment().layout;
    const taskDir = path.join(layout.tasksRoot, safeTaskPathSegment(taskId));
    const archiveWorkspaceDir = path.join(taskDir, 'workspace');
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.cpSync(activeTask?.workspace_dir || layout.workspaceDir, archiveWorkspaceDir, { recursive: true });
    return archiveWorkspaceDir;
  }

  function writeTaskDiagnostics(taskId: string, payload: Record<string, unknown> = {}): void {
    try {
      const layout = ensureEnvironment().layout;
      const taskDir = path.join(layout.tasksRoot, safeTaskPathSegment(taskId));
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'diagnostics.json'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      /* 诊断落盘失败不应影响任务结果 */
    }
  }

  function writeTaskResult(taskId: string, payload: Record<string, unknown> = {}): void {
    try {
      const layout = ensureEnvironment().layout;
      const taskDir = path.join(layout.tasksRoot, safeTaskPathSegment(taskId));
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'result.json'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      /* 结果落盘失败不影响已返回的任务结果 */
    }
  }

  function collectDiagnostics(input: { taskId: string; title: string; outputFile: string; session?: PiSessionRuntime | null; sessionSnapshot?: PiSessionSnapshot | null; diffEntries: Array<Record<string, unknown>>; startedAt: string }): Record<string, unknown> {
    let output = { path: '', content: '' };
    try {
      output = readOutputContent(activeTask?.workspace_dir || ensureEnvironment().layout.workspaceDir, input.outputFile);
    } catch {
      /* ignore */
    }
    return {
      taskId: input.taskId,
      title: input.title,
      workspaceDir: activeTask?.workspace_dir || ensureEnvironment().layout.workspaceDir,
      runtimeRoot: ensureEnvironment().layout.runtimeRoot,
      outputFile: input.outputFile,
      outputPath: output.path,
      outputContent: output.content,
      sessionId: input.session?.sessionId || '',
      sessionSnapshot: input.sessionSnapshot || null,
      sessionMessages: Array.isArray(input.session?.messages) ? [...(input.session!.messages as Array<Record<string, unknown>>)] : [],
      diff: [...input.diffEntries],
      status: getStatus(),
      events: diagnostics.events.filter((event) => String(event.at || '') >= input.startedAt),
    };
  }

  interface RetryRunResult {
    session: PiSessionRuntime;
    sessionSnapshot: PiSessionSnapshot;
    text: string;
    diff: Array<Record<string, unknown>>;
    output: { path: string; content: string };
    validation_result: unknown;
    retry_count: number;
    retry_attempts: AgentRetryAttempt[];
  }

  interface PersistentTaskRuntime {
    taskKey: string;
    mode: 'create' | 'resume';
    paths: PersistentAgentTaskPaths;
    state: PersistentAgentTaskState;
    sessionFile?: string;
  }

  function initPersistentTaskRuntime(payload: AgentRunTaskPayload): PersistentTaskRuntime | null {
    const spec = payload.persistent_task;
    if (!spec?.task_key) return null;
    if (spec.mode === 'resume') {
      const current = loadPersistentAgentTask(spec.task_key, getDataDir());
      if (!current) throw new Error('目录 Agent 持久任务不存在，请重新生成目录');
      const sessionFile = String(spec.session_file || current.state.session_file || '').trim() || undefined;
      const state = updatePersistentAgentTask(spec.task_key, {
        ...spec.state,
        status: 'running',
        stage: spec.initial_stage || current.state.stage || 'resume',
        output_file: payload.output_file || 'agent-result.md',
      }, getDataDir()).state;
      return {
        taskKey: spec.task_key,
        mode: 'resume',
        paths: current.paths,
        state,
        sessionFile,
      };
    }
    const created = createPersistentAgentTask(spec.task_key, {
      ...spec.state,
      status: 'running',
      stage: spec.initial_stage || 'created',
      output_file: payload.output_file || 'agent-result.md',
    }, getDataDir());
    return {
      taskKey: spec.task_key,
      mode: 'create',
      paths: created.paths,
      state: created.state,
      sessionFile: spec.session_file,
    };
  }

  function prepareTaskWorkspace(workspaceDir: string, payload: AgentRunTaskPayload, persistentTask: PersistentTaskRuntime | null): void {
    if (!persistentTask || persistentTask.mode === 'create') {
      prepareStagingWorkspace(workspaceDir, payload);
      return;
    }
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeWorkspaceFiles(workspaceDir, payload.files || []);
  }

  // 单 session 跨 attempt 重试；M1 V1 单阶段（无 continueTask 工作流循环）。
  async function runPiTaskWithRetry(input: {
    workspaceDir: string;
    title: string;
    prompt: string;
    outputFile: string;
    signal: AbortSignal;
    taskActivity: (event: AgentActivityEvent) => void;
    validateOutput: AgentRunTaskPayload['validateOutput'];
    maxRetries: number;
    retryAttempts: AgentRetryAttempt[];
    jsonValidationSchemas?: Record<string, object>;
    sessionsDir?: string;
    sessionFile?: string;
    onSessionCreated: (session: PiSessionRuntime, snapshot: PiSessionSnapshot) => void;
  }): Promise<RetryRunResult> {
    const config = (loadConfig() || {}) as { context_length_limit?: number | string };
    const created = await createPiSession({
      workspaceDir: input.workspaceDir,
      environment: ensureEnvironment(),
      proxyInfo: proxyInfo as PiProxyInfo,
      config,
      timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      jsonValidationSchemas: input.jsonValidationSchemas,
      sessionsDir: input.sessionsDir,
      sessionFile: input.sessionFile,
      requestUserQuestion,
    });
    const session = created.session as unknown as PiSessionRuntime;
    input.onSessionCreated(session, created.snapshot);
    const diffEntries: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeSession(session, activeTask?.activity_token || '', diffEntries);
    let nextPrompt = input.prompt;
    let assistantText = '';
    let validationResult: unknown = null;

    try {
      for (let attemptIndex = 0; attemptIndex <= input.maxRetries; attemptIndex += 1) {
        const attempt = attemptIndex + 1;
        try {
          if (input.signal.aborted) throw input.signal.reason as Error;
          await session.prompt(nextPrompt, { expandPromptTemplates: false });
          if (input.signal.aborted) throw input.signal.reason as Error;
          const messages = (session.messages || []) as Array<Record<string, unknown>>;
          const assistantError = getAssistantError(messages);
          if (assistantError) {
            const error = new Error(assistantError) as Error & { piAssistantError?: unknown };
            error.piAssistantError = getAssistantErrorDetails(messages);
            throw error;
          }
          assistantText = extractAssistantText(messages);
          const output = readOutputContent(input.workspaceDir, input.outputFile);
          const candidate: AgentValidationCandidate = {
            output_content: output.content,
            assistant_text: assistantText,
          };
          if (typeof input.validateOutput === 'function') {
            const validationContext: AgentValidationContext = {
              attempt,
              max_retries: input.maxRetries,
              task_id: activeTask?.task_id || '',
              title: input.title,
              output_file: input.outputFile,
              workspace_dir: input.workspaceDir,
              session_id: session.sessionId || '',
              retry_attempts: [...input.retryAttempts],
            };
            try {
              validationResult = await input.validateOutput(candidate, validationContext);
            } catch (validationError) {
              throw markAgentValidationError(validationError);
            }
          }
          return {
            session,
            sessionSnapshot: created.snapshot,
            text: assistantText,
            diff: diffEntries,
            output,
            validation_result: validationResult,
            retry_count: input.retryAttempts.length,
            retry_attempts: [...input.retryAttempts],
          };
        } catch (error) {
          if (isUserCancelOrPause(error) || input.signal?.aborted || attemptIndex >= input.maxRetries) {
            if (error && typeof error === 'object') {
              (error as Record<string, unknown>).agentRetryAttempts = [...input.retryAttempts];
            }
            throw error;
          }
          let output = { content: '' };
          try {
            output = readOutputContent(input.workspaceDir, input.outputFile);
          } catch {
            /* ignore */
          }
          input.retryAttempts.push(createRetryAttemptSummary({ attempt, error, outputContent: output.content }));
          const retryAttempt = input.retryAttempts.length;
          input.taskActivity({
            stage: 'retry',
            message: `Pi Agent 执行未通过，正在同一会话自动修复 ${retryAttempt}/${input.maxRetries}：${compactErrorText(error, 160)}`,
            source: 'runtime.retry',
            activity: true,
            meta: {
              attempt,
              retry_attempt: retryAttempt,
              max_retries: input.maxRetries,
              validation_failed: Boolean((error as { agentValidationFailed?: boolean })?.agentValidationFailed),
            },
          });
          nextPrompt = buildAgentRetryPrompt({ outputFile: input.outputFile, attempt: retryAttempt, maxRetries: input.maxRetries, error });
        }
      }
      throw new Error('Pi Agent 自动修复流程异常结束');
    } finally {
      unsubscribe();
    }
  }

  async function runTaskNow(payload: AgentRunTaskPayload): Promise<AgentRunTaskSuccessResult> {
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const timeoutMs = normalizeTimeoutMs(payload.timeout_ms, DEFAULT_AGENT_IDLE_TIMEOUT_MS);
    const maxRetries = normalizeMaxRetries(payload.max_retries);
    const retryAttempts: AgentRetryAttempt[] = [];
    const startedAt = nowIso();
    const layout = ensureEnvironment().layout;
    const persistentTask = initPersistentTaskRuntime(payload);
    const workspaceDir = persistentTask?.paths.workspaceDir || layout.workspaceDir;

    activeTask = createActiveTask({ taskId, title, timeoutMs, workspaceDir, projectId: payload.project_id, onActivity: payload.onActivity });
    const taskActivity = createTaskActivity(activeTask);
    setPhase('running', '等待 Pi Agent 返回真实进度');
    emitStatus();

    const controller = new AbortController();
    activeTaskAbortController = controller;
    let sessionRef: PiSessionRuntime | null = null;
    let sessionSnapshotRef: PiSessionSnapshot | null = null;
    const diffEntries: Array<Record<string, unknown>> = [];
    const stopParentAbort = bindParentSignal(payload.signal, controller, () => sessionRef);
    const stopWatchdog = startActivityWatchdog({
      timeoutMs,
      taskToken: activeTask.activity_token,
      abort: (error) => {
        if (!controller.signal.aborted) controller.abort(error);
      },
    });
    let stopOutputWatcher: (() => void) | null = null;
    let mustRestartAfterTask = false;

    try {
      await ensureStarted();
      if (controller.signal.aborted) throw controller.signal.reason as Error;

      taskActivity({ stage: 'workspace', message: '', source: 'runtime', visible: false, activity: false });
      prepareTaskWorkspace(workspaceDir, payload, persistentTask);
      stopOutputWatcher = startOutputWatcher(outputFile, taskActivity);

      const result = await runPiTaskWithRetry({
        workspaceDir,
        title,
        prompt: payload.prompt || createDefaultAgentPrompt({ task: payload.task || '请分析当前输入文件，并输出可执行结果。', outputFile }),
        outputFile,
        signal: activeTaskAbortController.signal,
        taskActivity,
        validateOutput: payload.validateOutput,
        maxRetries,
        retryAttempts,
        jsonValidationSchemas: payload.json_validation_schemas,
        sessionsDir: persistentTask?.paths.sessionsDir,
        sessionFile: persistentTask?.sessionFile,
        onSessionCreated: (session, snapshot) => {
          sessionRef = session;
          sessionSnapshotRef = snapshot;
          if (persistentTask && (session.sessionFile || snapshot)) {
            updatePersistentAgentTask(persistentTask.taskKey, {
              status: 'running',
              session_file: session.sessionFile,
              task_id: taskId,
              title,
              output_file: outputFile,
              stage: payload.persistent_task?.initial_stage || persistentTask.state.stage || 'running',
            }, getDataDir());
          }
        },
      });
      sessionRef = result.session;
      sessionSnapshotRef = result.sessionSnapshot;

      taskActivity({ stage: 'output', message: '', source: 'runtime', visible: false, activity: false });
      const output = result.output || readOutputContent(workspaceDir, outputFile);

      taskActivity({ stage: 'archive', message: '', source: 'runtime', visible: false, activity: false });
      const archivedWorkspaceDir = archiveTaskWorkspace(taskId);
      const diagnosticsPayload = collectDiagnostics({ taskId, title, outputFile, session: result.session, sessionSnapshot: result.sessionSnapshot, diffEntries, startedAt });
      diagnosticsPayload.workspaceDir = archivedWorkspaceDir;
      diagnosticsPayload.retryAttempts = [...retryAttempts];
      writeTaskDiagnostics(taskId, diagnosticsPayload);

      const taskResult: AgentRunTaskSuccessResult = {
        success: true,
        task_id: taskId,
        title,
        workspace_dir: archivedWorkspaceDir,
        runtime_workspace_dir: workspaceDir,
        runtime_root: layout.runtimeRoot,
        output_file: outputFile,
        output_content: output.content,
        assistant_text: result.text,
        diff: result.diff,
        session_id: result.session.sessionId || '',
        retry_count: result.retry_count || 0,
        retry_attempts: result.retry_attempts || [],
        validation_result: result.validation_result,
      };
      writeTaskResult(taskId, taskResult as unknown as Record<string, unknown>);
      if (persistentTask) {
        updatePersistentAgentTask(persistentTask.taskKey, {
          status: 'success',
          session_file: result.session.sessionFile,
          task_id: taskId,
          title,
          output_file: outputFile,
          result_file: persistentTask.paths.resultFile,
          last_result: {
            output_file: outputFile,
            output_content_chars: output.content.length,
            session_id: result.session.sessionId || '',
          },
        }, getDataDir());
        fs.writeFileSync(persistentTask.paths.resultFile, JSON.stringify(taskResult, null, 2), 'utf-8');
      }
      return taskResult;
    } catch (error) {
      if (persistentTask) {
        try {
          updatePersistentAgentTask(persistentTask.taskKey, {
            status: 'error',
            error: compactErrorText(error),
            task_id: taskId,
            title,
            output_file: outputFile,
            session_file: sessionRef?.sessionFile || persistentTask.sessionFile,
          }, getDataDir());
        } catch {
          /* 持久任务状态写入失败不覆盖原始错误 */
        }
      }
      if (isUserCancelOrPause(error)) {
        mustRestartAfterTask = true;
      }
      if (isWatchdogStall(error)) {
        mustRestartAfterTask = true;
      }
      const diagnosticsPayload = collectDiagnostics({ taskId, title, outputFile, session: sessionRef, sessionSnapshot: sessionSnapshotRef, diffEntries, startedAt });
      if (error && typeof error === 'object') {
        (error as Record<string, unknown>).agentRetryAttempts = Array.isArray((error as { agentRetryAttempts?: unknown[] }).agentRetryAttempts)
          ? (error as { agentRetryAttempts: AgentRetryAttempt[] }).agentRetryAttempts
          : [...retryAttempts];
      }
      diagnosticsPayload.retryAttempts = Array.isArray((error as { agentRetryAttempts?: AgentRetryAttempt[] })?.agentRetryAttempts)
        ? (error as { agentRetryAttempts: AgentRetryAttempt[] }).agentRetryAttempts
        : [...retryAttempts];
      diagnosticsPayload.validationFailed = Boolean((error as { agentValidationFailed?: boolean })?.agentValidationFailed);
      try {
        const archivedWorkspaceDir = archiveTaskWorkspace(taskId);
        diagnosticsPayload.workspaceDir = archivedWorkspaceDir;
      } catch (archiveError) {
        diagnosticsPayload.archiveError = (archiveError as Error)?.message || String(archiveError || '归档失败');
      }
      writeTaskDiagnostics(taskId, diagnosticsPayload);
      throw annotateAgentError(error, diagnosticsPayload as unknown as Record<string, unknown>);
    } finally {
      try {
        sessionRef?.dispose?.();
      } catch {
        /* ignore */
      }
      stopOutputWatcher?.();
      stopWatchdog();
      stopParentAbort();
      abortPendingQuestions('Agent 任务已结束');
      const shouldRestart = mustRestartAfterTask || phase === 'unhealthy';
      activeTask = null;
      activeTaskAbortController = null;
      sessionRef = null;
      sessionSnapshotRef = null;
      try {
        if (!persistentTask) cleanupStagingWorkspace(workspaceDir);
      } catch (error) {
        lastHealthError = (error as Error)?.message || String(error);
      }
      if (phase !== 'closing' && phase !== 'stopped') {
        if (shouldRestart) {
          await restart('task aborted or stalled').catch((restartError) => {
            lastHealthError = (restartError as Error)?.message || String(restartError || 'Pi Agent 服务重启失败');
            setPhase('unhealthy', 'Pi Agent 服务重启失败');
          });
        } else if (restartPending) {
          await restart('config changed').catch((restartError) => {
            lastHealthError = (restartError as Error)?.message || String(restartError || 'Pi Agent 服务重启失败');
            setPhase('unhealthy', 'Pi Agent 服务重启失败');
          });
        } else {
          setPhase(proxyInfo ? 'idle' : 'unhealthy', proxyInfo ? 'Pi Agent 服务空闲' : 'Pi Agent 服务异常');
        }
      }
      emitStatus();
    }
  }

  async function runTask(payload: AgentRunTaskPayload): Promise<AgentRunTaskResult> {
    if (phase === 'closing' || closePromise) {
      throw new Error('Agent 服务正在关闭，无法执行任务');
    }
    if (payload.signal?.aborted) {
      throw createAbortReason(payload.signal);
    }
    if (activeTask) {
      return createBusyResult();
    }
    return runTaskNow(payload);
  }

  async function warmup(): Promise<void> {
    try {
      await ensureStarted();
    } catch (error) {
      lastHealthError = (error as Error)?.message || String(error || 'Pi Agent 服务启动失败');
      setPhase('unhealthy', 'Pi Agent 服务启动失败');
      throw error;
    }
  }

  async function boot(): Promise<void> {
    try {
      await ensureStarted();
    } catch {
      /* setPhase 已在 ensureStarted catch 里标 unhealthy */
    }
  }

  async function restart(reason = 'manual'): Promise<void> {
    if (activeTask) {
      restartPending = true;
      restartPendingReason = reason;
      emitStatusThrottled();
      return;
    }
    restartPending = false;
    restartPendingReason = '';
    stopIdleHealthTimer();
    setPhase('restarting', '正在重启 Pi Agent 服务');
    try {
      await proxy?.close?.();
    } catch {
      /* ignore */
    }
    proxy = null;
    proxyInfo = null;
    try {
      cleanupStagingWorkspace(ensureEnvironment().layout.workspaceDir);
    } catch {
      /* ignore */
    }
    await ensureStarted();
  }

  function markRestartPending(reason?: string): void {
    restartPending = true;
    restartPendingReason = reason || 'config changed';
    emitStatusThrottled();
    if (!activeTask && phase === 'idle') {
      void restart(restartPendingReason).catch((error) => {
        lastHealthError = (error as Error)?.message || String(error || 'Pi Agent 服务重启失败');
        setPhase('unhealthy', 'Pi Agent 服务重启失败');
      });
    }
  }

  function handleConfigChanged(nextConfig: Record<string, unknown> = {}, previousConfig: Record<string, unknown> = {}): void {
    // pi 的 context_length_limit 写入 SessionFactory 的 model contextWindow/maxTokens，
    // 故 limit 变更需重启（重建 proxy 后下次 createPiSession 读新值）；key/model/base_url 由 proxy 每请求 live 直读免重启。
    if (Number(nextConfig.context_length_limit || 0) !== Number(previousConfig.context_length_limit || 0)) {
      markRestartPending('context_length_limit changed');
    }
  }

  // ---- 自检 ----

  function mapStepStatus(internal: SelfCheckStepInternal): AgentSelfCheckStep['status'] {
    switch (internal.status) {
      case 'success':
        return 'pass';
      case 'error':
        return 'fail';
      case 'running':
      case 'warning':
        return 'warn';
      case 'skipped':
        return 'skip';
      default:
        return 'skip';
    }
  }

  function mapSteps(internal: SelfCheckStepInternal[]): AgentSelfCheckStep[] {
    return internal.map((step) => ({
      id: step.id,
      label: step.label,
      status: mapStepStatus(step),
      message: step.message || undefined,
      detail: step.detail,
    }));
  }

  // 极简 Pi Agent 任务自检：read 输入 → bash node → write JSON → json-validation。
  async function runAgentLinkSelfCheck(): Promise<{
    success: boolean;
    taskCompleted: boolean;
    message: string;
    session_id: string;
    workspace_dir: string;
    output_content: string;
    output_valid: boolean;
    output_message: string;
    parsed_output: Record<string, unknown> | null;
    validation_tool_succeeded: boolean;
    session_snapshot: PiSessionSnapshot | Record<string, never>;
    snapshot_validation: { resourcesValid: boolean; toolsValid: boolean };
    retry_count: number;
    retry_attempts: AgentRetryAttempt[];
    error: Record<string, unknown> | null;
  }> {
    try {
      const result = await runTask({
        task_id: `${SELF_CHECK_TASK_ID}-latest`,
        title: 'Pi Agent 自检',
        output_file: SELF_CHECK_OUTPUT_FILE,
        files: [{ path: 'self-check-input.txt', content: SELF_CHECK_INPUT }],
        prompt: `请完成以下自检：
1. 使用 read 工具读取 self-check-input.txt。
2. 使用 bash 工具执行 node -e "console.log('${SELF_CHECK_NODE_MARKER}')"。
3. 使用 write 工具将 JSON 写入 ${SELF_CHECK_OUTPUT_FILE}，格式为 {"message":"${SELF_CHECK_OK_MESSAGE}","input":"${SELF_CHECK_INPUT}","node":"${SELF_CHECK_NODE_MARKER}"}。
4. 使用 json-validation 工具校验 ${SELF_CHECK_OUTPUT_FILE}。程序已预置 Schema，只传 file_path，不要传入 schema。
5. 不要访问当前工作区以外的文件。`,
        json_validation_schemas: { [SELF_CHECK_OUTPUT_FILE]: SELF_CHECK_OUTPUT_SCHEMA },
        timeout_ms: SELF_CHECK_TIMEOUT_MS,
        max_retries: 0,
      });
      if (!('success' in result) || !result.success) {
        return {
          success: false,
          taskCompleted: false,
          message: 'Pi Agent 自检任务被占用，已跳过',
          session_id: '',
          workspace_dir: ensureEnvironment().layout.workspaceDir,
          output_content: '',
          output_valid: false,
          output_message: '智能体任务被占用',
          parsed_output: null,
          validation_tool_succeeded: false,
          session_snapshot: {},
          snapshot_validation: validatePiSessionSnapshot({}),
          retry_count: 0,
          retry_attempts: [],
          error: null,
        };
      }
      const diagnosticsPath = path.join(ensureEnvironment().layout.tasksRoot, safeTaskPathSegment(result.task_id), 'diagnostics.json');
      let sessionSnapshot: PiSessionSnapshot | Record<string, never> = {};
      let events: Array<Record<string, unknown>> = [];
      try {
        const diagnosticsFile = JSON.parse(fs.readFileSync(diagnosticsPath, 'utf-8')) as Record<string, unknown>;
        sessionSnapshot = (diagnosticsFile.sessionSnapshot as PiSessionSnapshot) || {};
        events = Array.isArray(diagnosticsFile.events) ? (diagnosticsFile.events as Array<Record<string, unknown>>) : [];
      } catch {
        /* ignore */
      }
      const snapshotValidation = validatePiSessionSnapshot(sessionSnapshot);
      const validationToolSucceeded = events.some((event) => {
        const meta = event.meta as Record<string, unknown> | undefined;
        return event.source === 'pi.tool.end' && meta?.tool === 'json-validation' && meta?.is_error === false;
      });
      let parsed: Record<string, unknown> | null = null;
      let outputValid = false;
      let outputMessage = '';
      try {
        parsed = JSON.parse(result.output_content || '{}') as Record<string, unknown>;
        outputValid =
          parsed.message === SELF_CHECK_OK_MESSAGE &&
          parsed.input === SELF_CHECK_INPUT &&
          parsed.node === SELF_CHECK_NODE_MARKER;
        outputMessage = outputValid ? '输出内容符合预期' : 'Pi Agent 自检输出不符合预期';
      } catch (error) {
        outputMessage = `Pi Agent 自检输出不是合法 JSON：${(error as Error)?.message || String(error)}`;
      }
      const success = snapshotValidation.resourcesValid && snapshotValidation.toolsValid && validationToolSucceeded && outputValid;
      return {
        success,
        taskCompleted: true,
        message: success
          ? 'Pi Agent 极简任务执行成功'
          : !validationToolSucceeded
            ? 'Pi Agent 未成功执行 json-validation 工具'
            : outputMessage || 'Pi Agent 极简任务未通过校验',
        session_id: result.session_id || '',
        workspace_dir: result.workspace_dir || ensureEnvironment().layout.workspaceDir,
        output_content: result.output_content || '',
        output_valid: outputValid,
        output_message: outputMessage,
        parsed_output: parsed,
        validation_tool_succeeded: validationToolSucceeded,
        session_snapshot: sessionSnapshot,
        snapshot_validation: snapshotValidation,
        retry_count: result.retry_count || 0,
        retry_attempts: result.retry_attempts || [],
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        taskCompleted: false,
        message: (error as Error)?.message || 'Pi Agent 自检任务失败',
        session_id: '',
        workspace_dir: (error as { agentWorkspaceDir?: string })?.agentWorkspaceDir || ensureEnvironment().layout.workspaceDir,
        output_content: (error as { agentPartialOutput?: string })?.agentPartialOutput || '',
        output_valid: false,
        output_message: '智能体任务失败，未执行输出校验',
        parsed_output: null,
        validation_tool_succeeded: false,
        session_snapshot: {},
        snapshot_validation: validatePiSessionSnapshot({}),
        retry_count: (error as { agentRetryAttempts?: AgentRetryAttempt[] })?.agentRetryAttempts?.length || 0,
        retry_attempts: (error as { agentRetryAttempts?: AgentRetryAttempt[] })?.agentRetryAttempts || [],
        error: serializeDiagnosticError(error),
      };
    }
  }

  async function runSelfCheck(): Promise<AgentSelfCheckReport> {
    const startedAt = nowIso();

    if (activeTask) {
      return {
        started_at: startedAt,
        finished_at: nowIso(),
        overall: 'warn',
        steps: [
          {
            id: 'prepare',
            label: '自检准备',
            status: 'skip',
            message: 'Agent 正在执行任务，自检已跳过',
          },
        ],
        diagnostics: { reason: 'busy', runtime_status: getStatus() },
      };
    }

    const steps: SelfCheckStepInternal[] = createPiSelfCheckSteps().map((step) => ({
      id: step.id,
      label: step.label,
      status: 'pending',
      message: '',
    }));
    const setStep = (id: string, status: SelfCheckStepInternal['status'], msg: string, detail?: unknown) => {
      const step = steps.find((item) => item.id === id);
      if (!step) return;
      if (step.status === 'error' && status !== 'error') return;
      if (step.status === 'success' && status === 'running') return;
      step.status = status;
      step.message = msg || step.message;
      if (detail !== undefined) step.detail = detail;
    };

    let config: PiSelfCheckConfig = {};
    let environmentSnapshot: Record<string, unknown> | null = null;
    let modelCheck: unknown = null;
    let loopbackCheck: { success: boolean; message: string; error?: Record<string, unknown> | null } | null = null;
    let toolCheck: { success: boolean; summary: string } | null = null;
    let agentCheck: Awaited<ReturnType<typeof runAgentLinkSelfCheck>> | null = null;
    let runtimeStarted = false;
    let topLevelError: unknown = null;

    try {
      setStep('environment', 'running', '正在采集应用、系统、代理和模型配置');
      try {
        config = (loadConfig() || {}) as PiSelfCheckConfig;
        environmentSnapshot = createPiEnvironmentSnapshot(ensureEnvironment().layout, config);
        setStep('environment', 'success', '环境快照已采集', environmentSnapshot);
      } catch (error) {
        topLevelError = error;
        setStep('environment', 'error', (error as Error)?.message || String(error));
      }

      setStep('sdk', 'running', '正在加载 Pi SDK');
      try {
        const { codingAgent } = await loadPiModules();
        sdkVersion = sdkVersion || codingAgent.VERSION || '';
        setStep('sdk', 'success', sdkVersion ? `Pi SDK ${sdkVersion}` : 'Pi SDK 已加载', { version: sdkVersion });
      } catch (error) {
        topLevelError = error;
        setStep('sdk', 'error', (error as Error)?.message || String(error));
      }

      setStep('runtime', 'running', '正在启动 Pi Agent AI Proxy');
      try {
        await ensureStarted();
        runtimeStarted = true;
        setStep('runtime', 'success', `Proxy=${proxyInfo?.baseUrl || '-'}`, { proxy_base_url: proxyInfo?.baseUrl || '' });
      } catch (error) {
        topLevelError = topLevelError || error;
        setStep('runtime', 'error', (error as Error)?.message || String(error));
      }

      setStep('tools', 'running', '正在检查共享命令环境');
      try {
        toolCheck = runPiToolEnvironmentSelfCheck(ensureEnvironment());
        setStep('tools', toolCheck.success ? 'success' : 'error', toolCheck.summary);
      } catch (error) {
        topLevelError = topLevelError || error;
        toolCheck = { success: false, summary: (error as Error)?.message || String(error) };
        setStep('tools', 'error', toolCheck.summary);
      }

      try {
        modelCheck = await runPiTextModelSelfCheck(config, (probeId, status, probe) => {
          const detail = probe as { label?: string; message?: string; duration_ms?: number; status?: number };
          const stepId = `model-${probeId}`;
          const message =
            status === 'running'
              ? `正在执行${detail.label || '文本模型检测'}`
              : `${detail.message || ''}，${detail.duration_ms || 0} ms${detail.status ? `，HTTP ${detail.status}` : ''}`;
          setStep(stepId, status === 'success' ? 'success' : status === 'running' ? 'running' : 'error', message);
        });
      } catch (error) {
        modelCheck = { success: false, error: serializeDiagnosticError(error) };
        setStep('model-normal', 'error', (error as Error)?.message || String(error));
        setStep('model-stream', 'error', (error as Error)?.message || String(error));
        setStep('model-tools', 'error', (error as Error)?.message || String(error));
      }

      if (runtimeStarted && proxyInfo) {
        setStep('loopback', 'running', '正在检测 TCP、原生 HTTP、全局 fetch 和认证模型路由');
        try {
          loopbackCheck = await runPiLoopbackSelfCheck(proxyInfo);
          setStep('loopback', loopbackCheck.success ? 'success' : 'error', String(loopbackCheck.message || ''));
        } catch (error) {
          loopbackCheck = { success: false, message: (error as Error)?.message || String(error), error: serializeDiagnosticError(error) };
          setStep('loopback', 'error', String(loopbackCheck.message));
        }
      } else {
        loopbackCheck = { success: false, message: 'Pi Runtime 未启动，无法执行 loopback 检测' };
        setStep('loopback', 'skipped', String(loopbackCheck.message));
      }

      if (runtimeStarted) {
        setStep('agent', 'running', '正在执行 Pi Agent 极简自检任务');
        try {
          agentCheck = await runAgentLinkSelfCheck();
          setStep('agent', agentCheck.success ? 'success' : 'error', `${agentCheck.message}${agentCheck.session_id ? `，session_id=${agentCheck.session_id}` : ''}`);
        } catch (error) {
          agentCheck = null;
          setStep('agent', 'error', (error as Error)?.message || String(error));
        }
      } else {
        setStep('agent', 'skipped', 'Pi Runtime 未启动，智能体任务未执行');
      }

      const sessionSnapshot = agentCheck?.session_snapshot || {};
      const snapshotValidation = agentCheck?.snapshot_validation || validatePiSessionSnapshot(sessionSnapshot);
      if (Object.keys(sessionSnapshot).length) {
        setStep(
          'resources',
          snapshotValidation.resourcesValid ? 'success' : 'error',
          snapshotValidation.resourcesValid ? '仅加载易标内置工作区指令' : 'Pi 资源加载结果不符合配置',
          snapshotValidation,
        );
      } else {
        setStep('resources', 'skipped', 'Session 未创建，无法校验资源加载');
      }
      if (agentCheck?.output_valid) {
        setStep('output', 'success', agentCheck.output_message);
      } else {
        setStep('output', agentCheck?.taskCompleted ? 'error' : 'skipped', agentCheck?.output_message || '智能体任务失败，未执行输出校验');
      }

      const initialSuccess = Boolean(
        runtimeStarted && toolCheck?.success && loopbackCheck?.success && agentCheck?.success,
      );
      setStep('diagnosis', 'skipped', initialSuccess ? 'Pi Agent 端到端链路正常' : 'M1 暂不执行 LLM 自动诊断，请参考失败步骤排查');
      setStep('repair', 'skipped', 'M1 跳过安全自动修复');
      setStep('recheck', 'skipped', 'M1 跳过修复后复检');

      return {
        started_at: startedAt,
        finished_at: nowIso(),
        overall: initialSuccess ? 'pass' : 'fail',
        steps: mapSteps(steps),
        diagnostics: {
          sdk_version: sdkVersion,
          model_config: summarizeTextModelConfig(config),
          environment: environmentSnapshot,
          model_check: modelCheck,
          loopback_check: loopbackCheck,
          tool_check: toolCheck,
          agent_check: agentCheck,
          session_snapshot: sessionSnapshot,
          snapshot_validation: snapshotValidation,
          runtime_status: getStatus(),
          error: initialSuccess ? null : agentCheck?.error || serializeDiagnosticError(topLevelError),
        },
      };
    } catch (error) {
      topLevelError = error;
      const current = steps.find((step) => step.status === 'running');
      if (current) setStep(current.id, 'error', (error as Error)?.message || String(error));
      steps.filter((step) => step.status === 'pending').forEach((step) => setStep(step.id, 'skipped', '因前置条件不足未执行'));
      return {
        started_at: startedAt,
        finished_at: nowIso(),
        overall: 'fail',
        steps: mapSteps(steps),
        diagnostics: {
          sdk_version: sdkVersion,
          model_config: summarizeTextModelConfig(config),
          environment: environmentSnapshot,
          model_check: modelCheck,
          loopback_check: loopbackCheck,
          tool_check: toolCheck,
          agent_check: agentCheck,
          error: serializeDiagnosticError(error),
          runtime_status: getStatus(),
        },
      };
    }
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      setPhase('closing', '正在关闭 Pi Agent 服务');
      stopIdleHealthTimer();
      stopStatusTimer();
      if (emitStatusTimer) {
        clearTimeout(emitStatusTimer);
        emitStatusTimer = null;
      }
      abortPendingQuestions('Agent 服务正在关闭');
      if (activeTaskAbortController && !activeTaskAbortController.signal.aborted) {
        const error = new Error('Agent 服务正在关闭');
        (error as { code?: string }).code = 'AGENT_DISCONNECTED';
        activeTaskAbortController.abort(error);
      }
      if (startPromise) {
        await startPromise.catch(() => undefined);
      }
      activeTask = null;
      activeTaskAbortController = null;
      try {
        await proxy?.close?.();
      } catch {
        /* ignore */
      }
      proxy = null;
      proxyInfo = null;
      setPhase('stopped', 'Pi Agent 服务已停止');
      emitStatus();
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  }

  startStatusTimer();

  const service: AgentService = {
    warmup,
    boot,
    runTask,
    runSelfCheck,
    getStatus,
    restart,
    markRestartPending,
    handleConfigChanged,
    onStatus,
    close,
    getPendingQuestion,
    answerQuestion,
    requestQuestion,
    onQuestion,
  };
  return service;
}
