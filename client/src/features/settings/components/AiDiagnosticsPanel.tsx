import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  aiDiagnosticsApi,
  type AiDiagnosticAttempt,
  type AiDiagnosticRun,
} from '../../../shared/api/ai-diagnostics';

type DiagnosisTone = 'success' | 'warning' | 'danger' | 'info';

interface DiagnosisSummary {
  tone: DiagnosisTone;
  title: string;
  reason: string;
  impact: string;
  actions: string[];
  primaryIssue?: string;
}

const STATUS_LABEL: Record<string, string> = {
  success: '成功',
  error: '失败',
  degraded: '已降级',
  running: '运行中',
};

const TASK_LABEL: Record<string, string> = {
  'global-facts-generation': 'STEP04 全局事实设定',
  'outline-generation': 'STEP03 目录生成',
  'bid-analysis': 'STEP02 招标文件解析',
  'content-generation': 'STEP05 正文生成',
  'export-word': 'Word 导出',
};

const STAGE_LABEL: Record<string, string> = {
  request: '请求模型',
  response: '模型响应',
  parse: '解析 JSON',
  normalize: '结构整理',
  validate: '字段校验',
  repair: '自动修复',
  fallback: '安全降级',
  complete: '完成',
};

const PHASE_LABEL: Record<string, string> = {
  primary: '主请求',
  repair: '修复请求',
};

function labelTask(run: AiDiagnosticRun | null | undefined): string {
  if (!run) return 'AI 任务';
  return TASK_LABEL[run.taskType || ''] || run.taskType || run.operation || 'AI 任务';
}

function labelStatus(status: string | undefined, degraded?: boolean): string {
  if (degraded) return '已降级';
  return STATUS_LABEL[status || ''] || status || '未知';
}

function statusTone(run: AiDiagnosticRun): DiagnosisTone {
  if (run.status === 'error') return 'danger';
  if (run.degraded || run.status === 'degraded') return 'warning';
  if (run.status === 'success') return 'success';
  return 'info';
}

function formatDate(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function durationText(run: AiDiagnosticRun): string {
  if (!run.finishedAt) return '未完成';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}秒`;
  return `${Math.round(ms / 60000)}分钟`;
}

function getIssues(run: AiDiagnosticRun | null): Array<{ code?: string; stage?: string; message?: string; path?: string }> {
  if (!run?.attempts?.length) return [];
  return run.attempts.flatMap((attempt) => attempt.issues || []);
}

function firstProblemAttempt(run: AiDiagnosticRun | null): AiDiagnosticAttempt | undefined {
  return run?.attempts?.find((attempt) => attempt.status === 'error' || (attempt.issues || []).length > 0);
}

function explainIssue(run: AiDiagnosticRun, attempt?: AiDiagnosticAttempt): string {
  const issue = attempt?.issues?.[0] || getIssues(run)[0];
  const stage = issue?.stage || attempt?.stage || run.stage;
  const message = issue?.message || run.errorMessage || '';
  const code = issue?.code || run.errorCode || '';
  const text = `${code} ${message}`.toLowerCase();

  if (text.includes('json') || stage === 'parse') return '模型返回内容不是系统要求的 JSON 结构，导致解析失败。';
  if (stage === 'validate') return '模型返回结构已解析，但缺少必填字段或关键字段为空，未通过系统校验。';
  if (stage === 'normalize') return '模型返回结构不够稳定，系统整理后仍不满足统一格式。';
  if (stage === 'repair') return '系统已尝试让模型自动修复结果，但修复结果仍不可用。';
  if (stage === 'request' || text.includes('http') || text.includes('timeout')) return '模型服务请求阶段出现异常，可能是模型接口、网络或限流问题。';
  if (run.degraded || run.status === 'degraded') return '模型结果不完全可靠，系统已使用安全兜底结果完成任务。';
  if (message) return message;
  return '系统记录到异常阶段，但没有更详细的错误消息。';
}

function buildDiagnosis(run: AiDiagnosticRun | null): DiagnosisSummary | null {
  if (!run) return null;
  const task = labelTask(run);
  const attempt = firstProblemAttempt(run);
  const issue = attempt?.issues?.[0] || getIssues(run)[0];
  const primaryIssue = issue ? `${issue.code || 'AI_DIAGNOSTIC'}：${issue.message || '未记录详细说明'}` : undefined;

  if (run.status === 'error') {
    return {
      tone: 'danger',
      title: `${task}失败，需要处理后重试`,
      reason: explainIssue(run, attempt),
      impact: `本次 ${task} 没有正常完成，相关结果可能未落库或停留在上一次结果。`,
      actions: [
        '先查看下方“异常阶段”和脱敏失败响应，确认是模型格式问题、接口问题还是校验问题。',
        '如果是偶发模型格式错误，可重新运行当前步骤；如果连续失败，建议切换模型或调整对应提示词。',
        '把诊断编号复制给技术人员，可直接定位这次任务的 trace。',
      ],
      primaryIssue,
    };
  }

  if (run.degraded || run.status === 'degraded') {
    return {
      tone: 'warning',
      title: `${task}已安全降级完成，建议人工复核`,
      reason: explainIssue(run, attempt),
      impact: `系统没有中断流程，但 ${task} 使用了兜底结果；内容可用性取决于人工复核。`,
      actions: [
        '回到对应步骤检查生成结果，重点看是否有空字段、事实遗漏或明显不符合招标文件的内容。',
        '如果结果可接受，可以继续后续流程；如果关键事实缺失，建议重新运行或换模型后再生成。',
        '保留诊断编号，便于后续比对同类项目是否频繁降级。',
      ],
      primaryIssue,
    };
  }

  if (run.status === 'success') {
    return {
      tone: 'success',
      title: `${task}已正常完成`,
      reason: '系统未记录阻断性异常，模型结果通过了解析、整理和校验流程。',
      impact: `本次 ${task} 已完成，通常无需在诊断台继续处理。`,
      actions: [
        '如业务结果仍不理想，优先回到对应步骤检查招标文件、目录或提示词配置。',
        '诊断台可作为留痕，用于确认这次不是模型接口或 JSON 结构失败。',
      ],
    };
  }

  return {
    tone: 'info',
    title: `${task}仍在运行或状态未结束`,
    reason: '任务还没有结束，诊断结论可能会继续变化。',
    impact: `当前 ${task} 暂无最终结论。`,
    actions: ['稍后点击刷新查看最新状态。'],
  };
}

function tryStringify(value: unknown): string {
  if (!value) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function AiDiagnosticsPanel() {
  const [runs, setRuns] = useState<AiDiagnosticRun[]>([]);
  const [selected, setSelected] = useState<AiDiagnosticRun | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await aiDiagnosticsApi.list({ pageSize: 50 });
      setRuns(result.items);
      if (!selected && result.items[0]) setSelected(result.items[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 AI 任务诊断失败');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => { void load(); }, [load]);

  const open = async (run: AiDiagnosticRun) => {
    setDetailLoading(true);
    setError(null);
    try {
      setSelected(await aiDiagnosticsApi.detail(run.traceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取诊断详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const loadContent = async (run: AiDiagnosticRun, attemptId: string) => {
    const value = await aiDiagnosticsApi.content(run.traceId, attemptId);
    setContent((prev) => ({ ...prev, [attemptId]: value.content }));
  };

  const copyTrace = async () => {
    if (!selected?.traceId) return;
    await navigator.clipboard?.writeText(selected.traceId);
  };

  const stats = useMemo(() => {
    const total = runs.length;
    const errors = runs.filter((run) => run.status === 'error').length;
    const degraded = runs.filter((run) => run.degraded || run.status === 'degraded').length;
    const success = runs.filter((run) => run.status === 'success').length;
    return { total, errors, degraded, success };
  }, [runs]);

  const diagnosis = useMemo(() => buildDiagnosis(selected), [selected]);

  return (
    <section className="settings-page-section ai-diagnostics-panel">
      <div className="settings-section-title"><span /><strong>AI 任务诊断</strong></div>

      <div className="ai-diagnostics-hero">
        <div>
          <h3>管理员诊断台</h3>
          <p>把后台 AI 任务的失败、降级和修复过程翻译成可处理的结论；失败响应已脱敏，最多保留 7 天。</p>
        </div>
        <button type="button" className="inline-action" onClick={() => void load()}>{loading ? '刷新中…' : '刷新记录'}</button>
      </div>

      <div className="ai-diagnostics-statbar">
        <span><strong>{stats.total}</strong> 最近记录</span>
        <span className="is-success"><strong>{stats.success}</strong> 正常</span>
        <span className="is-warning"><strong>{stats.degraded}</strong> 降级</span>
        <span className="is-danger"><strong>{stats.errors}</strong> 失败</span>
      </div>

      {error && <div className="ai-diagnostics-alert">{error}</div>}

      <div className="ai-diagnostics-grid">
        <div className="ai-diagnostics-list">
          <div className="ai-diagnostics-list-head">
            <strong>最近 AI 任务</strong>
            <small>点击查看结论</small>
          </div>
          {runs.map((run) => (
            <button
              key={run.traceId}
              type="button"
              className={`ai-diagnostic-row ${selected?.traceId === run.traceId ? 'is-active' : ''}`}
              onClick={() => void open(run)}
            >
              <div className="ai-diagnostic-row-title">
                <strong>{labelTask(run)}</strong>
                <span className={`ai-diagnostic-status is-${statusTone(run)}`}>{labelStatus(run.status, run.degraded)}</span>
              </div>
              <span>{run.model || '未记录模型'} · {run.requestMode || '默认请求'}</span>
              <small>{formatDate(run.startedAt)} · {run.traceId.slice(0, 8)}</small>
            </button>
          ))}
          {!runs.length && !loading && <div className="settings-empty">暂无 AI 诊断记录</div>}
        </div>

        <div className="ai-diagnostics-detail">
          {!selected && <div className="settings-empty">选择一条记录查看诊断结论</div>}
          {selected && diagnosis && (
            <>
              <div className="ai-diagnostics-detail-head">
                <div>
                  <span className="ai-diagnostics-eyebrow">{labelTask(selected)}</span>
                  <h3>{diagnosis.title}</h3>
                </div>
                <button type="button" className="inline-action" onClick={() => void copyTrace()}>复制诊断编号</button>
              </div>

              <div className={`ai-diagnosis-card is-${diagnosis.tone}`}>
                <div className="ai-diagnosis-main">
                  <strong>诊断结论</strong>
                  <p>{diagnosis.reason}</p>
                  {diagnosis.primaryIssue && <small>{diagnosis.primaryIssue}</small>}
                </div>
                <div className="ai-diagnosis-impact">
                  <strong>影响范围</strong>
                  <p>{diagnosis.impact}</p>
                </div>
              </div>

              <div className="ai-diagnostics-meta-grid">
                <span><small>状态</small><strong>{labelStatus(selected.status, selected.degraded)}</strong></span>
                <span><small>阶段</small><strong>{STAGE_LABEL[selected.stage] || selected.stage || '-'}</strong></span>
                <span><small>模型</small><strong>{selected.model || '-'}</strong></span>
                <span><small>耗时</small><strong>{durationText(selected)}</strong></span>
                <span><small>项目 ID</small><strong>{selected.projectId || '-'}</strong></span>
                <span><small>任务 ID</small><strong>{selected.taskId || '-'}</strong></span>
              </div>

              <div className="ai-diagnostics-actions">
                <strong>建议处理</strong>
                <ol>
                  {diagnosis.actions.map((action) => <li key={action}>{action}</li>)}
                </ol>
              </div>

              <div className="ai-diagnostics-section-title">
                <strong>阶段详情</strong>
                {detailLoading && <small>加载中…</small>}
              </div>

              {(selected.attempts || []).map((attempt) => (
                <article key={attempt.id} className={`ai-diagnostic-attempt is-${attempt.status === 'error' ? 'danger' : 'neutral'}`}>
                  <div className="ai-diagnostic-attempt-head">
                    <strong>第 {attempt.attemptNo} 次 · {PHASE_LABEL[attempt.phase] || attempt.phase}</strong>
                    <span>{STAGE_LABEL[attempt.stage] || attempt.stage} · {labelStatus(attempt.status)}</span>
                  </div>
                  <div className="ai-diagnostic-attempt-metrics">
                    <span>请求 {attempt.requestChars} 字符</span>
                    <span>响应 {attempt.responseChars} 字符</span>
                    {attempt.createdAt && <span>{formatDate(attempt.createdAt)}</span>}
                  </div>
                  {(attempt.issues || []).map((issue, index) => (
                    <p key={`${issue.code}-${index}`} className="ai-diagnostic-issue">
                      <strong>{issue.code || 'AI_DIAGNOSTIC'}</strong>：{issue.message}
                      {issue.path && <small>位置：{issue.path}</small>}
                    </p>
                  ))}
                  {attempt.responseShape ? <details className="ai-diagnostic-details">
                    <summary>查看响应结构摘要</summary>
                    <pre>{tryStringify(attempt.responseShape)}</pre>
                  </details> : null}
                  {attempt.hasFailureContent && !content[attempt.id] && (
                    <button type="button" className="inline-action" onClick={() => void loadContent(selected, attempt.id)}>查看脱敏失败响应</button>
                  )}
                  {content[attempt.id] && <pre>{content[attempt.id]}</pre>}
                </article>
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
