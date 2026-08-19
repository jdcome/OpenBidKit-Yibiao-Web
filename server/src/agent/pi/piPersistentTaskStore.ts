// Pi 持久任务存储（移植自桌面 electron/services/pi/piPersistentTaskStore.cjs）。
// per-task 目录 {workspace, sessions, task-state.json, result.json}；resume 读 task-state.json 的 session_file。
// 桌面用 Electron app → web 用 dataDir（getAgentPiLayout 的 tasksRoot 派生）。
// session 文件名严格校验 .jsonl basename，防路径穿越。

import fs from 'node:fs';
import path from 'node:path';
import { getAgentPiLayout } from '../../document/paths';

export const OUTLINE_AGENT_TASK_KEY = 'technical-plan-outline-generation';
const TASK_STATE_FILE = 'task-state.json';
const DELETE_MAX_RETRIES = 5;
const DELETE_RETRY_DELAY_MS = 100;

function nowIso(): string {
  return new Date().toISOString();
}

// 任务标识白名单（防目录穿越/非法字符）。
export function safeTaskKey(value: unknown): string {
  const key = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  if (!key) throw new Error('持久 Agent 任务缺少有效任务标识');
  return key;
}

export interface PersistentAgentTaskPaths {
  taskRoot: string;
  workspaceDir: string;
  sessionsDir: string;
  stateFile: string;
  resultFile: string;
}

export interface PersistentAgentTaskState {
  task_key?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  session_file?: string;
  [key: string]: unknown;
}

// 根据 dataDir 计算业务任务专属目录布局（对齐桌面 getPersistentAgentTaskPaths）。
export function getPersistentAgentTaskPaths(taskKey: string, dataDir?: string): PersistentAgentTaskPaths {
  const layout = getAgentPiLayout(dataDir);
  const taskRoot = path.join(layout.tasksRoot, safeTaskKey(taskKey));
  return {
    taskRoot,
    workspaceDir: path.join(taskRoot, 'workspace'),
    sessionsDir: path.join(taskRoot, 'sessions'),
    stateFile: path.join(taskRoot, TASK_STATE_FILE),
    resultFile: path.join(taskRoot, 'result.json'),
  };
}

// 将状态文件中的 session 文件名解析到当前任务目录（严校验 .jsonl basename）。
export function getPersistentAgentSessionPath(taskKey: string, sessionFile: string, dataDir?: string): string {
  const fileName = String(sessionFile ?? '').trim();
  if (!fileName || path.basename(fileName) !== fileName || !fileName.endsWith('.jsonl')) {
    throw new Error('目录 Agent Session 文件名无效，请重新生成目录');
  }
  return path.join(getPersistentAgentTaskPaths(taskKey, dataDir).sessionsDir, fileName);
}

// 删除持久任务目录（Windows 文件句柄释放有延迟，Node 原生重试）。
function removePersistentAgentTaskRoot(taskRoot: string): void {
  fs.rmSync(taskRoot, {
    recursive: true,
    force: true,
    maxRetries: DELETE_MAX_RETRIES,
    retryDelay: DELETE_RETRY_DELAY_MS,
  });
}

// 创建全新持久任务目录；同一业务任务重新生成时清空旧现场。
export function createPersistentAgentTask(
  taskKey: string,
  state: PersistentAgentTaskState = {},
  dataDir?: string,
): { paths: PersistentAgentTaskPaths; state: PersistentAgentTaskState } {
  const paths = getPersistentAgentTaskPaths(taskKey, dataDir);
  removePersistentAgentTaskRoot(paths.taskRoot);
  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  // 忽略 state 里可能误带的 task_key（canonical 由 taskKey 决定），保留其余字段覆盖默认值。
  const { task_key: _ignoredKey, ...rest } = state;
  const nextState: PersistentAgentTaskState = {
    task_key: taskKey,
    status: 'created',
    created_at: nowIso(),
    updated_at: nowIso(),
    ...rest,
  };
  fs.writeFileSync(paths.stateFile, JSON.stringify(nextState, null, 2), 'utf-8');
  return { paths, state: nextState };
}

// 读取持久任务检查点，不存在返回 null。
export function loadPersistentAgentTask(
  taskKey: string,
  dataDir?: string,
): { paths: PersistentAgentTaskPaths; state: PersistentAgentTaskState } | null {
  const paths = getPersistentAgentTaskPaths(taskKey, dataDir);
  if (!fs.existsSync(paths.stateFile)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as PersistentAgentTaskState;
    return { paths, state };
  } catch (error) {
    throw new Error(`目录 Agent 任务状态损坏：${(error as Error)?.message || String(error)}`);
  }
}

// 更新持久任务检查点（保留 task_key / created_at）。
export function updatePersistentAgentTask(
  taskKey: string,
  partial: PersistentAgentTaskState = {},
  dataDir?: string,
): { paths: PersistentAgentTaskPaths; state: PersistentAgentTaskState } {
  const current = loadPersistentAgentTask(taskKey, dataDir);
  if (!current) throw new Error('目录 Agent 持久任务不存在，请重新生成目录');
  // partial 里的 task_key/updated_at 由本函数 canonical 写入，不采纳调用方传值。
  const { task_key: _ignoredKey, updated_at: _ignoredUpdated, ...rest } = partial;
  const nextState: PersistentAgentTaskState = {
    ...current.state,
    ...rest,
    task_key: taskKey,
    updated_at: nowIso(),
  };
  fs.writeFileSync(current.paths.stateFile, JSON.stringify(nextState, null, 2), 'utf-8');
  return { paths: current.paths, state: nextState };
}

// 删除业务内容对应的完整工作区、Session 和检查点。
export function deletePersistentAgentTask(taskKey: string, dataDir?: string): void {
  const paths = getPersistentAgentTaskPaths(taskKey, dataDir);
  removePersistentAgentTaskRoot(paths.taskRoot);
}
