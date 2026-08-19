// OpenCode Agent 运行时编排器（移植自桌面 client/electron/services/opencode/opencodeRuntimeService.cjs）。
// 职责：进程级单例 sidecar 生命周期 + 单飞任务执行（runTask）+ 重试 + 活动看门狗 + 健康巡检 +
// opencode.db 事件轮询（活动进度回传）+ 自检。
//
// 与桌面差异（经设计确认）：
//  ① 不再 queue-and-wait：runner 契约已假定单飞，故 sidecar 被占用时 runTask 直接返回 busy 哨兵
//     （types.ts 的 AgentRunTaskBusyResult / isAgentBusyResult），让调用方降级，而非阻塞等待。
//  ② 去掉 trackAgentRuntime 出站埋点（自托管内网部署不应向第三方 analytics 上报）。
//  ③ app/configStore → dataDir + binPath + loadConfig（= getLiveAgentAiConfig，每请求 live 读）。
//  ④ better-sqlite3 改为启动时动态 import；装不上则事件轮询整块降级 no-op（不影响任务执行）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getAgentServiceDir,
  getAgentServiceWorkspaceDir,
  getAgentServiceHomeDir,
  getAgentTasksRoot,
  getAgentTaskDir,
  getDataDir,
} from '../document/paths';
import { startOpenCodeSidecar, closeOpenCodeSidecar, type OpenCodeSidecar, type OpenCodeSidecarExitInfo } from './serverRunner';
import { createSession, sendPrompt, getSessionDiff, extractTextFromPromptResult } from './httpClient';
import { writeOpenCodeAgentsFile } from './toolEnvironment';
import type { AgentAiConfig } from '../config/store';
import type {
  AgentActivityEvent,
  AgentActiveTaskInfo,
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
const OPENCODE_EVENT_POLL_INTERVAL_MS = 1000;
const OPENCODE_EVENT_BATCH_LIMIT = 120;
const BUSY_MESSAGE = 'Agent 正在处理其他任务，请耐心等待';
const DEFAULT_AGENT_MAX_RETRIES = 1;
const MAX_AGENT_MAX_RETRIES = 3;

const SELF_CHECK_TASK_ID = 'self-check';
const SELF_CHECK_OUTPUT_FILE = 'self-check-output.md';
const SELF_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const SELF_CHECK_OK_MARKER = 'YIBIAO_AGENT_SELF_CHECK_OK';

type InternalPhase = 'stopped' | 'starting' | 'idle' | 'running' | 'restarting' | 'unhealthy' | 'closing';

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
  status: 'pending' | 'running' | 'success' | 'error';
  message: string;
}

// opencode.db 的 part 行形状是动态的（tool/text/step-*），这里用宽类型承载，映射时再取字段。
type OpenCodePart = Record<string, any> | null;

// better-sqlite3 是 CommonJS 同步库；启动时动态 import，装不上则返回 null（事件轮询降级）。
type BetterSqlite3Class = new (filename: string, options?: Record<string, unknown>) => {
  prepare(sql: string): { all(...params: unknown[]): any[]; get(...params: unknown[]): any };
  close(): void;
};

let betterSqliteModule: { default?: BetterSqlite3Class } & Record<string, unknown> | null | undefined;
async function loadBetterSqlite(): Promise<BetterSqlite3Class | null> {
  if (betterSqliteModule === undefined) {
    try {
      betterSqliteModule = await import('better-sqlite3');
    } catch {
      betterSqliteModule = null;
    }
  }
  return (betterSqliteModule?.default as BetterSqlite3Class | undefined) || (betterSqliteModule as unknown as BetterSqlite3Class | null) || null;
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

function markAgentValidationError(error: unknown): unknown {
  if (error && typeof error === 'object') {
    (error as Record<string, unknown>).agentValidationFailed = true;
  }
  return error;
}

function compactErrorText(error: unknown, maxLength = 1200): string {
  const err = error as { message?: string; cause?: { message?: string; code?: string }; openCodeCause?: string } | null;
  const lines = [
    err?.message || String(error || '未知错误'),
    err?.cause?.message || err?.cause?.code || err?.openCodeCause || '',
  ].filter(Boolean);
  const text = lines.join('\n').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function buildAgentRetryPrompt(input: { outputFile: string; attempt: number; maxRetries: number; error: unknown }): string {
  return `上一轮 Agent 执行没有通过程序校验或执行过程中失败。

失败信息：
${compactErrorText(input.error)}

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

function safeRelativePath(value: unknown): string {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..')) {
    throw new Error(`非法文件路径：${value}`);
  }
  const lower = raw.toLowerCase();
  const reserved =
    lower === 'opencode.json' ||
    lower === 'opencode.jsonc' ||
    lower === 'agents.md' ||
    lower === 'claude.md' ||
    lower.startsWith('.opencode/') ||
    lower.startsWith('.config/opencode/') ||
    lower.startsWith('.claude/');
  if (reserved) {
    throw new Error(`OpenCode 保留路径或指令文件不允许作为任务输入：${value}`);
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
  return {
    path: outputPath,
    content: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '',
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
  err.openCodeRequestLog = Array.isArray(meta.requestLog) ? meta.requestLog : err.openCodeRequestLog || [];
  err.openCodeStderrTail = meta.stderrTail || err.openCodeStderrTail || '';
  err.openCodeStdoutTail = meta.stdoutTail || err.openCodeStdoutTail || '';
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

function createSelfCheckStageError(stage: string, message: string): Error {
  const error = new Error(message);
  (error as { selfCheckStage?: string }).selfCheckStage = stage;
  return error;
}

function parseJsonObject(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function compactActivityText(value: unknown, maxLength = 180): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function basenameFromAnyPath(value: unknown): string {
  const normalized = String(value || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function formatTodoDetail(input: Record<string, any> | null): string {
  const todos = Array.isArray(input?.todos) ? input.todos : [];
  const current =
    todos.find((item: any) => item?.status === 'in_progress') ||
    todos.find((item: any) => item?.status === 'pending') ||
    todos.find((item: any) => item?.status === 'completed') ||
    todos[0];
  return compactActivityText(current?.content || '', 120);
}

function formatToolDetail(tool: string, input: Record<string, any> | null): string {
  if (!input || typeof input !== 'object') return '';
  if (tool === 'read') return basenameFromAnyPath(input.filePath || input.path || input.file || '');
  if (tool === 'write') return basenameFromAnyPath(input.filePath || input.path || input.file || '');
  if (tool === 'edit' || tool === 'multiedit') return basenameFromAnyPath(input.filePath || input.path || input.file || '');
  if (tool === 'glob') return compactActivityText(input.pattern || input.path || '', 120);
  if (tool === 'grep') return compactActivityText(input.pattern || input.query || input.include || '', 120);
  if (tool === 'bash') return compactActivityText(input.description || input.command || '', 140);
  if (tool === 'todowrite') return formatTodoDetail(input);
  return compactActivityText(input.filePath || input.path || input.pattern || input.query || input.description || '', 120);
}

const TOOL_LABELS: Record<string, string> = {
  bash: '执行命令',
  edit: '编辑文件',
  glob: '查找文件',
  grep: '搜索内容',
  multiedit: '批量编辑文件',
  read: '读取文件',
  todowrite: '更新任务清单',
  write: '写入文件',
};

function formatToolActivity(part: OpenCodePart): string {
  const tool = String(part?.tool || '').trim();
  if (!tool) return '';
  const state = part?.state && typeof part.state === 'object' ? (part.state as Record<string, any>) : {};
  const status = String(state.status || '').trim();
  const input = state.input && typeof state.input === 'object' ? (state.input as Record<string, any>) : null;
  const label = TOOL_LABELS[tool] || `调用工具 ${tool}`;
  const detail = formatToolDetail(tool, input);
  const suffix = detail ? `：${detail}` : '';
  if (status === 'pending' && !detail) return '';
  if (status === 'completed') return `${label}完成${suffix}`;
  if (status === 'error') return `${label}失败${suffix}`;
  if (status === 'running' || status === 'pending') return `${label}中${suffix}`;
  return `${label}${suffix}`;
}

function formatOpenCodePartActivity(part: OpenCodePart): string {
  const type = String(part?.type || '').trim();
  if (type === 'tool') return formatToolActivity(part);
  if (type === 'text') return compactActivityText(part?.text || '', 200);
  return '';
}

function getOpenCodePartStage(part: OpenCodePart): string {
  const type = String(part?.type || '').trim();
  if (type === 'tool') return 'tool';
  if (type === 'text') return 'assistant_text';
  if (type === 'step-start') return 'step_start';
  if (type === 'step-finish') return 'step_finish';
  return 'opencode_event';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getMessageRole(db: any, cache: Map<string, string>, messageId: string): string {
  const id = String(messageId || '').trim();
  if (!id) return '';
  if (cache.has(id)) return cache.get(id) as string;
  let role = '';
  try {
    const row = db.prepare('SELECT data FROM message WHERE id = ?').get(id);
    const data = parseJsonObject(row?.data || '');
    role = String(data?.role || '').trim();
  } catch {
    role = '';
  }
  cache.set(id, role);
  return role;
}

function createRuntimeDiagnostics(limit = 500): RuntimeDiagnostics {
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

export interface CreateAgentServiceOptions {
  dataDir?: string;
  binPath?: string;
  loadConfig?: () => AgentAiConfig | null;
}

export function createOpenCodeRuntimeService(options: CreateAgentServiceOptions = {}): AgentService {
  const dataDir = options.dataDir || getDataDir();
  const binPath = options.binPath || process.env.YIBIAO_OPENCODE_BIN || '';
  const loadConfig = options.loadConfig || (() => null);

  const serviceRuntimeRoot = getAgentServiceDir(dataDir);
  const serviceWorkspaceDir = getAgentServiceWorkspaceDir(dataDir);
  const serviceHomeDir = getAgentServiceHomeDir(dataDir);
  const tasksRoot = getAgentTasksRoot(dataDir);
  const diagnostics = createRuntimeDiagnostics();
  const listeners = new Set<AgentStatusListener>();

  let phase: InternalPhase = 'stopped';
  let message = 'Agent 服务未启动';
  let updatedAt = nowIso();
  let lastHealthAt = '';
  let lastHealthError = '';
  let lastExitCode: number | null = null;
  let lastExitSignal = '';
  let restartPending = false;
  let restartPendingReason = '';
  let sidecar: OpenCodeSidecar | null = null;
  let databaseClass: BetterSqlite3Class | null = null;
  let startPromise: Promise<OpenCodeSidecar | null> | null = null;
  let closePromise: Promise<void> | null = null;
  let activeTask: ActiveTask | null = null;
  let activeTaskAbortController: AbortController | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let healthFailureCount = 0;
  let healthRestartAttempted = false;
  let emitStatusTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureRuntimeDirs(): void {
    fs.mkdirSync(serviceRuntimeRoot, { recursive: true });
    fs.mkdirSync(serviceWorkspaceDir, { recursive: true });
    fs.mkdirSync(tasksRoot, { recursive: true });
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
      proxy: sidecar?.getProxyStatus?.() || { active: 0, queued: 0, limit: 0 },
      sidecar: sidecar
        ? {
            pid: sidecar.pid || 0,
            port: sidecar.port || 0,
            base_url: sidecar.baseUrl || '',
            ai_proxy_base_url: sidecar.aiProxyBaseUrl || '',
            last_exit_code: lastExitCode,
            last_exit_signal: lastExitSignal,
          }
        : null,
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
            lastHealthError = error?.message || String(error || 'Agent 服务重启失败');
            setPhase('unhealthy', 'Agent 服务重启失败');
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
    if (event.activity === true) {
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
        activeTask.activity_handler({ ...event, at: now });
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

  function createActiveTask(input: { taskId: string; title: string; timeoutMs: number; onActivity?: AgentRunTaskPayload['onActivity'] }): ActiveTask {
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

  function createAbortReason(signal: AbortSignal | undefined, fallbackMessage = 'Agent 任务已取消'): Error {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    const error = new Error(reason ? String(reason) : fallbackMessage);
    if (reason && typeof reason === 'object' && (reason as { code?: string }).code) {
      (error as { code?: string }).code = (reason as { code?: string }).code;
    }
    return error;
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

  async function checkSidecarHealth(): Promise<void> {
    if (!sidecar) throw new Error('OpenCode sidecar 未启动');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Agent 服务健康检查超时')), 5000);
    try {
      const opencodeResponse = await fetch(`${sidecar.baseUrl}/global/health`, {
        headers: { Authorization: sidecar.authHeader },
        signal: controller.signal,
      });
      if (!opencodeResponse.ok) {
        throw new Error(`OpenCode health status ${opencodeResponse.status}`);
      }
      const proxyResponse = await fetch(`${sidecar.aiProxyBaseUrl}/health`, { signal: controller.signal });
      if (!proxyResponse.ok) {
        throw new Error(`Agent proxy health status ${proxyResponse.status}`);
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
      if (phase !== 'idle' || activeTask || !sidecar) return;
      void checkSidecarHealth()
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
                setPhase('unhealthy', 'Agent 服务异常');
              });
            }
          }
          emitStatusThrottled();
        });
    }, HEALTH_INTERVAL_MS);
    if (typeof healthTimer.unref === 'function') healthTimer.unref();
  }

  async function ensureStarted(): Promise<OpenCodeSidecar | null> {
    if (sidecar && phase !== 'unhealthy' && phase !== 'stopped' && phase !== 'closing') return sidecar;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      setPhase(phase === 'unhealthy' ? 'restarting' : 'starting', phase === 'unhealthy' ? '正在重启 Agent 服务' : '正在启动 Agent 服务');
      ensureRuntimeDirs();
      if (!binPath) {
        throw new Error('未配置 OpenCode 二进制路径（YIBIAO_OPENCODE_BIN）');
      }
      if (!loadConfig()) {
        throw new Error('Agent AI 配置缺失（平台文本模型未配置）');
      }
      // better-sqlite3 在此一次性动态加载；装不上 databaseClass=null，事件轮询降级（不阻塞启动）。
      databaseClass = await loadBetterSqlite();
      if (sidecar) {
        await closeOpenCodeSidecar(sidecar);
        sidecar = null;
      }
      sidecar = await startOpenCodeSidecar({
        binPath,
        loadConfig,
        runtimeRoot: serviceRuntimeRoot,
        workspaceDir: serviceWorkspaceDir,
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
        diagnostics,
        onStage: (event) => {
          if (!activeTask) {
            appendRuntimeEvent({
              at: nowIso(),
              source: 'opencode-start',
              stage: event.stage,
              message: event.message,
              meta: { ...(event.meta || {}), status: event.status },
              ignored: true,
              reason: 'no-active-task',
            });
            return;
          }
          touchActivity({
            task_token: activeTask.activity_token,
            task_id: activeTask.task_id,
            stage: event.stage,
            message: event.message,
            source: 'opencode-start',
            visible: false,
            activity: false,
            meta: { ...(event.meta || {}), status: event.status },
          });
        },
        onActivity: touchActivity,
        getActivityContext: () =>
          activeTask
            ? { task_token: activeTask.activity_token, task_id: activeTask.task_id }
            : null,
        onExit: (info: OpenCodeSidecarExitInfo) => handleOpenCodeExit(info),
      });
      if (phase === 'closing' || phase === 'stopped') {
        await closeOpenCodeSidecar(sidecar);
        sidecar = null;
        throw new Error('Agent 服务正在关闭');
      }
      healthFailureCount = 0;
      healthRestartAttempted = false;
      lastHealthAt = nowIso();
      lastHealthError = '';
      setPhase(activeTask ? 'running' : 'idle', activeTask ? '等待 Agent 返回真实进度' : 'Agent 服务空闲');
      startIdleHealthTimer();
      startStatusTimer();
      return sidecar;
    })();

    try {
      return await startPromise;
    } catch (error) {
      if (phase !== 'closing' && phase !== 'stopped') {
        setPhase('unhealthy', (error as Error)?.message || 'Agent 服务启动失败');
      }
      throw error;
    } finally {
      startPromise = null;
    }
  }

  function handleOpenCodeExit(info: OpenCodeSidecarExitInfo): void {
    lastExitCode = info.code ?? null;
    lastExitSignal = info.signal || '';
    appendRuntimeEvent({ at: nowIso(), source: 'opencode.exit', code: info.code, signal: info.signal });
    if (phase === 'closing' || phase === 'stopped') return;
    if (activeTaskAbortController && !activeTaskAbortController.signal.aborted) {
      activeTaskAbortController.abort(new Error('OpenCode Server 已退出'));
    }
    setPhase('unhealthy', 'Agent 服务异常退出');
  }

  function bindParentSignal(parentSignal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!parentSignal) return () => {};
    const abortFromParent = () => {
      if (!controller.signal.aborted) {
        controller.abort(parentSignal.reason || new Error('Agent 任务已取消'));
      }
    };
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    return () => {
      try {
        parentSignal.removeEventListener('abort', abortFromParent);
      } catch {
        /* ignore */
      }
    };
  }

  function startActivityWatchdog(input: {
    timeoutMs: number;
    abort: (error: Error) => void;
    taskActivity: (event: AgentActivityEvent) => void;
  }): () => void {
    const timer = setInterval(() => {
      if (!activeTask) return;
      const idleMs = Date.now() - new Date(activeTask.last_activity_at).getTime();
      if (idleMs >= input.timeoutMs) {
        input.taskActivity({
          stage: 'stalled',
          message: 'Agent 长时间无进展，正在停止本轮任务',
          source: 'watchdog',
          activity: false,
        });
        input.abort(createStallError());
      }
    }, 2000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  function prepareStagingWorkspace(payload: AgentRunTaskPayload): void {
    clearDirectoryContents(serviceWorkspaceDir);
    writeWorkspaceFiles(serviceWorkspaceDir, payload.files || []);
    writeOpenCodeAgentsFile(serviceWorkspaceDir);
  }

  function cleanupStagingWorkspace(): void {
    clearDirectoryContents(serviceWorkspaceDir);
  }

  function archiveTaskWorkspace(taskId: string): string {
    const taskDir = path.join(tasksRoot, safeTaskPathSegment(taskId));
    const archiveWorkspaceDir = path.join(taskDir, 'workspace');
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.cpSync(serviceWorkspaceDir, archiveWorkspaceDir, { recursive: true });
    return archiveWorkspaceDir;
  }

  function writeTaskDiagnostics(taskId: string, payload: Record<string, unknown> = {}): void {
    try {
      const taskDir = path.join(tasksRoot, safeTaskPathSegment(taskId));
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'diagnostics.json'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      /* 诊断落盘失败不应影响任务结果 */
    }
  }

  function writeTaskResult(taskId: string, payload: Record<string, unknown> = {}): void {
    try {
      const taskDir = path.join(tasksRoot, safeTaskPathSegment(taskId));
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'result.json'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      /* 结果落盘失败不影响已返回的任务结果 */
    }
  }

  function collectDiagnostics(input: { taskId: string; title: string; outputFile: string }): Record<string, unknown> {
    let output = { path: '', content: '' };
    try {
      output = readOutputContent(serviceWorkspaceDir, input.outputFile);
    } catch {
      /* ignore */
    }
    return {
      taskId: input.taskId,
      title: input.title,
      workspaceDir: serviceWorkspaceDir,
      runtimeRoot: serviceRuntimeRoot,
      outputFile: input.outputFile,
      outputPath: output.path,
      outputContent: output.content,
      requestLog: sidecar?.requestLog || [],
      stderrTail: sidecar?.getStderrTail?.(8000) || '',
      stdoutTail: sidecar?.getStdoutTail?.(8000) || '',
      status: getStatus(),
      events: diagnostics.events.slice(-120),
    };
  }

  function moveDiagnosticsToArchivedWorkspace(
    diagnosticsPayload: Record<string, unknown>,
    archivedWorkspaceDir: string,
    outputFile: string,
  ): Record<string, unknown> {
    if (!diagnosticsPayload || !archivedWorkspaceDir) return diagnosticsPayload;
    diagnosticsPayload.workspaceDir = archivedWorkspaceDir;
    try {
      const relativePath = safeRelativePath(outputFile);
      diagnosticsPayload.outputPath = ensureInsideRoot(archivedWorkspaceDir, path.join(archivedWorkspaceDir, relativePath), outputFile);
    } catch {
      diagnosticsPayload.outputPath = path.join(archivedWorkspaceDir, path.basename(outputFile || 'agent-result.md'));
    }
    return diagnosticsPayload;
  }

  interface RetryRunResult {
    session: Record<string, unknown>;
    message: unknown;
    parts: Array<{ type?: string; text?: string }>;
    text: string;
    diff: unknown[];
    output: { path: string; content: string };
    validation_result: unknown;
    retry_count: number;
    retry_attempts: AgentRetryAttempt[];
  }

  async function runOpenCodeTaskWithRetry(input: {
    title: string;
    prompt: string;
    outputFile: string;
    signal: AbortSignal;
    agent: string;
    taskActivity: (event: AgentActivityEvent) => void;
    validateOutput: AgentRunTaskPayload['validateOutput'];
    maxRetries: number;
    retryAttempts: AgentRetryAttempt[];
    onSessionCreated: (session: Record<string, unknown>) => void;
  }): Promise<RetryRunResult> {
    const session = await createSession(sidecar as OpenCodeSidecar, input.title, { signal: input.signal, onActivity: input.taskActivity });
    const sessionId =
      (session.id as string) || (session.sessionID as string) || (session.session_id as string) || '';
    if (!sessionId) {
      throw new Error('OpenCode session 创建成功但缺少 session id');
    }
    input.onSessionCreated(session);
    let nextPrompt = input.prompt;
    let lastMessageResult: Record<string, unknown> | null = null;
    let lastText = '';
    let validationResult: unknown = null;

    for (let attemptIndex = 0; attemptIndex <= input.maxRetries; attemptIndex += 1) {
      const attempt = attemptIndex + 1;
      try {
        lastMessageResult = (await sendPrompt(sidecar as OpenCodeSidecar, sessionId, nextPrompt, {
          signal: input.signal,
          agent: input.agent,
          onActivity: input.taskActivity,
        })) as Record<string, unknown> | null;
        lastText = extractTextFromPromptResult(lastMessageResult as { parts?: Array<{ type?: string; text?: string }> } | null);
        const output = readOutputContent(serviceWorkspaceDir, input.outputFile);
        const candidate = {
          success: true,
          title: input.title,
          output_file: input.outputFile,
          output_content: output.content,
          assistant_text: lastText,
          session_id: sessionId,
          retry_count: attemptIndex,
          retry_attempts: [...input.retryAttempts],
        };
        if (typeof input.validateOutput === 'function') {
          const validationContext: AgentValidationContext = {
            attempt,
            max_retries: input.maxRetries,
            task_id: activeTask?.task_id || '',
            title: input.title,
            output_file: input.outputFile,
            workspace_dir: serviceWorkspaceDir,
            session_id: sessionId,
            retry_attempts: [...input.retryAttempts],
          };
          try {
            validationResult = await input.validateOutput(candidate as AgentValidationCandidate, validationContext);
          } catch (validationError) {
            throw markAgentValidationError(validationError);
          }
        }
        const diff = await getSessionDiff(sidecar as OpenCodeSidecar, sessionId, {
          signal: input.signal,
          onActivity: input.taskActivity,
        }).catch(() => []);
        return {
          session,
          message: (lastMessageResult as { info?: unknown })?.info || null,
          parts: Array.isArray((lastMessageResult as { parts?: unknown[] })?.parts)
            ? ((lastMessageResult as { parts: Array<{ type?: string; text?: string }> }).parts)
            : [],
          text: lastText,
          diff: Array.isArray(diff) ? diff : [],
          output,
          validation_result: validationResult,
          retry_count: attemptIndex,
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
          output = readOutputContent(serviceWorkspaceDir, input.outputFile);
        } catch {
          /* ignore */
        }
        input.retryAttempts.push(createRetryAttemptSummary({ attempt, error, outputContent: output.content }));
        const retryAttempt = input.retryAttempts.length;
        input.taskActivity({
          stage: 'retry',
          message: `Agent 执行未通过，正在同一会话自动修复 ${retryAttempt}/${input.maxRetries}：${compactErrorText(error, 160)}`,
          source: 'runtime.retry',
          activity: true,
          meta: {
            attempt,
            retry_attempt: retryAttempt,
            max_retries: input.maxRetries,
            validation_failed: Boolean((error as { agentValidationFailed?: boolean })?.agentValidationFailed),
          },
        });
        nextPrompt = buildAgentRetryPrompt({
          outputFile: input.outputFile,
          attempt: retryAttempt,
          maxRetries: input.maxRetries,
          error,
        });
      }
    }
    throw new Error('Agent 自动修复流程异常结束');
  }

  function startOpenCodeEventWatcher(sessionId: string, taskActivity: (event: AgentActivityEvent) => void): () => void {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId || !databaseClass) return () => {};
    // opencode 把 sqlite 落在 XDG_DATA_HOME（我们指向 serviceRuntimeRoot/home/.local/share）。
    const dbPath = path.join(serviceHomeDir, '.local', 'share', 'opencode', 'opencode.db');
    const messageRoleCache = new Map<string, string>();
    let lastSeq = -1;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function handlePart(db: any, row: any, part: OpenCodePart): void {
      if (!part || typeof part !== 'object') return;
      const partSessionId = (part as any).sessionID || (part as any).session_id || '';
      if (partSessionId && partSessionId !== normalizedSessionId) return;
      const role = getMessageRole(db, messageRoleCache, (part as any).messageID || (part as any).message_id || '');
      if (role && role !== 'assistant') return;
      if (!role && String((part as any).type || '') === 'text') return;
      const text = formatOpenCodePartActivity(part);
      taskActivity({
        stage: getOpenCodePartStage(part),
        message: text,
        source: 'opencode.part',
        visible: Boolean(text),
        activity: true,
        meta: {
          session_id: normalizedSessionId,
          seq: row.seq,
          event_type: row.type,
          part_id: (part as any).id || '',
          part_type: (part as any).type || '',
          message_id: (part as any).messageID || (part as any).message_id || '',
          tool: (part as any).tool || '',
          tool_status: (part as any)?.state?.status || '',
        },
      });
    }

    function poll(): void {
      if (stopped || !fs.existsSync(dbPath)) return;
      let db: InstanceType<BetterSqlite3Class> | null = null;
      try {
        db = new databaseClass!(dbPath, { readonly: true, fileMustExist: true });
        const rows = (db as any)
          .prepare(
            `SELECT seq, type, data
             FROM event
             WHERE aggregate_id = ? AND seq > ?
             ORDER BY seq ASC
             LIMIT ?`,
          )
          .all(normalizedSessionId, lastSeq, OPENCODE_EVENT_BATCH_LIMIT);
        for (const row of rows) {
          lastSeq = Math.max(lastSeq, Number(row.seq || 0));
          taskActivity({
            stage: 'opencode_event',
            message: '',
            source: 'opencode.event',
            visible: false,
            activity: true,
            meta: { session_id: normalizedSessionId, seq: row.seq, event_type: row.type },
          });
          if (String(row.type || '').startsWith('message.part.updated')) {
            const data = parseJsonObject(row.data || '');
            handlePart(db as any, row, (data?.part as OpenCodePart) || null);
          }
        }
      } catch (error) {
        diagnostics.record('opencode.event_watcher.failed', {
          session_id: normalizedSessionId,
          message: (error as Error)?.message || String(error),
        });
      } finally {
        try {
          (db as any)?.close?.();
        } catch {
          /* ignore */
        }
      }
    }

    poll();
    timer = setInterval(poll, OPENCODE_EVENT_POLL_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    };
  }

  function startOutputWatcher(outputFile: string, taskActivity: (event: AgentActivityEvent) => void): () => void {
    let previousKey = '';
    const outputPath = ensureInsideRoot(serviceWorkspaceDir, path.join(serviceWorkspaceDir, safeRelativePath(outputFile)), outputFile);
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

  async function runTaskNow(payload: AgentRunTaskPayload): Promise<AgentRunTaskSuccessResult> {
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const timeoutMs = normalizeTimeoutMs(payload.timeout_ms, DEFAULT_AGENT_IDLE_TIMEOUT_MS);
    const maxRetries = normalizeMaxRetries(payload.max_retries);
    const retryAttempts: AgentRetryAttempt[] = [];

    activeTask = createActiveTask({ taskId, title, timeoutMs, onActivity: payload.onActivity });
    const taskActivity = createTaskActivity(activeTask);
    setPhase('running', '等待 Agent 返回真实进度');
    emitStatus();

    activeTaskAbortController = new AbortController();
    const stopParentAbort = bindParentSignal(payload.signal, activeTaskAbortController);
    const stopWatchdog = startActivityWatchdog({
      timeoutMs,
      abort: (error) => {
        if (activeTaskAbortController && !activeTaskAbortController.signal.aborted) activeTaskAbortController.abort(error);
      },
      taskActivity,
    });
    let stopOutputWatcher: (() => void) | null = null;
    let stopOpenCodeEventWatcher: (() => void) | null = null;
    let mustRestartAfterTask = false;

    try {
      await ensureStarted();
      if (activeTaskAbortController.signal.aborted) throw activeTaskAbortController.signal.reason as Error;

      taskActivity({ stage: 'workspace', message: '', source: 'runtime', visible: false, activity: false });
      prepareStagingWorkspace(payload);
      stopOutputWatcher = startOutputWatcher(outputFile, taskActivity);

      const result = await runOpenCodeTaskWithRetry({
        title,
        prompt: payload.prompt || createDefaultAgentPrompt({ task: payload.task || '请分析当前输入文件，并输出可执行结果。', outputFile }),
        outputFile,
        signal: activeTaskAbortController.signal,
        agent: payload.agent || 'build',
        taskActivity,
        validateOutput: payload.validateOutput,
        maxRetries,
        retryAttempts,
        onSessionCreated: (session) => {
          stopOpenCodeEventWatcher?.();
          stopOpenCodeEventWatcher = startOpenCodeEventWatcher(
            (session.id as string) || (session.sessionID as string) || (session.session_id as string) || '',
            taskActivity,
          );
        },
      });

      taskActivity({ stage: 'output', message: '', source: 'runtime', visible: false, activity: false });
      const output = result.output || readOutputContent(serviceWorkspaceDir, outputFile);

      taskActivity({ stage: 'archive', message: '', source: 'runtime', visible: false, activity: false });
      const archivedWorkspaceDir = archiveTaskWorkspace(taskId);
      const diagnosticsPayload = moveDiagnosticsToArchivedWorkspace(
        collectDiagnostics({ taskId, title, outputFile }),
        archivedWorkspaceDir,
        outputFile,
      );
      diagnosticsPayload.retryAttempts = [...retryAttempts];
      writeTaskDiagnostics(taskId, diagnosticsPayload);

      const taskResult: AgentRunTaskSuccessResult = {
        success: true,
        task_id: taskId,
        title,
        workspace_dir: archivedWorkspaceDir,
        runtime_workspace_dir: serviceWorkspaceDir,
        runtime_root: serviceRuntimeRoot,
        output_file: outputFile,
        output_content: output.content,
        assistant_text: result.text,
        diff: result.diff,
        session_id: (result.session.id as string) || (result.session.sessionID as string) || (result.session.session_id as string) || '',
        retry_count: result.retry_count || 0,
        retry_attempts: result.retry_attempts || [],
        validation_result: result.validation_result,
        opencode_request_log: sidecar?.requestLog || [],
        opencode_stderr_tail: sidecar?.getStderrTail?.(8000) || '',
        opencode_stdout_tail: sidecar?.getStdoutTail?.(8000) || '',
      };
      writeTaskResult(taskId, taskResult as unknown as Record<string, unknown>);
      return taskResult;
    } catch (error) {
      if (isUserCancelOrPause(error)) {
        mustRestartAfterTask = true;
        throw annotateAgentError(error, collectDiagnostics({ taskId, title, outputFile }));
      }
      if (isWatchdogStall(error)) {
        mustRestartAfterTask = true;
      }
      const diagnosticsPayload = collectDiagnostics({ taskId, title, outputFile });
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
        moveDiagnosticsToArchivedWorkspace(diagnosticsPayload, archivedWorkspaceDir, outputFile);
      } catch (archiveError) {
        diagnosticsPayload.archiveError = (archiveError as Error)?.message || String(archiveError || '归档失败');
      }
      writeTaskDiagnostics(taskId, diagnosticsPayload);
      throw annotateAgentError(error, diagnosticsPayload);
    } finally {
      stopOpenCodeEventWatcher?.();
      stopOutputWatcher?.();
      stopWatchdog();
      stopParentAbort();
      const shouldRestart = mustRestartAfterTask || phase === 'unhealthy';
      activeTask = null;
      activeTaskAbortController = null;
      try {
        cleanupStagingWorkspace();
      } catch (error) {
        lastHealthError = (error as Error)?.message || String(error);
      }
      if (phase !== 'closing' && phase !== 'stopped') {
        if (shouldRestart) {
          await restart('task aborted or stalled').catch((restartError) => {
            lastHealthError = (restartError as Error)?.message || String(restartError || 'Agent 服务重启失败');
            setPhase('unhealthy', 'Agent 服务重启失败');
          });
        } else if (restartPending) {
          await restart('config changed').catch((restartError) => {
            lastHealthError = (restartError as Error)?.message || String(restartError || 'Agent 服务重启失败');
            setPhase('unhealthy', 'Agent 服务重启失败');
          });
        } else {
          setPhase(sidecar ? 'idle' : 'unhealthy', sidecar ? 'Agent 服务空闲' : 'Agent 服务异常');
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
    // 单飞契约：sidecar 被占用时直接返回 busy 哨兵，让调用方降级（不阻塞等待）。
    // activeTask 在 runTaskNow 同步前缀里即被置位，故并发调用不会双发（JS 单线程 + 同步赋值）。
    if (activeTask) {
      return createBusyResult();
    }
    return runTaskNow(payload);
  }

  async function warmup(): Promise<void> {
    try {
      await ensureStarted();
    } catch (error) {
      lastHealthError = (error as Error)?.message || String(error || 'Agent 服务启动失败');
      setPhase('unhealthy', 'Agent 服务启动失败');
      throw error;
    }
  }

  async function boot(): Promise<void> {
    // 进程启动时调用：失败不抛（标 unhealthy），主服务照常起；agent 路径降级。
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
    setPhase('restarting', '正在重启 Agent 服务');
    await closeOpenCodeSidecar(sidecar);
    sidecar = null;
    try {
      cleanupStagingWorkspace();
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
        lastHealthError = (error as Error)?.message || String(error || 'Agent 服务重启失败');
        setPhase('unhealthy', 'Agent 服务重启失败');
      });
    }
  }

  function handleConfigChanged(nextConfig: Record<string, unknown> = {}, previousConfig: Record<string, unknown> = {}): void {
    // 仅 context_length_limit 变更需重启 sidecar（写入 opencode.json 的 limit.context）。
    // key/model/base_url 由 AI proxy 每请求 live 直读，免重启。
    if (Number(nextConfig.context_length_limit || 0) !== Number(previousConfig.context_length_limit || 0)) {
      markRestartPending('context_length_limit changed');
    }
  }

  function buildSelfCheckPrompt(): string {
    return `请阅读当前工作目录中的 self-check-input.txt，然后在本工作区内创建文件 ${SELF_CHECK_OUTPUT_FILE}，
内容严格为如下一行（前后不要有额外字符或解释）：
${SELF_CHECK_OK_MARKER}
完成后在最终回复中简述你读取和写入的文件。`;
  }

  function validateSelfCheckOutput(content: string): void {
    if (!content.includes(SELF_CHECK_OK_MARKER)) {
      throw createSelfCheckStageError('output-check', `自检输出未包含期望标记：${SELF_CHECK_OK_MARKER}`);
    }
  }

  function createSelfCheckSteps(): SelfCheckStepInternal[] {
    return [
      { id: 'prepare', label: '自检准备', status: 'pending', message: '' },
      { id: 'binary-check', label: '二进制检查', status: 'pending', message: '' },
      { id: 'runtime-write-check', label: '运行目录写入', status: 'pending', message: '' },
      { id: 'ai-proxy-start', label: 'AI proxy', status: 'pending', message: '' },
      { id: 'opencode-server-start', label: 'OpenCode Server', status: 'pending', message: '' },
      { id: 'session-create', label: '会话创建', status: 'pending', message: '' },
      { id: 'message-wait', label: 'Agent 执行', status: 'pending', message: '' },
      { id: 'output-check', label: '输出校验', status: 'pending', message: '' },
    ];
  }

  function mapStepStatus(internal: SelfCheckStepInternal): AgentSelfCheckStep['status'] {
    switch (internal.status) {
      case 'success':
        return 'pass';
      case 'error':
        return 'fail';
      case 'running':
        return 'warn';
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
    }));
  }

  function inferActivityStatus(event: AgentActivityEvent, successPattern: RegExp): 'success' | 'error' | 'running' {
    const status = event.meta?.status as 'success' | 'error' | 'running' | undefined;
    if (status === 'success' || status === 'error' || status === 'running') return status;
    return successPattern.test(String(event.message || '')) ? 'success' : 'running';
  }

  // 自检的 agent 活动路由到对应步骤状态（镜像桌面 runSelfCheck 内的 handleInternalActivity 子集）。
  function handleSelfCheckActivity(event: AgentActivityEvent, steps: SelfCheckStepInternal[]): void {
    const stage = String(event.stage || '');
    const messageText = String(event.message || '');
    const setStep = (id: string, status: SelfCheckStepInternal['status'], msg: string) => {
      const step = steps.find((item) => item.id === id);
      if (!step) return;
      if (step.status === 'error' && status !== 'error') return;
      if (step.status === 'success' && status === 'running') return;
      step.status = status;
      step.message = msg || step.message;
    };
    if (['ai-proxy-start', 'opencode-server-start', 'opencode-health', 'opencode-config-write'].includes(stage)) {
      setStep(stage === 'opencode-health' ? 'opencode-server-start' : stage, inferActivityStatus(event, /成功|完成|可用|通过/), messageText);
      return;
    }
    if (stage === 'session') {
      setStep('session-create', inferActivityStatus(event, /已创建|完成/), messageText);
      return;
    }
    if (stage === 'message') {
      setStep('message-wait', inferActivityStatus(event, /完成/), messageText);
      return;
    }
    if (stage === 'output' && String(event.meta?.route || '').includes('/diff')) {
      const nextStatus = inferActivityStatus(event, /已读取|完成/);
      if (nextStatus !== 'error') setStep('message-wait', nextStatus, messageText);
      return;
    }
    if ((stage === 'tool' || event.source === 'workspace.output') && messageText) {
      setStep('message-wait', 'running', messageText);
    }
  }

  async function runSelfCheck(): Promise<AgentSelfCheckReport> {
    const startedAt = nowIso();
    const steps = createSelfCheckSteps();

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

    const setStep = (id: string, status: SelfCheckStepInternal['status'], msg: string) => {
      const step = steps.find((item) => item.id === id);
      if (!step) return;
      if (step.status === 'error' && status !== 'error') return;
      if (step.status === 'success' && status === 'running') return;
      step.status = status;
      step.message = msg || step.message;
    };
    const completeRuntimeSteps = () => {
      if (!sidecar) return;
      setStep('ai-proxy-start', 'success', sidecar.aiProxyBaseUrl || 'AI proxy 可用');
      setStep('opencode-server-start', 'success', sidecar.baseUrl || 'OpenCode Server 可用');
    };
    const failCurrentStep = (error: unknown) => {
      const existing = steps.find((step) => step.status === 'error');
      if (existing) {
        if (error && typeof error === 'object' && !(error as { selfCheckStage?: string }).selfCheckStage) {
          (error as { selfCheckStage?: string }).selfCheckStage = existing.id;
        }
        return;
      }
      const stageId = steps.some((step) => step.id === 'message-wait') ? 'message-wait' : steps[0]?.id || 'prepare';
      if (error && typeof error === 'object' && !(error as { selfCheckStage?: string }).selfCheckStage) {
        (error as { selfCheckStage?: string }).selfCheckStage = stageId;
      }
      setStep(stageId, 'error', (error as Error)?.message || String(error || '智能体自检失败'));
    };

    try {
      setStep('prepare', 'running', '清理旧自检归档');
      ensureRuntimeDirs();
      try {
        fs.rmSync(getAgentTaskDir(SELF_CHECK_TASK_ID, dataDir), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      setStep('prepare', 'success', '就绪');

      setStep('binary-check', 'running', '检查 OpenCode 二进制');
      if (!binPath || !fs.existsSync(binPath)) {
        throw createSelfCheckStageError('binary-check', `OpenCode binary 不存在或不可访问：${binPath || '(未配置)'}`);
      }
      setStep('binary-check', 'success', binPath);

      setStep('runtime-write-check', 'running', '检查运行目录写入能力');
      fs.mkdirSync(serviceRuntimeRoot, { recursive: true });
      fs.mkdirSync(serviceWorkspaceDir, { recursive: true });
      const writeCheckPath = path.join(serviceRuntimeRoot, `.self-check-write-${Date.now()}.tmp`);
      fs.writeFileSync(writeCheckPath, 'ok', 'utf-8');
      fs.rmSync(writeCheckPath, { force: true });
      setStep('runtime-write-check', 'success', '运行目录可写');

      setStep('ai-proxy-start', 'running', '正在启动 sidecar / AI proxy');
      setStep('opencode-server-start', 'running', '正在启动 OpenCode Server');
      setStep('session-create', 'running', '正在创建会话');
      setStep('message-wait', 'running', '正在运行自检 Agent 任务');

      const agentResult = await runTask({
        task_id: SELF_CHECK_TASK_ID,
        title: '易标智能体自检',
        output_file: SELF_CHECK_OUTPUT_FILE,
        files: [{ path: 'self-check-input.txt', content: 'YIBIAO_AGENT_SELF_CHECK_INPUT' }],
        prompt: buildSelfCheckPrompt(),
        timeout_ms: SELF_CHECK_TIMEOUT_MS,
        max_retries: 0,
        onActivity: (event) => handleSelfCheckActivity(event, steps),
      });

      if (!('success' in agentResult) || !agentResult.success) {
        // busy：sidecar 被占用（罕见，已前置 activeTask 短路，保险起见）。
        completeRuntimeSteps();
        return {
          started_at: startedAt,
          finished_at: nowIso(),
          overall: 'warn',
          steps: mapSteps(steps),
          diagnostics: { reason: 'busy', runtime_status: getStatus() },
        };
      }

      completeRuntimeSteps();
      setStep('session-create', 'success', `session_id=${agentResult.session_id || '-'}`);
      setStep('message-wait', 'success', 'Agent 任务执行完成');

      setStep('output-check', 'running', '校验输出内容');
      validateSelfCheckOutput(agentResult.output_content || '');
      setStep('output-check', 'success', '输出内容符合预期');

      return {
        started_at: startedAt,
        finished_at: nowIso(),
        overall: 'pass',
        steps: mapSteps(steps),
        diagnostics: {
          session_id: agentResult.session_id,
          output_chars: String(agentResult.output_content || '').length,
          workspace_dir: agentResult.workspace_dir,
          runtime_status: getStatus(),
        },
      };
    } catch (error) {
      completeRuntimeSteps();
      failCurrentStep(error);
      return {
        started_at: startedAt,
        finished_at: nowIso(),
        overall: 'fail',
        steps: mapSteps(steps),
        diagnostics: {
          error: (error as Error)?.message || String(error),
          selfCheckStage: (error as { selfCheckStage?: string })?.selfCheckStage,
          runtime_status: getStatus(),
          stderr_tail: sidecar?.getStderrTail?.(4000) || '',
          events: diagnostics.events.slice(-120),
        },
      };
    }
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      setPhase('closing', '正在关闭 Agent 服务');
      stopIdleHealthTimer();
      stopStatusTimer();
      if (emitStatusTimer) {
        clearTimeout(emitStatusTimer);
        emitStatusTimer = null;
      }
      if (activeTaskAbortController && !activeTaskAbortController.signal.aborted) {
        activeTaskAbortController.abort(new Error('Agent 服务正在关闭'));
      }
      if (startPromise) {
        await startPromise.catch(() => undefined);
      }
      activeTask = null;
      activeTaskAbortController = null;
      await closeOpenCodeSidecar(sidecar);
      sidecar = null;
      try {
        cleanupStagingWorkspace();
      } catch {
        /* ignore */
      }
      setPhase('stopped', 'Agent 服务已停止');
      emitStatus();
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  }

  startStatusTimer();

  return {
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
  };
}
