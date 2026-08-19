import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './http';

// Agent sidecar 运维客户端（对接 server routes/agent.ts）。
// 桌面 bridge 的 window.yibiao.agent.* 在 Web 是 no-op stub，故设置页智能体 tab 直连 HTTP。

export type AgentRuntimePhase = 'stopped' | 'starting' | 'idle' | 'running' | 'restarting' | 'unhealthy' | 'closing';

export interface AgentActiveTaskInfo {
  task_id: string;
  title: string;
  started_at: string;
  retry_count?: number;
  stage?: string;
  progress_text?: string;
  last_activity_at?: string;
  elapsed_seconds?: number;
  idle_seconds?: number;
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

export type AgentSelfCheckStepStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface AgentSelfCheckStep {
  id: string;
  label: string;
  status: AgentSelfCheckStepStatus;
  message?: string;
}

export type AgentSelfCheckOverall = 'pass' | 'fail' | 'warn';

export interface AgentSelfCheckReport {
  started_at: string;
  finished_at: string;
  overall: AgentSelfCheckOverall;
  steps: AgentSelfCheckStep[];
  diagnostics?: Record<string, unknown>;
}

interface AgentStatusResponse extends AgentServiceStatus {}
interface SelfCheckResponse { success: boolean; report: AgentSelfCheckReport; message?: string }
interface RestartResponse { success: boolean; status: AgentServiceStatus; message?: string }
interface PendingQuestionResponse { question: AgentPendingQuestion | null }
interface AnswerQuestionResponse { success: boolean; message?: string }

export interface AgentQuestionOption {
  id?: string;
  label: string;
  description?: string;
  recommended?: boolean;
  custom?: boolean;
}

export interface AgentPendingQuestion {
  question_id: string;
  task_id: string;
  task_title?: string;
  project_id?: number;
  question: string;
  options: AgentQuestionOption[];
  metadata?: unknown;
  asked_at: string;
}

export interface AgentQuestionAnswerPayload {
  question_id: string;
  option_id: string;
  custom_answer?: string;
  answer_payload?: unknown;
}

export async function getAgentStatus(): Promise<AgentServiceStatus> {
  const { data } = await http.get<AgentStatusResponse>('/agent/status');
  return data;
}

export async function runAgentSelfCheck(): Promise<AgentSelfCheckReport> {
  const { data } = await http.post<SelfCheckResponse>('/agent/self-check');
  if (!data.success) throw new Error(data.message || '智能体自检失败');
  return data.report;
}

export async function restartAgent(): Promise<AgentServiceStatus> {
  const { data } = await http.post<RestartResponse>('/agent/restart');
  if (!data.success) throw new Error(data.message || '重启 Agent 失败');
  return data.status;
}

export async function getPendingAgentQuestion(): Promise<AgentPendingQuestion | null> {
  const { data } = await http.get<PendingQuestionResponse>('/agent/pending-question');
  return data.question || null;
}

export async function answerAgentQuestion(payload: AgentQuestionAnswerPayload): Promise<void> {
  const { data } = await http.post<AnswerQuestionResponse>('/agent/answer', payload);
  if (!data.success) throw new Error(data.message || '提交 Agent 回答失败');
}

// 状态轮询：仅 enabled（agent tab 激活 + admin）时发请求，5s 一次。
// refetchInterval 配合 enabled，tab 切走即停，避免后台空轮询。
export function useAgentStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['agent-status'],
    queryFn: getAgentStatus,
    enabled,
    refetchInterval: enabled ? 5000 : false,
    staleTime: 3000,
    retry: false,
  });
}

export function useRunAgentSelfCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: runAgentSelfCheck,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-status'] }),
  });
}

export function useRestartAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: restartAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-status'] }),
  });
}

// 人话化 phase → 既有状态卡 CSS 类（.agent-self-check-status.is-normal/is-busy/is-error/is-untested）。
export const agentPhaseMeta: Record<AgentRuntimePhase, { label: string; cls: string }> = {
  idle: { label: '空闲', cls: 'is-normal' },
  running: { label: '运行中', cls: 'is-busy' },
  starting: { label: '启动中', cls: 'is-busy' },
  restarting: { label: '重启中', cls: 'is-busy' },
  unhealthy: { label: '异常', cls: 'is-error' },
  closing: { label: '关闭中', cls: 'is-untested' },
  stopped: { label: '未启动', cls: 'is-untested' },
};

// 步骤状态 → 既有 CSS 类（feature-settings.css 的 .agent-self-check-step.is-success/is-error/is-running）。
export const agentStepStatusMeta: Record<AgentSelfCheckStepStatus, { label: string; cls: string }> = {
  pass: { label: '通过', cls: 'is-success' },
  fail: { label: '失败', cls: 'is-error' },
  warn: { label: '警告', cls: 'is-running' },
  skip: { label: '跳过', cls: '' },
};
