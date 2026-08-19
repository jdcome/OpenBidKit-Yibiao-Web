import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, useToast } from '../../../shared/ui';
import type { OutlineData } from '../../../shared/types';
import type { BackgroundTaskState, GlobalFactGroupState } from '../types';
import type { SubjectReplacement } from '../../../shared/api/projects';
import SubjectReplacementCard from './SubjectReplacementCard';
import {
  analyzeSubjectIdentity,
  buildSubjectIdentityReplacements,
  shouldPromptSubjectIdentityConfirmation,
  type SubjectAliasCandidate,
} from '../utils/subjectIdentity';

interface GlobalFactsPageProps {
  outlineData: OutlineData | null;
  globalFacts: GlobalFactGroupState[];
  task?: BackgroundTaskState;
  subjectReplacements: SubjectReplacement[];
  bidderName: string;
  bidAnalysisBuyerName?: string;
  tenderMarkdown: string;
  subjectIdentityPromptKey?: string;
  subjectIdentityOpenSignal?: number;
  onBidderNameChange: (value: string) => Promise<void> | void;
  onSubjectReplacementsChange: (list: SubjectReplacement[]) => Promise<void> | void;
  onGlobalFactsSaved: (globalFacts: GlobalFactGroupState[]) => Promise<void> | void;
  onTaskStarted: (task: BackgroundTaskState) => void;
}

const statusLabels: Record<string, string> = {
  idle: '未开始',
  running: '生成中',
  success: '已完成',
  error: '失败',
};

function createFactId() {
  const randomId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `manual_${randomId.replace(/[^a-zA-Z0-9_-]/g, '_')}`.toLowerCase();
}

function formatUpdatedAt(value?: string) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function getProgress(task: BackgroundTaskState | undefined, hasFacts: boolean) {
  if (task?.status === 'running') return Math.max(5, Math.min(99, task.progress || 5));
  if (task?.status === 'error') return Math.max(0, Math.min(99, task.progress || 0));
  return hasFacts ? 100 : 0;
}

function GlobalFactsPage({
  outlineData,
  globalFacts,
  task,
  subjectReplacements,
  bidderName,
  bidAnalysisBuyerName,
  tenderMarkdown,
  subjectIdentityPromptKey,
  subjectIdentityOpenSignal = 0,
  onBidderNameChange,
  onSubjectReplacementsChange,
  onGlobalFactsSaved,
  onTaskStarted,
}: GlobalFactsPageProps) {
  const { showToast } = useToast();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(globalFacts[0]?.id || null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [identityDialogOpen, setIdentityDialogOpen] = useState(false);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [bidderNameDraft, setBidderNameDraft] = useState(bidderName || '');
  const [buyerNameDraft, setBuyerNameDraft] = useState(bidAnalysisBuyerName || '');
  const hasOutline = Boolean(outlineData?.outline?.length);
  const running = starting || task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const activeGroup = globalFacts.find((group) => group.id === selectedGroupId) || globalFacts[0] || null;
  const progress = getProgress(task, globalFacts.length > 0);
  const statusKey = running ? 'running' : taskFailed ? 'error' : globalFacts.length ? 'success' : 'idle';
  const latestLog = task?.logs?.[task.logs.length - 1] || '';
  const totalChars = useMemo(() => globalFacts.reduce((sum, group) => sum + group.content.length, 0), [globalFacts]);
  const dirty = Boolean(activeGroup && (draftTitle !== activeGroup.title || draftContent !== activeGroup.content));
  const subjectIdentity = useMemo(() => analyzeSubjectIdentity({
    bidderName: bidderNameDraft || bidderName,
    buyerName: buyerNameDraft || bidAnalysisBuyerName,
    tenderMarkdown,
    existingReplacements: subjectReplacements,
  }), [bidAnalysisBuyerName, bidderName, bidderNameDraft, buyerNameDraft, subjectReplacements, tenderMarkdown]);
  const detectedAliases = useMemo(() => [
    ...subjectIdentity.bidder.aliases,
    ...subjectIdentity.buyer.aliases,
  ].filter((item) => item.evidence || item.confidence !== 'default' || item.needsReview), [subjectIdentity]);

  const startGeneration = useCallback(async () => {
    if (!hasOutline) {
      showToast('请先生成目录，再进行全局事实设定', 'info');
      return;
    }

    try {
      setStarting(true);
      const startedTask = await window.yibiao?.tasks.startGlobalFactsGeneration({});
      if (!startedTask?.task_id) throw new Error('任务启动响应缺少任务编号');
      onTaskStarted(startedTask as BackgroundTaskState);
      showToast(startedTask.reused ? '任务正在运行，已恢复显示当前进度' : '全局事实设定任务已启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动全局事实设定失败', 'error');
    } finally {
      setStarting(false);
    }
  }, [hasOutline, onTaskStarted, showToast]);

  useEffect(() => {
    if (!globalFacts.length) {
      setSelectedGroupId(null);
      return;
    }

    setSelectedGroupId((prev) => globalFacts.some((group) => group.id === prev) ? prev : globalFacts[0].id);
  }, [globalFacts]);

  useEffect(() => {
    if (!activeGroup) {
      setDraftTitle('');
      setDraftContent('');
      return;
    }

    setDraftTitle(activeGroup.title);
    setDraftContent(activeGroup.content);
  }, [activeGroup?.id, activeGroup?.title, activeGroup?.content]);

  useEffect(() => {
    if (subjectIdentityOpenSignal > 0) {
      setIdentityDialogOpen(true);
    }
  }, [subjectIdentityOpenSignal]);

  useEffect(() => {
    setBidderNameDraft(bidderName || '');
  }, [bidderName]);

  useEffect(() => {
    setBuyerNameDraft((prev) => prev || bidAnalysisBuyerName || '');
  }, [bidAnalysisBuyerName]);

  // 主动弹窗：进入 STEP 04 时若本项目尚未确认过主体身份，提示用户统一确认投标主体身份。
  const seedAttemptedRef = useRef(false);
  useEffect(() => {
    if (seedAttemptedRef.current) return;
    const promptStatus = subjectIdentityPromptKey
      ? window.localStorage.getItem(subjectIdentityPromptKey)
      : null;
    if (!shouldPromptSubjectIdentityConfirmation({
      bidderName,
      buyerName: bidAnalysisBuyerName,
      tenderMarkdown,
      existingReplacements: subjectReplacements,
      promptStatus: promptStatus === 'confirmed' || promptStatus === 'dismissed' ? promptStatus : null,
    })) return;
    seedAttemptedRef.current = true;
    setIdentityDialogOpen(true);
  }, [subjectReplacements, bidderName, bidAnalysisBuyerName, tenderMarkdown, subjectIdentityPromptKey]);

  const confirmSubjectIdentity = async () => {
    const bidder = bidderNameDraft.trim();
    const buyer = buyerNameDraft.trim();
    if (!bidder) {
      showToast('请先填写我方公司全称', 'info');
      return;
    }
    try {
      setIdentitySaving(true);
      await onBidderNameChange(bidder);
      const replacements = buildSubjectIdentityReplacements({
        bidderName: bidder,
        buyerName: buyer,
        tenderMarkdown,
        existingReplacements: subjectReplacements,
      });
      await onSubjectReplacementsChange(replacements);
      if (subjectIdentityPromptKey) window.localStorage.setItem(subjectIdentityPromptKey, 'confirmed');
      setIdentityDialogOpen(false);
      showToast('投标主体身份与代称替换表已确认', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存投标主体身份失败', 'error');
    } finally {
      setIdentitySaving(false);
    }
  };

  const renderAliasCandidates = (title: string, aliases: SubjectAliasCandidate[]) => (
    <div className="subject-identity-alias-panel">
      <strong>{title}</strong>
      <div className="subject-identity-alias-list">
        {aliases.map((item) => (
          <span className={`subject-identity-alias-chip${item.needsReview ? ' needs-review' : ''}`} key={`${item.group}-${item.alias}`}>
            {item.alias}
            {item.needsReview && <em>需确认</em>}
          </span>
        ))}
      </div>
    </div>
  );

  const saveFacts = async (nextFacts: GlobalFactGroupState[], message = '全局事实已保存') => {
    try {
      setSaving(true);
      await onGlobalFactsSaved(nextFacts);
      showToast(message, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存全局事实失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveActiveGroup = async () => {
    if (!activeGroup) return;
    const title = draftTitle.trim();
    const content = draftContent.trim();
    if (!title || !content) {
      showToast('标题和内容不能为空', 'info');
      return;
    }

    await saveFacts(globalFacts.map((group) => (
      group.id === activeGroup.id
        ? { ...group, title, content, updated_at: new Date().toISOString() }
        : group
    )));
  };

  const addFactGroup = async () => {
    const nextGroup: GlobalFactGroupState = {
      id: createFactId(),
      title: '新增事实大项',
      content: '- 项目经理：张伟，高级工程师，负责总体协调和质量把关。',
      updated_at: new Date().toISOString(),
    };
    await saveFacts([...globalFacts, nextGroup], '已新增事实大项');
    setSelectedGroupId(nextGroup.id);
  };

  const deleteActiveGroup = async () => {
    if (!activeGroup) return;
    await saveFacts(globalFacts.filter((group) => group.id !== activeGroup.id), '已删除事实大项');
  };

  const copyActiveGroup = async () => {
    if (!draftContent.trim()) {
      showToast('当前没有可复制的内容', 'info');
      return;
    }
    await navigator.clipboard.writeText(draftContent);
    showToast('全局事实内容已复制', 'success');
  };

  return (
    <div className="plan-step-body global-facts-page">
      <section className="global-facts-command-bar">
        <div>
          <span className="section-kicker">STEP 04</span>
          <strong>全局事实设定</strong>
          <p>基于目录提前预设正文会反复用到的事实变量，避免各小节随机生成人员、时间、型号等内容。</p>
        </div>
        <div className="global-facts-stats">
          <span><strong>{globalFacts.length}</strong> 个大项</span>
          <span><strong>{totalChars}</strong> 字</span>
        </div>
        <button type="button" className="primary-action" onClick={() => startGeneration()} disabled={running || !hasOutline}>
          {running ? '生成中...' : globalFacts.length ? '重新解析' : '开始解析'}
        </button>
      </section>

      <section className="global-facts-workspace">
        <aside className="global-facts-panel" aria-label="全局事实大项列表">
          <div className="analysis-result-head global-facts-panel-head">
            <strong>事实大项</strong>
            <span className={`content-status-badge is-${statusKey}`}>{statusLabels[statusKey]}</span>
          </div>
          <div className={`content-outline-stats global-facts-progress${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>设定进度</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className={`content-generation-progress-track${running ? ' is-active' : ''}`} aria-label={`全局事实设定进度 ${progress}%`}>
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p>{taskFailed ? task?.error || latestLog || '全局事实设定失败，请重新解析。' : latestLog || '点击“开始解析”后，后台会生成全局事实变量。'}</p>
                {taskFailed && <small>失败后不会自动重试，可点击“重新解析”。</small>}
                {taskFailed && task?.diagnostic_trace_id && <small>诊断编号：{task.diagnostic_trace_id}</small>}
                {task?.status === 'success' && task.degraded && <small>本次已启用安全降级：结果通过最低质量校验，建议人工复核。</small>}
              </div>
            )}
          </div>
          <div className="global-facts-list">
            {globalFacts.length ? globalFacts.map((group) => (
              <button
                type="button"
                className={`global-facts-item${group.id === activeGroup?.id ? ' is-active' : ''}`}
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
              >
                <strong>{group.title}</strong>
                <small>{group.content.length} 字{group.updated_at ? ` · ${formatUpdatedAt(group.updated_at)}` : ''}</small>
              </button>
            )) : (
              <div className="global-facts-empty-list">
                <strong>{running ? '正在生成全局事实' : '暂无全局事实'}</strong>
                <p>{hasOutline ? '点击“开始解析”后，等待后台任务返回事实大项。' : '请先完成目录生成。'}</p>
              </div>
            )}
          </div>
          <div className="global-facts-panel-actions">
            <button type="button" className="secondary-action" onClick={addFactGroup} disabled={running || saving}>新增大项</button>
          </div>
        </aside>

        <article className="global-facts-reader">
          <div className="global-facts-reader-head">
            <div>
              <span className="section-kicker">事实内容</span>
              <strong>{activeGroup?.title || '等待全局事实'}</strong>
              <p>{activeGroup ? '可直接编辑事实变量；保存后会清空旧正文生成缓存，避免继续使用旧内容。' : '全局事实生成完成后，可在这里查看和编辑。'}</p>
            </div>
            <div className="global-facts-reader-actions">
              <button type="button" className="secondary-action" onClick={copyActiveGroup} disabled={!activeGroup || !draftContent}>复制</button>
              <button type="button" className="danger-action" onClick={deleteActiveGroup} disabled={!activeGroup || running || saving}>删除</button>
              <button type="button" className="primary-action" onClick={saveActiveGroup} disabled={!activeGroup || !dirty || running || saving}>保存</button>
            </div>
          </div>

          {activeGroup ? (
            <div className="global-facts-editor-grid">
              <div className="global-facts-edit-pane">
                <label>
                  <span>大项标题</span>
                  <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} disabled={running || saving} />
                </label>
                <MarkdownEditor
                  value={draftContent}
                  onChange={setDraftContent}
                  disabled={running || saving}
                  placeholder="填写后续正文需要统一使用的事实变量，例如人员、时间、型号、服务承诺等..."
                />
              </div>
              <MarkdownFullscreenViewer className="global-facts-preview-pane markdown-viewer" title={`${activeGroup.title}全屏预览`}>
                {draftContent.trim() ? (
                  <MarkdownRenderer allowRawHtml={false}>{draftContent}</MarkdownRenderer>
                ) : (
                  <p className="content-editor-empty">暂无预览内容</p>
                )}
              </MarkdownFullscreenViewer>
            </div>
          ) : (
            <div className="markdown-empty-state global-facts-empty">
              <strong>{hasOutline ? '等待全局事实生成' : '请先生成目录'}</strong>
              <p>{hasOutline ? '点击“开始解析”后，AI 会基于目录提前生成正文可能反复用到的短小事实变量。' : '目录生成完成后，点击“开始解析”生成全局事实。'}</p>
            </div>
          )}
        </article>
      </section>

      <SubjectReplacementCard
        value={subjectReplacements}
        onChange={onSubjectReplacementsChange}
        onConfirmIdentity={() => setIdentityDialogOpen(true)}
      />

      <Dialog.Root open={identityDialogOpen} onOpenChange={(open) => !identitySaving && setIdentityDialogOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="subject-identity-dialog" aria-describedby={undefined}>
            <div className="content-regenerate-card-head">
              <div>
                <Dialog.Title>确认投标主体与代称替换</Dialog.Title>
                <Dialog.Description>
                  系统会基于招标文件自动建议代称，确认后用于正文落库前的确定性替换。
                </Dialog.Description>
              </div>
              <Dialog.Close className="detail-help-close" type="button" aria-label="关闭主体确认弹窗" disabled={identitySaving}>×</Dialog.Close>
            </div>

            <div className="subject-identity-form-grid">
              <label>
                <span>我方公司全称</span>
                <input
                  value={bidderNameDraft}
                  onChange={(event) => setBidderNameDraft(event.target.value)}
                  placeholder="如：内蒙古思沃科技有限公司"
                  autoComplete="off"
                />
              </label>
              <label>
                <span>采购人/招标人全称</span>
                <input
                  value={buyerNameDraft}
                  onChange={(event) => setBuyerNameDraft(event.target.value)}
                  placeholder="系统会优先从 STEP 02 甲方信息带出"
                  autoComplete="off"
                />
              </label>
            </div>

            <div className="subject-identity-preview">
              {renderAliasCandidates('我方代称', subjectIdentity.bidder.aliases)}
              {renderAliasCandidates('采购人代称', subjectIdentity.buyer.aliases)}
            </div>

            {detectedAliases.length > 0 && (
              <div className="subject-identity-evidence-card">
                <span className="section-kicker">自动识别证据</span>
                <div className="subject-identity-evidence-list">
                  {detectedAliases.map((item) => (
                    <div className={`subject-identity-evidence-item${item.needsReview ? ' needs-review' : ''}`} key={`evidence-${item.group}-${item.alias}`}>
                      <div>
                        <strong>{item.alias}</strong>
                        <span>{item.group === 'bidder' ? '我方组' : '采购人组'} · {item.reason}</span>
                      </div>
                      {item.evidence && <p>{item.evidence}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="subject-identity-dialog-actions">
              <Dialog.Close
                className="secondary-action"
                type="button"
                disabled={identitySaving}
                onClick={() => {
                  if (subjectIdentityPromptKey) window.localStorage.setItem(subjectIdentityPromptKey, 'dismissed');
                }}
              >
                稍后处理
              </Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void confirmSubjectIdentity()} disabled={identitySaving}>
                {identitySaving ? '保存中...' : '确认使用'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default GlobalFactsPage;
