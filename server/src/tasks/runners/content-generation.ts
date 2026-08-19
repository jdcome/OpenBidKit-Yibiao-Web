// L4 runner: content-generation（技术方案正文生成）编排入口。
// 移植自 client/electron/services/contentGenerationTask.cjs:2946-6515（runContentGenerationTask）。
//
// 降级说明（web 版与桌面端的差异）：
//  - 插图阶段（插图规划/插图生成）已整体裁剪。
//  - Agent 路径（runAgentTaskWithRecoveredOutput / runContentAgentTask）已移植：直调注入的
//    agentService.runTask。sidecar 不可用时（agentService 为 no-op 或 boot 失败）走既有 self-guard：
//    runAgentOriginalCoverageRepairIfEnabled 的 guard 优雅 return；consistencyRepairMode==='agent'
//    时抛清晰错误（默认 'normal'）；原方案还原/扩写 Agent 经 runContentAgentTask 守卫抛错。
//  - happy LLM 路径（编排→生成→ensureMinimumWords→覆盖审计→一致性审计→去表格→finalize）完整可用。
//
// 适配点（桌面→web）：
//  - workspaceStore.loadTechnicalPlan/updateTechnicalPlan/readOriginalPlanMarkdown 均 async。
//    用 Rule 0 缓存 technicalPlan + Rule 1-8 重写所有 sync 读写。
//  - updateTask 第 2 参被引擎忽略（仅 truthiness 触发 persist），故 technicalPlan as unknown as boolean。
//  - pauseIfRequested 变 async，所有调用点 await。
//  - agentService 由 web engine 注入（M1-P7 sidecar）；不可用时各 agent 守卫据此降级，不崩主流程。

import type { TaskRunner } from '../types';
import {
  isAiQueueScopePausedError,
  isContentGenerationPausedError,
  isPauseLikeError,
  createContentGenerationPausedError,
  shouldUseAgentForMessages,
  normalizeContentGenerationRuntime,
  now,
  withSection,
  progressFor,
  taskStatusFor,
  createInitialSections,
  collectLeafContexts,
  countContentWords,
  singleLine,
  textHash,
  textMetrics,
  formatGlobalFactsForPrompt,
  formatGlobalFactTitlesForPrompt,
  formatBidAnalysisFactsForPrompt,
  splitOriginalPlanSegments,
  normalizeTableRequirement,
  normalizeConsistencyRepairMode,
  normalizeOriginalPlanCoverageRepairMode,
  normalizeOutlineWordControlSnapshot,
  computeGenerationWordTarget,
  normalizeContentConcurrency,
  normalizeImageConcurrency,
  isDeveloperModeEnabled,
  maxTablesForRequirement,
  pruneContentGenerationPlans,
  clearOutlineContent,
  countRetainedTablePlans,
  normalizeReferenceDocumentIds,
  createContentDeveloperLogger,
  createStoredContentPlan,
  normalizeStoredContentPlan,
  normalizeContentPlan,
  isStoredContentPlanReusableForTableRequirement,
  clearContentPlanTable,
  normalizeOriginalMaterial,
  createOutlineNodeMap,
  applyOutlineExpansionAdditions,
  normalizeOutlineExpansionResponse,
  validateOutlineExpansionResponse,
  buildOutlineExpansionMessages,
  buildOutlineExpansionRepairMessages,
  normalizeContentExpansionPatch,
  validateContentExpansionPatch,
  buildContentExpansionMessages,
  buildContentExpansionRepairMessages,
  applyContentExpansionPatch,
  buildChapterContentPlanMessages,
  validateContentPlan,
  buildChapterContentMessages,
  buildRestoredChapterContentMessages,
  stripRepeatedChapterTitle,
  normalizeGeneratedMarkdown,
  resolveKnowledgeContents,
  resolveSelectedFactsText,
  updateOutlineItemContent,
  normalizeLeafContentForSave,
  getMessagesContentLength,
  getTextContextLengthLimit,
  parseAgentJsonContent,
  buildOriginalMaterialRestoreMessages,
  normalizeOriginalRestoreAssignments,
  validateOriginalRestoreAssignments,
  buildOriginalRestoreRepairMessages,
  buildAgentOriginalMaterialRestorePrompt,
  buildAgentOriginalMaterialRestoreFiles,
  buildAgentRestoredChapterContentPrompt,
  buildAgentRestoredChapterContentFiles,
  buildOriginalCoverageAuditMessages,
  normalizeOriginalCoverageAuditResponse,
  validateOriginalCoverageAuditResponse,
  buildOriginalCoverageAuditJsonRepairMessages,
  buildOriginalCoverageRepairMessages,
  buildConsistencyAuditMessages,
  normalizeConsistencyAuditResponse,
  validateConsistencyAuditResponse,
  buildConsistencyAuditRepairMessages,
  buildConsistencyRepairMessages,
  normalizeConsistencyRepairResponse,
  validateConsistencyRepairResponse,
  buildConsistencyRepairJsonRepairMessages,
  applyConsistencyRepairPatches,
  extractContentTableBlocks,
  createTableCleanupBatches,
  buildTableCleanupMessages,
  normalizeTableCleanupResponse,
  validateTableCleanupResponse,
  containsContentTable,
  loadContentKnowledgeItems,
  loadContentKnowledgeContentMap,
  formatChapterPath,
  formatOriginalCoverageSources,
  escapeSectionAttribute,
  parseAgentSectionMarkdown,
  normalizeNewlines,
  compactError,
  waitForPromptCacheWarmup,
  pickDistributedTableTargets,
  orderExpansionCandidates,
  type ContentAiService,
  type LeafContext,
  type ContentSectionMap,
  type ContentPlan,
  type ChatMessage,
  type OutlineWordControlSnapshot,
} from '../utils/contentGenerationHelpers';
import { applySubjectReplacement, normalizeSubjectReplacements } from '../utils/subjectReplacement';
import { applyMirrorToneRewrite, normalizeMirrorTextForCarry } from '../utils/mirrorProcurement';

// ---- 本地常量（helpers 中为 module-private，entry 自带同值副本） ----

const MAX_OUTLINE_EXPANSION_ROUNDS = 3;
const OUTLINE_EXPANSION_STEPS_PER_ROUND = 6;
const OUTLINE_EXPANSION_TARGET_RATIO = 0.8;
const EARLY_CONTENT_PROBE_COUNT = 3;
const MIN_SECTION_EXPANSION_INCREMENT = 800;
const MAX_WORD_ADJUSTMENT_ROUNDS = 3;
const DEFAULT_SECTION_WORD_GUIDANCE = 3000;
const CONSISTENCY_AUDIT_GROUP_WORD_LIMIT = 300000;
const CONSISTENCY_REPAIR_MAX_ATTEMPTS = 2;
const ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS = 2;
const AGENT_CONTEXT_THRESHOLD_RATIO = 0.7;
const TABLE_REQUIREMENT_LABELS: Record<string, string> = {
  none: '不要',
  light: '少量',
  moderate: '适中',
  heavy: '大量',
};

// ---- 本地 applyRangeEdits（桌面 textEdit.cjs:439-465，web 未移植该工具） ----

function applyRangeEdits(
  content: string,
  edits: Array<{ start: number; end: number; newText: string }>,
): { content: string; edits: unknown[]; errors: string[] } {
  const source = String(content || '');
  const planned: Array<{ index: number; start: number; end: number; newText: string }> = [];
  const errors: string[] = [];
  for (const [index, edit] of edits.entries()) {
    const start = Number(edit?.start);
    const end = Number(edit?.end);
    const newText = String(edit?.newText ?? '');
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      errors.push(`rangeEdit[${index}] start/end 必须是整数`);
      continue;
    }
    if (start < 0 || end < start || end > source.length) {
      errors.push(`rangeEdit[${index}] range 越界或无效：${start}-${end}`);
      continue;
    }
    if (source.slice(start, end) === newText) {
      errors.push(`rangeEdit[${index}] 替换内容没有变化`);
      continue;
    }
    planned.push({ index, start, end, newText });
  }
  const ordered = [...planned].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) {
      errors.push(`edit ranges overlap: ${ordered[i - 1].start}-${ordered[i - 1].end} and ${ordered[i].start}-${ordered[i].end}`);
      break;
    }
  }
  if (errors.length) {
    return { content: source, edits: [], errors };
  }
  if (!planned.length) {
    return { content: source, edits: [], errors: [] };
  }
  let nextContent = source;
  const applied: unknown[] = [];
  const sorted = [...planned].sort((a, b) => b.start - a.start || b.end - a.end);
  for (const item of sorted) {
    nextContent = `${nextContent.slice(0, item.start)}${item.newText}${nextContent.slice(item.end)}`;
    applied.unshift({ status: 'applied', index: item.index, strategy: 'range', start: item.start, end: item.end });
  }
  return { content: nextContent, edits: applied, errors: [] };
}

// ---- 模块级 worker pool（cjs:2826-2880） ----

async function runWorkerPool(options: {
  limit: number;
  getNextItem: () => unknown;
  worker: (item: unknown) => Promise<unknown>;
  shouldStop?: () => boolean;
  onItemStart?: (item: unknown, activeCount: number) => void;
  onItemComplete?: (item: unknown, result: unknown, activeCount: number) => Promise<void> | void;
}): Promise<void> {
  const workerCount = Math.max(1, Math.floor(Number(options.limit) || 1));
  let activeCount = 0;
  let firstError: unknown = null;

  async function runWorker(): Promise<void> {
    while (true) {
      if (firstError || options.shouldStop?.()) {
        return;
      }
      const item = options.getNextItem();
      if (!item) {
        return;
      }
      activeCount += 1;
      options.onItemStart?.(item, activeCount);
      try {
        const result = await options.worker(item);
        activeCount -= 1;
        await options.onItemComplete?.(item, result, activeCount);
      } catch (error) {
        activeCount -= 1;
        if (!firstError) {
          firstError = error;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (firstError) {
    throw firstError;
  }
}

async function runItemsWithWorkerPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<unknown>,
  shouldStop?: () => boolean,
): Promise<void> {
  const workerCount = Math.min(Math.max(1, Math.floor(Number(limit) || 1)), Math.max(1, items.length));
  let nextIndex = 0;
  await runWorkerPool({
    limit: workerCount,
    shouldStop,
    getNextItem() {
      if (nextIndex >= items.length) {
        return null;
      }
      const item = items[nextIndex];
      nextIndex += 1;
      return item;
    },
    worker: worker as (item: unknown) => Promise<unknown>,
  });
}

// ---- workspaceStore 接口（Rule 12） ----

interface ContentWorkspaceStore {
  loadTechnicalPlan(): Promise<Record<string, unknown>>;
  updateTechnicalPlan(partial: Record<string, unknown>): Promise<Record<string, unknown>>;
  readOriginalPlanMarkdown(): Promise<string>;
  clearMermaidCache?(): void;
}

// ---- 入口 runner ----

export const runContentGenerationTask: TaskRunner = async (ctx) => {
  // aiService 使用 any：ContentAiService 不含 chat() 等桌面方法，且 collectJsonResponse
  // 返回 unknown 需大量 cast；degraded port 用 any 减少噪音。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiService = ctx.aiService as any;
  const agentService = ctx.agentService as any;
  const knowledgeBaseService = ctx.knowledgeBaseService as any;
  const workspaceStore = ctx.workspaceStore as unknown as ContentWorkspaceStore;
  const { updateTask, payload, taskControl, previousState } = ctx;

  const resume = Boolean(payload.resume);
  // Rule 0: entry cache
  let technicalPlan: Record<string, any> = resume ? ((previousState as Record<string, any>) || {}) : ((await workspaceStore.loadTechnicalPlan()) || {});

  // storedPlan: 初始加载快照（setup 阶段只读，等价于 cjs storedPlan）
  const storedPlan = technicalPlan;
  let outlineData: Record<string, any> = storedPlan.outlineData || {};

  if (!outlineData.outline?.length) {
    throw new Error('请先生成目录，再生成正文');
  }

  const globalFacts = Array.isArray(storedPlan.globalFacts) ? storedPlan.globalFacts : [];
  const globalFactsText = formatGlobalFactsForPrompt(globalFacts);
  if (!globalFactsText || storedPlan.globalFactsTask?.status !== 'success') {
    throw new Error('请先完成全局事实设定，再生成正文');
  }
  const globalFactTitlesText = formatGlobalFactTitlesForPrompt(globalFacts);
  const allowedFactTitles = new Set(globalFacts.map((group: any) => singleLine(group?.title)).filter(Boolean)) as Set<string>;
  const bidAnalysisFactsText = formatBidAnalysisFactsForPrompt(storedPlan as Record<string, unknown>);
  // 代称替换表 + 我方公司全称：落库前对正文 content 做确定性替换（Block B），并给正文生成/审计注入投标响应语气（Block C）。旧项目列为空 → no-op，行为同现状。
  const subjectReplacementRow = await ctx.prisma.project.findUnique({
    where: { id: ctx.projectId },
    select: { subjectReplacements: true, bidderName: true },
  });
  const subjectReplacements = normalizeSubjectReplacements(subjectReplacementRow?.subjectReplacements);
  const projectBidderName = String(subjectReplacementRow?.bidderName || '').trim();
  const isExpansionWorkflow = storedPlan.workflowKind === 'existing-plan-expansion';
  let originalPlanMarkdown = '';
  let originalPlanSegments: any[] = [];
  if (isExpansionWorkflow) {
    if (!storedPlan.originalPlanFile) {
      throw new Error('请先上传原方案，再生成正文');
    }
    if (!workspaceStore.readOriginalPlanMarkdown) {
      throw new Error('原方案读取服务尚未初始化');
    }
    originalPlanMarkdown = await workspaceStore.readOriginalPlanMarkdown();
    if (!String(originalPlanMarkdown || '').trim()) {
      throw new Error('请先上传原方案，再生成正文');
    }
    originalPlanSegments = splitOriginalPlanSegments(originalPlanMarkdown);
    if (!originalPlanSegments.length) {
      throw new Error('原方案正文为空，无法执行已有方案扩写');
    }
  }
  const originalPlanSegmentById = new Map(originalPlanSegments.map((segment: any) => [segment.id, segment]));

  const projectOverview = outlineData.project_overview || storedPlan.projectOverview || '';
  const techRequirements = storedPlan.techRequirements || '';
  if (resume && storedPlan.contentGenerationTask?.status !== 'paused') {
    throw new Error('没有可继续的已暂停正文生成任务');
  }
  let contentRuntime = normalizeContentGenerationRuntime(resume ? storedPlan.contentGenerationRuntime : {});
  const retryContentCorrection = !resume && Boolean(payload.retryContentCorrection ?? payload.retry_content_correction);
  const regenerate = !resume && !retryContentCorrection && Boolean(payload.regenerate);
  const targetItemId: string = resume ? contentRuntime.target_item_id : String(payload.targetItemId || '').trim();
  if (retryContentCorrection && targetItemId) {
    throw new Error('单小节重新生成不支持重试内容矫正');
  }
  const fullRegenerate = regenerate && !targetItemId;
  if (fullRegenerate) {
    workspaceStore.clearMermaidCache?.();
    outlineData = { ...outlineData, outline: clearOutlineContent(outlineData.outline) };
  }

  let leaves = collectLeafContexts(outlineData.outline);
  if (!leaves.length) {
    throw new Error('当前目录没有可生成正文的小节');
  }
  const regenerateRequirement = resume ? contentRuntime.regenerate_requirement : String(payload.requirement || '').trim();
  const generationOptions = payload.generationOptions || payload.generation_options || storedPlan.contentGenerationOptions || {};
  const aiConfig = aiService.getConfig ? aiService.getConfig() : {};
  const contentConcurrency = normalizeContentConcurrency(aiConfig.concurrency_limit);
  const imageConcurrency = normalizeImageConcurrency(aiConfig.image_model?.concurrency_limit);
  const developerModeEnabled = isDeveloperModeEnabled(aiService);
  const tableRequirement = normalizeTableRequirement(generationOptions.tableRequirement ?? generationOptions.table_requirement);
  let maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
  const outlineWordControl = normalizeOutlineWordControlSnapshot((storedPlan as Record<string, unknown>).outlineWordControlSnapshot);
  const wordControl: OutlineWordControlSnapshot = targetItemId
    ? normalizeOutlineWordControlSnapshot(undefined)
    : outlineWordControl;
  const minimumWords = wordControl.minimumWords;
  const maximumWords = wordControl.maximumWords;
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan as Record<string, unknown>);
  const enableConsistencyAudit = Boolean(generationOptions.enableConsistencyAudit ?? generationOptions.enable_consistency_audit ?? true);
  const requestedConsistencyRepairMode = normalizeConsistencyRepairMode(generationOptions.consistencyRepairMode ?? generationOptions.consistency_repair_mode);
  const consistencyRepairMode = targetItemId ? 'normal' : requestedConsistencyRepairMode;
  const enableOriginalPlanCoverageAudit = isExpansionWorkflow && Boolean(generationOptions.enableOriginalPlanCoverageAudit ?? generationOptions.enable_original_plan_coverage_audit ?? false);
  const requestedOriginalPlanCoverageRepairMode = isExpansionWorkflow
    ? normalizeOriginalPlanCoverageRepairMode(generationOptions.originalPlanCoverageRepairMode ?? generationOptions.original_plan_coverage_repair_mode)
    : 'agent';
  const originalPlanCoverageRepairMode = isExpansionWorkflow && !targetItemId ? requestedOriginalPlanCoverageRepairMode : 'normal';
  const contentStats: Record<string, any> = {
    phase: 'planning',
    planning_total: 0,
    planning_completed: 0,
    generation_total: 0,
    generation_completed: 0,
    outline_expansion_total: MAX_OUTLINE_EXPANSION_ROUNDS,
    outline_expansion_completed: 0,
    outline_expansion_step_total: MAX_OUTLINE_EXPANSION_ROUNDS * OUTLINE_EXPANSION_STEPS_PER_ROUND,
    outline_expansion_step_completed: 0,
    outline_expansion_round: 0,
    outline_expansion_round_total: MAX_OUTLINE_EXPANSION_ROUNDS,
    outline_expansion_step_label: '',
    minimum_words: minimumWords,
    maximum_words: maximumWords,
    section_words: wordControl.sectionWords,
    strict_section_words: wordControl.strictSectionWords,
    current_words: 0,
    section_adjustment_total: 0,
    section_adjustment_completed: 0,
    section_adjustment_item_id: '',
    section_adjustment_round: 0,
    total_adjustment_round: 0,
    total_adjustment_mode: '',
    total_adjustment_target_words: 0,
    audit_group_total: 0,
    audit_group_completed: 0,
    audit_conflict_total: 0,
    audit_fix_total: 0,
    audit_fix_completed: 0,
    audit_fix_failed: 0,
    audit_repair_mode: enableConsistencyAudit ? consistencyRepairMode : '',
    audit_agent_step_total: 0,
    audit_agent_step_completed: 0,
    audit_agent_step_label: '',
    audit_agent_changed_sections: 0,
    audit_agent_failed_sections: 0,
    table_cleanup_total: 0,
    table_cleanup_completed: 0,
    table_cleanup_rewritten: 0,
    table_cleanup_skipped: 0,
    illustration_planning_step_total: 0,
    illustration_planning_step_completed: 0,
    illustration_planning_step_label: '',
    illustration_candidate_ai: 0,
    illustration_candidate_mermaid: 0,
    illustration_candidate_html: 0,
    illustration_selected_ai: 0,
    illustration_selected_mermaid: 0,
    illustration_selected_html: 0,
    illustration_generation_total: 0,
    illustration_generation_completed: 0,
    illustration_generation_ai_total: 0,
    illustration_generation_ai_completed: 0,
    illustration_generation_mermaid_total: 0,
    illustration_generation_mermaid_completed: 0,
    illustration_generation_html_total: 0,
    illustration_generation_html_completed: 0,
    illustration_generation_step_label: '',
  };
  contentRuntime = normalizeContentGenerationRuntime({
    ...contentRuntime,
    target_item_id: targetItemId,
    regenerate_requirement: regenerateRequirement,
  });
  const contentPlans = new Map<string, any>();
  let storedContentPlans = pruneContentGenerationPlans(fullRegenerate ? {} : storedPlan.contentGenerationPlans, leaves);
  let knowledgeItems: any[] = [];
  let allowedKnowledgeItemIds = new Set<string>();
  let knowledgeContentMap = new Map<string, { content: string }>();
  let sections = createInitialSections(leaves, fullRegenerate ? {} : storedPlan.contentGenerationSections);
  const touchedItemIds = new Set<string>(contentRuntime.touched_item_ids);
  let tasksToRun = leaves.filter(({ item }: any) => {
    const section = sections[item.id];
    const content = section?.content || item.content || '';
    const originalState = getOriginalMaterialRuntimeState(item);
    return regenerate || section?.status === 'error' || !String(content).trim() || originalState.needsOptimization || originalState.needsRestoreRepair;
  });
  if (targetItemId) {
    const targetSection = sections[targetItemId];
    tasksToRun = resume && targetSection?.status === 'success' && touchedItemIds.has(targetItemId)
      ? []
      : leaves.filter(({ item }: any) => item.id === targetItemId);
    if (!tasksToRun.length && (!resume || targetSection?.status !== 'success')) {
      throw new Error('未找到要重新生成的正文小节');
    }
  }

  if (retryContentCorrection) {
    const successfulIds = leaves
      .filter(({ item }: any) => {
        const section = sections[item.id] || {};
        return section.status === 'success';
      })
      .map(({ item }: any) => item.id);
    if (successfulIds.length !== leaves.length) {
      throw new Error('只有正文全部生成成功后，才能重试内容矫正');
    }
    successfulIds.forEach((itemId: string) => touchedItemIds.add(itemId));
    tasksToRun = [];
  }

  const retryItemIds = new Set<string>(tasksToRun
    .filter(({ item }: any) => sections[item.id]?.status === 'error')
    .map(({ item }: any) => item.id));

  for (const { item } of tasksToRun) {
    const itemId = String(item.id || '');
    const existing = sections[itemId] || {};
    const content = existing.content || item.content || '';
    sections[itemId] = {
      id: itemId,
      title: item.title || '未命名章节',
      status: 'idle',
      content,
      error: undefined,
      updated_at: now(),
    };
  }

  let runLimits: { maxTablesForRun: number | null; retainedTableCount: number } = {
    maxTablesForRun: maxTables,
    retainedTableCount: 0,
  };

  function refreshRunLimits(targets = tasksToRun): { maxTablesForRun: number | null; retainedTableCount: number } {
    const taskItemIds = new Set(targets.map(({ item }: any) => item.id));
    maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
    const retainedTableCount = maxTables === null ? 0 : countRetainedTablePlans(storedContentPlans, taskItemIds);
    runLimits = {
      maxTablesForRun: maxTables === null ? null : Math.max(0, maxTables - retainedTableCount),
      retainedTableCount,
    };
    return runLimits;
  }

  refreshRunLimits(tasksToRun);
  let logs = [retryContentCorrection
    ? `准备重试内容矫正，共 ${leaves.length} 个已生成小节。`
    : resume
      ? `继续已暂停的正文生成任务，共 ${leaves.length} 个小节。`
      : `准备生成正文，共 ${leaves.length} 个小节。`];
  if (targetItemId) {
    logs = [`准备重新生成正文小节：${targetItemId}。`];
  }
  logs = [...logs, `文本模型并发上限：${contentConcurrency}。`];
  logs = [...logs, tableRequirement === 'heavy'
    ? '表格需求：大量，保持现有表格编排逻辑。'
    : tableRequirement === 'none'
      ? '表格需求：不要，本次正文编排不会安排表格。'
      : `表格需求：${TABLE_REQUIREMENT_LABELS[tableRequirement]}，全文最多 ${maxTables} 个表格，本轮最多新增 ${runLimits.maxTablesForRun} 个。`];
  if (wordControl.enabled) {
    logs = [...logs, `目录字数配置已生效：最少 ${minimumWords || '不限制'} 字，最多 ${maximumWords || '不限制'} 字，每小节 ${wordControl.sectionWords || '不控制'} 字${wordControl.strictSectionWords ? '（强控）' : ''}。`];
  }
  if (minimumWords > 0) {
    logs = [...logs, `最低字数来自 STEP03 目录配置，将在采样预估后补目录，并在正文生成后扩写补足。`];
  }
  if (maximumWords > 0) {
    logs = [...logs, `最多字数来自 STEP03 目录配置，正文生成后如超过上限将尝试精简压缩。`];
  }
  if (wordControl.strictSectionWords) {
    logs = [...logs, `强控小节字数已启用：每小节目标 ${wordControl.sectionWords} 字，允许范围 ${wordControl.sectionMinimumWords}-${wordControl.sectionMaximumWords} 字。`];
  }
  logs = [...logs, enableConsistencyAudit
    ? `全文一致性审计已启用，正文扩写完成后将使用${consistencyRepairMode === 'agent' ? ' Agent 修复' : '普通修复'}检查并修复事实冲突。`
    : '全文一致性审计未启用。'];
  if (isExpansionWorkflow) {
    logs = [...logs, `已有方案扩写模式：已读取原方案并拆分为 ${originalPlanSegments.length} 个原文段。`];
    logs = [...logs, enableOriginalPlanCoverageAudit
      ? targetItemId
        ? '原方案覆盖审计已启用，本次将使用普通模式检查并修复当前小节的原文保留情况。'
        : `原方案覆盖审计已启用，本次将使用${originalPlanCoverageRepairMode === 'agent' ? ' Agent' : '普通模式'}检查并补回原文保留情况。`
      : '原方案覆盖审计未启用。'];
  }

  const developerLogger: any = createContentDeveloperLogger(aiService, {
    name: targetItemId ? `content-generation-${targetItemId}` : 'content-generation',
    meta: {
      mode: targetItemId ? 'single-section' : 'full',
      target_item_id: targetItemId || '',
      resume,
      regenerate,
      full_regenerate: fullRegenerate,
      retry_content_correction: retryContentCorrection,
      leaf_count: leaves.length,
      task_count: tasksToRun.length,
      text_concurrency_limit: contentConcurrency,
      table_requirement: tableRequirement,
      minimum_words: minimumWords,
      maximum_words: maximumWords,
      section_words: wordControl.sectionWords,
      strict_section_words: wordControl.strictSectionWords,
      word_control: wordControl,
      enable_consistency_audit: enableConsistencyAudit,
      requested_consistency_repair_mode: requestedConsistencyRepairMode,
      consistency_repair_mode: consistencyRepairMode,
      enable_original_plan_coverage_audit: enableOriginalPlanCoverageAudit,
      requested_original_plan_coverage_repair_mode: requestedOriginalPlanCoverageRepairMode,
      original_plan_coverage_repair_mode: originalPlanCoverageRepairMode,
      original_plan_segment_count: originalPlanSegments.length,
      generation_options: generationOptions,
    },
  });

  function writeDeveloperLog(event: string, payload: Record<string, unknown> = {}) {
    try {
      developerLogger.write(event, payload);
    } catch {
      // 调试日志不能影响正文生成主流程。
    }
  }

  function agentErrorDiagnostics(error: any): Record<string, unknown> {
    return {
      error: error?.message || String(error || '未知错误'),
      name: error?.name || '',
      cause: error?.cause?.message || error?.cause?.code || error?.openCodeCause || '',
      stack: error?.stack || '',
      agent_task_id: error?.agentTaskId || '',
      agent_title: error?.agentTitle || '',
      agent_workspace_dir: error?.agentWorkspaceDir || '',
      agent_runtime_root: error?.agentRuntimeRoot || '',
      agent_output_file: error?.agentOutputFile || '',
      agent_output_path: error?.agentOutputPath || '',
      agent_partial_output_chars: error?.agentPartialOutputChars || String(error?.agentPartialOutput || '').length,
      agent_validation_failed: Boolean(error?.agentValidationFailed),
      agent_retry_attempts: Array.isArray(error?.agentRetryAttempts) ? error.agentRetryAttempts : [],
      opencode_route: error?.openCodeRoute || '',
      opencode_method: error?.openCodeMethod || '',
      opencode_status: error?.openCodeStatus || 0,
      opencode_duration_ms: error?.openCodeDurationMs || 0,
      opencode_cause: error?.openCodeCause || '',
      opencode_request_log: Array.isArray(error?.openCodeRequestLog) ? error.openCodeRequestLog : [],
      opencode_stderr_tail: error?.openCodeStderrTail || '',
    };
  }

  function isAgentBusyResult(result: any): boolean {
    return result?.status === 'busy' || result?.skipped === true;
  }

  function createAgentActivityProgressHandler(updateProgress: any, step: number, fallbackLabel: string): (event: any) => void {
    let lastKey = '';
    return (event: any = {}) => {
      const message = String(event.message || '').trim();
      if (!message || event.visible === false) return;
      const key = `${event.stage || ''}:${message}`;
      if (key === lastKey) return;
      lastKey = key;
      logs = [...logs, `Agent 实时进度：${message}`];
      updateProgress(step, message || fallbackLabel);
    };
  }

  // Agent 任务（移植自 contentGenerationTask.cjs:3264-3505）。
  // runAgentTaskWithRecoveredOutput：直调 agentService.runTask；busy 透传，失败时若 error 带
  // agentPartialOutput（runtimeService 在任务中途崩溃/超时时附带 output_file 已写内容）且与种子不同则兜底返回。
  // runContentAgentTask：包一层 pause 守卫（AbortController + 1s 监听暂停）+ busy/空输出校验，返回 { agentResult, outputContent }。
  async function runAgentTaskWithRecoveredOutput(payload: any, eventPrefix?: string): Promise<any> {
    function normalizeAgentFilePath(value: any): string {
      return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(\.\/)+/, '').toLowerCase();
    }
    function findSeededOutputContent(): string | null {
      const outputPath = normalizeAgentFilePath(payload.output_file || '');
      if (!outputPath) return null;
      const seededOutput = (Array.isArray(payload.files) ? payload.files : [])
        .find((file: any) => normalizeAgentFilePath(file?.path) === outputPath);
      return seededOutput ? String(seededOutput.content || '') : null;
    }

    try {
      const result = await agentService.runTask(payload);
      if (isAgentBusyResult(result)) {
        writeDeveloperLog(`${eventPrefix}.opencode.busy`, {
          message: result?.message || 'Agent 正在处理其他任务',
          active_task: result?.active_task || null,
        });
        return result;
      }
      writeDeveloperLog(`${eventPrefix}.opencode.done`, {
        agent_task_id: result?.task_id || '',
        agent_session_id: result?.session_id || '',
        agent_workspace_dir: result?.workspace_dir || '',
        agent_runtime_root: result?.runtime_root || '',
        output_file: result?.output_file || '',
        output_metrics: textMetrics(result?.output_content || ''),
        opencode_request_log: result?.opencode_request_log || [],
        opencode_stderr_tail: result?.opencode_stderr_tail || '',
      });
      return result;
    } catch (error: any) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        throw error;
      }
      const diagnostics = agentErrorDiagnostics(error);
      writeDeveloperLog(`${eventPrefix}.opencode.error`, diagnostics);
      if (error?.agentValidationFailed) {
        throw error;
      }
      const recoveredOutput = String(error?.agentPartialOutput || '').trim();
      if (!recoveredOutput) {
        throw error;
      }
      const seededOutputContent = findSeededOutputContent();
      if (seededOutputContent !== null
        && normalizeNewlines(recoveredOutput).trim() === normalizeNewlines(seededOutputContent).trim()) {
        writeDeveloperLog(`${eventPrefix}.output.recovered_rejected`, {
          ...diagnostics,
          reason: 'same_as_seeded_output',
          output_metrics: textMetrics(recoveredOutput),
        });
        throw error;
      }
      writeDeveloperLog(`${eventPrefix}.output.recovered`, {
        ...diagnostics,
        output_metrics: textMetrics(recoveredOutput),
      });
      return {
        success: true,
        recovered: true,
        task_id: error?.agentTaskId || '',
        title: error?.agentTitle || payload.title || 'Agent 任务',
        workspace_dir: error?.agentWorkspaceDir || '',
        runtime_root: error?.agentRuntimeRoot || '',
        output_file: error?.agentOutputFile || payload.output_file || '',
        output_content: recoveredOutput,
        assistant_text: '',
        diff: [],
        session_id: '',
        retry_count: (diagnostics.agent_retry_attempts as any[]).length,
        retry_attempts: diagnostics.agent_retry_attempts,
        opencode_request_log: diagnostics.opencode_request_log,
        opencode_stderr_tail: diagnostics.opencode_stderr_tail,
      };
    }
  }

  async function runContentAgentTask(options: any): Promise<{ agentResult: any; outputContent: string }> {
    const { title, prompt, outputFile, files, eventPrefix, activityLabel, timeoutMs, startPauseMessage, resultPauseMessage, pausedLogMessage, validateOutput } = options;
    if (!agentService?.runTask) {
      writeDeveloperLog(`${eventPrefix}.unavailable`, { title, output_file: outputFile });
      throw new Error(`Agent 服务尚未初始化，无法执行${title}`);
    }

    function updateContentAgentProgress(_step: number, _label: string): void {
      void updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    }

    const agentAbortController = new AbortController();
    let pauseWatcher: ReturnType<typeof setInterval> | null = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested(): void {
      if (!isPauseRequested()) return;
      if (!pauseLogged) {
        pauseLogged = true;
        logs = [...logs, `已请求暂停${title}，正在取消本轮 Agent 任务。`];
        updateContentAgentProgress(0, `正在取消${title}，继续后将重新执行`);
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      await pauseIfRequested(startPauseMessage || `正文生成已在${title}开始前暂停，本次 Agent 未启动；继续后将重新执行。`);
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title,
        prompt,
        output_file: outputFile,
        files,
        timeout_ms: timeoutMs || 30 * 60 * 1000,
        max_retries: 1,
        signal: agentAbortController.signal,
        validateOutput: async (candidate: any, context: any) => {
          const outputContent = String(candidate?.output_content || '').trim();
          if (!outputContent) {
            throw new Error(`Agent 未返回 ${outputFile}`);
          }
          if (typeof validateOutput === 'function') {
            return validateOutput(candidate, context);
          }
          return null;
        },
        onActivity: createAgentActivityProgressHandler(updateContentAgentProgress, 0, activityLabel || title),
      }, eventPrefix);
      if (isAgentBusyResult(agentResult)) {
        writeDeveloperLog(`${eventPrefix}.busy`, { active_task: agentResult?.active_task || null });
        throw new Error(`Agent 正在处理其他任务，无法执行${title}`);
      }
      await pauseIfRequested(resultPauseMessage || `正文生成已在${title}结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。`);

      const outputContent = String(agentResult?.output_content || '').trim();
      if (!outputContent) {
        writeDeveloperLog(`${eventPrefix}.empty_output`, { agent_result: agentResult, output_file: outputFile });
        throw new Error(`Agent 未返回 ${outputFile}`);
      }
      return { agentResult, outputContent };
    } catch (error: any) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        logs = [...logs, pausedLogMessage || `${title}已暂停：本轮 Agent 已取消并清理，继续后将重新执行。`];
        writeDeveloperLog(`${eventPrefix}.paused`, {
          title,
          output_file: outputFile,
          error: error?.message || String(error),
        });
        updateContentAgentProgress(0, `${title}已暂停，继续后将重新执行`);
        await pauseIfRequested(`正文生成已在${title}阶段暂停，本次 Agent 已取消；继续后将重新执行。`);
      }
      throw error;
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  writeDeveloperLog('content.task.started', {
    sections: leaves.map(({ item }: any) => ({ id: item.id, title: item.title || '未命名章节' })),
    tasks_to_run: tasksToRun.map(({ item }: any) => item.id),
  });

  async function appendDeveloperLog(message: string): Promise<void> {
    if (!developerModeEnabled) {
      return;
    }
    logs = [...logs, message];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
  }

  knowledgeItems = loadContentKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, (message: string) => {
    logs = [...logs, message];
  });
  allowedKnowledgeItemIds = new Set(knowledgeItems.map((item: any) => item.id));
  knowledgeContentMap = loadContentKnowledgeContentMap(knowledgeBaseService, referenceKnowledgeDocumentIds, (message: string) => {
    logs = [...logs, message];
  });

  function getLeafContentForWords(item: any): string {
    return sections[item.id]?.content || item.content || '';
  }

  function countTotalContentWords(): number {
    return leaves.reduce((sum: number, { item }: any) => sum + countContentWords(getLeafContentForWords(item)), 0);
  }

  function leafWordStats(): any[] {
    return leaves.map((context: any) => ({
      ...context,
      content: getLeafContentForWords(context.item),
      words: countContentWords(getLeafContentForWords(context.item)),
    }));
  }

  function statsSnapshot(): { content: Record<string, unknown> } {
    contentStats.generation_completed = leaves.filter(({ item }: any) => ['success', 'error'].includes(sections[item.id]?.status)).length;
    contentStats.current_words = countTotalContentWords();
    contentStats.minimum_words = minimumWords;
    contentStats.maximum_words = maximumWords;
    contentStats.section_words = wordControl.sectionWords;
    contentStats.strict_section_words = wordControl.strictSectionWords;
    return { content: { ...contentStats } };
  }

  function syncRuntime(partial: Record<string, unknown> = {}): any {
    contentRuntime = normalizeContentGenerationRuntime({
      ...contentRuntime,
      ...partial,
      phase: partial.phase || contentStats.phase,
      touched_item_ids: Array.from(touchedItemIds),
      updated_at: now(),
    });
    return contentRuntime;
  }

  // ---- 节流落库：运行期所有 updateTechnicalPlan 写合并为单写线程 ----
  // 原 24 worker 每节直写 updateTechnicalPlan 撑爆连接池 + 热行锁（maxWait 事务报错）且每节阻塞 1-3s。
  // 改为：热路径 schedulePersist() 只标脏+计时（fire-and-forget），timer 每 N ms 合并 flush 一次。
  // flush 快照直接取共享可变引用（sections/outlineData/storedContentPlans），天然含全部累积变更，无需合并 patch。
  // applyPartial 是字段级 merge，与低频 cold 直写唯一竞争字段 contentGenerationRuntime 会收敛；
  // sections/plans/outlineData 不会被 clobber。LLM 上下文纯内存，不受影响。
  let persistDirty = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistInFlight: Promise<void> | null = null;
  const PERSIST_FLUSH_INTERVAL_MS = 3000;

  async function runPersistFlush(): Promise<void> {
    const patch = {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: syncRuntime(),
    };
    try {
      const saved = await workspaceStore.updateTechnicalPlan(patch);
      if (saved) technicalPlan = saved as Record<string, any>;
    } catch (err: any) {
      // 落库失败不致命：UI 进度走 updateTask(SSE) 不依赖此写；下次 flush 自动重试最新快照。
      writeDeveloperLog('content.persist.error', { error: err?.message || String(err) });
    }
  }

  // 热路径：标脏 + 计时（fire-and-forget）。已计时或在飞则不重复 arm。
  function schedulePersist(): void {
    persistDirty = true;
    if (persistTimer || persistInFlight) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!persistDirty) return;
      persistDirty = false;
      persistInFlight = runPersistFlush().finally(() => {
        persistInFlight = null;
        if (persistDirty) schedulePersist(); // flush 期间又脏 → 重排
      });
    }, PERSIST_FLUSH_INTERVAL_MS);
  }

  // 取消计时器并等在飞的 flush 完成（不额外写）。用于 cold 显式全量写之前止住后台写。
  async function drainPersist(): Promise<void> {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (persistInFlight) await persistInFlight;
  }

  // 排空后立即再写一次最新快照。用于错误/暂停路径的崩溃恢复落库。
  async function flushPersistNow(): Promise<void> {
    await drainPersist();
    persistDirty = false;
    await runPersistFlush();
  }

  function isPauseRequested(): boolean {
    return Boolean(taskControl?.isPauseRequested?.());
  }

  async function persistPausedContentGeneration(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。'): Promise<void> {
    logs = [...logs, message];
    const runtime = syncRuntime();
    // Rule 8: 3-stage
    await drainPersist(); // 止住后台节流写，避免与本次全量写交错或事后覆盖
    const task = await updateTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false });
    technicalPlan = await workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
      contentGenerationTask: task,
    });
    await updateTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }, technicalPlan as unknown as boolean);
  }

  async function pauseIfRequested(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。'): Promise<void> {
    if (!isPauseRequested()) {
      return;
    }
    await persistPausedContentGeneration(message);
    throw createContentGenerationPausedError();
  }

  // 纯函数闭包（function 声明提升，可在前方 tasksToRun 等处安全引用）

  function getOriginalMaterialRuntimeState(itemOrId: any): any {
    const itemId = typeof itemOrId === 'string' ? itemOrId : String(itemOrId?.id || '').trim();
    const item = typeof itemOrId === 'string' ? leaves.find((context: any) => context.item.id === itemId)?.item : itemOrId;
    const plan = contentPlans.get(itemId) || getStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
    const originalMaterial = normalizeOriginalMaterial(plan.original_material);
    const sourceSegments = originalMaterial.source_ids.map((sourceId: string) => originalPlanSegmentById.get(sourceId)).filter(Boolean);
    const allSourcesValid = Boolean(originalMaterial.source_ids.length) && sourceSegments.length === originalMaterial.source_ids.length;
    const content = sections[itemId]?.content || item?.content || '';
    const hasContent = Boolean(String(content || '').trim());
    const validRestored = Boolean(originalMaterial.restored && allSourcesValid && hasContent);
    const needsRestoreRepair = Boolean(originalMaterial.restored && !validRestored);
    return {
      plan,
      originalMaterial,
      sourceSegments,
      allSourcesValid,
      content,
      hasContent,
      validRestored,
      needsRestoreRepair,
      canRebuildRestoredContent: Boolean(originalMaterial.restored && allSourcesValid && !hasContent),
      needsOptimization: Boolean(validRestored && !originalMaterial.optimized),
    };
  }

  function buildOriginalMaterialFromSegments(segments: any[], previous: Record<string, unknown> = {}): any {
    const restoredContent = segments.map((segment: any) => segment.content).join('\n\n').trim();
    return normalizeOriginalMaterial({
      restored: true,
      optimized: false,
      source_ids: segments.map((segment: any) => segment.id),
      source_titles: segments.map((segment: any) => segment.title_path?.join(' > ') || segment.id),
      source_hashes: segments.map((segment: any) => segment.hash),
      restored_chars: restoredContent.length,
      restored_at: previous.restored_at || now(),
    });
  }

  function getStoredContentPlan(itemId: string): any {
    return normalizeStoredContentPlan(storedContentPlans[itemId]);
  }

  function applyCurrentTableRequirementToPlan(plan: any): any {
    const normalizedPlan = normalizeContentPlan(plan, allowedKnowledgeItemIds, allowedFactTitles);
    return tableRequirement === 'none' ? clearContentPlanTable(normalizedPlan) : normalizedPlan;
  }

  function getReusableStoredContentPlan(itemId: string): any {
    const storedContentPlan = getStoredContentPlan(itemId);
    if (!storedContentPlan || !isStoredContentPlanReusableForTableRequirement(storedContentPlan, tableRequirement)) {
      return null;
    }
    return {
      ...storedContentPlan,
      plan: applyCurrentTableRequirementToPlan(storedContentPlan.plan),
    };
  }

  function getContentPlanForItem(itemId: string): any {
    const plan = contentPlans.get(itemId) || getReusableStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
    contentPlans.set(itemId, plan);
    return plan;
  }

  // 代称替换：归一化之后、落库之前，对正文 content 套一层确定性代称→全称替换。
  // 只作用于正文 content；title/description/contentPlan 不经此函数，不受影响。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalizeForSave = (content: any, item: any): string =>
    applySubjectReplacement(normalizeLeafContentForSave(content, item), subjectReplacements);

  async function saveSection(item: any, partial: any, contentForOutline: any, taskPartial: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const hasPartialContent = Object.prototype.hasOwnProperty.call(partial || {}, 'content');
    const hasOutlineContent = contentForOutline !== undefined;
    const nextPartial = { ...(partial || {}) };
    if (hasPartialContent) {
      nextPartial.content = normalizeForSave(nextPartial.content, item);
    }
    sections = withSection(sections, item, nextPartial);
    const currentOutlineData = outlineData as Record<string, unknown>;
    const outlineContent = hasOutlineContent || hasPartialContent
      ? normalizeForSave(contentForOutline ?? (sections[item.id].content || ''), item)
      : (sections[item.id].content || '');
    if (hasOutlineContent || hasPartialContent) {
      sections = {
        ...sections,
        [item.id]: {
          ...sections[item.id],
          content: outlineContent,
        },
      };
    }
    const nextOutlineData = {
      ...currentOutlineData,
      outline: updateOutlineItemContent((currentOutlineData.outline || outlineData.outline) as any[], item.id, outlineContent),
    };
    outlineData = nextOutlineData;
    const runtime = syncRuntime();
    schedulePersist();
    const saved = technicalPlan;
    if (hasOutlineContent || hasPartialContent) {
      writeDeveloperLog('content.section.saved', {
        section_id: item.id,
        title: item.title || '未命名章节',
        status: sections[item.id]?.status || 'idle',
        content_metrics: textMetrics(outlineContent),
      });
    }
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, saved as unknown as boolean, {
      outlineData: nextOutlineData,
      contentSection: sections[item.id],
      contentRuntime: runtime,
    });
    return saved;
  }

  async function saveContentPlanForItem(itemId: string, plan: any): Promise<Record<string, unknown>> {
    contentPlans.set(itemId, plan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [itemId]: createStoredContentPlan(plan, tableRequirement),
    }, leaves);
    schedulePersist();
    const saved = technicalPlan;
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved as unknown as boolean);
    return saved;
  }

  async function saveSectionAndContentPlan(item: any, partial: any, contentForOutline: any, plan: any, taskPartial: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const hasPartialContent = Object.prototype.hasOwnProperty.call(partial || {}, 'content');
    const hasOutlineContent = contentForOutline !== undefined;
    const nextPartial = { ...(partial || {}) };
    if (hasPartialContent) {
      nextPartial.content = normalizeForSave(nextPartial.content, item);
    }
    sections = withSection(sections, item, nextPartial);
    const currentOutlineData = outlineData as Record<string, unknown>;
    const outlineContent = hasOutlineContent || hasPartialContent
      ? normalizeForSave(contentForOutline ?? (sections[item.id].content || ''), item)
      : (sections[item.id].content || '');
    if (hasOutlineContent || hasPartialContent) {
      sections = {
        ...sections,
        [item.id]: {
          ...sections[item.id],
          content: outlineContent,
        },
      };
    }
    const nextOutlineData = {
      ...currentOutlineData,
      outline: updateOutlineItemContent((currentOutlineData.outline || outlineData.outline) as any[], item.id, outlineContent),
    };
    outlineData = nextOutlineData;
    contentPlans.set(item.id, plan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [item.id]: createStoredContentPlan(plan, tableRequirement),
    }, leaves);
    const runtime = syncRuntime();
    schedulePersist();
    const saved = technicalPlan;
    if (hasOutlineContent || hasPartialContent) {
      writeDeveloperLog('content.section.saved', {
        section_id: item.id,
        title: item.title || '未命名章节',
        status: sections[item.id]?.status || 'idle',
        content_metrics: textMetrics(outlineContent),
      });
    }
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, saved as unknown as boolean, {
      outlineData: nextOutlineData,
      contentSection: sections[item.id],
      contentRuntime: runtime,
      technicalPlanPatch: {
        contentGenerationPlans: storedContentPlans,
        contentGenerationRuntime: runtime,
      },
    });
    return saved;
  }

  function getRestoredNodeIds(): Set<string> {
    const restoredIds = new Set<string>();
    for (const { item } of leaves) {
      if (getOriginalMaterialRuntimeState(item).validRestored) {
        restoredIds.add(String(item.id || ''));
      }
    }
    return restoredIds;
  }

  async function persistContentPlans(targets: any[]): Promise<Record<string, unknown>> {
    const nextPlans = { ...storedContentPlans };
    for (const context of targets) {
      const contentPlan = contentPlans.get(context.item.id) || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
      nextPlans[context.item.id] = createStoredContentPlan(contentPlan, tableRequirement);
    }
    storedContentPlans = pruneContentGenerationPlans(nextPlans, leaves);
    schedulePersist();
    const saved = technicalPlan;
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved as unknown as boolean);
    return saved;
  }

  async function planOne(context: any): Promise<void> {
    const { item, parentChapters, siblingChapters } = context;
    // 镜像采购需求叶子：不走 LLM 编排（正文由 runOne 逐字搬运招标原文），直接落空编排占位，
    // 让 planning 计数与 tasksToRun 对齐，避免进度卡在 <100%。
    if (item?.isMirror === true) {
      const mirrorPlan = normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
      contentPlans.set(item.id, mirrorPlan);
      storedContentPlans = pruneContentGenerationPlans({
        ...storedContentPlans,
        [item.id]: createStoredContentPlan(mirrorPlan, tableRequirement),
      }, leaves);
      schedulePersist();
      contentStats.planning_completed += 1;
      logs = [...logs, `镜像章节跳过编排（逐字搬运招标原文）：${item.id} ${item.title || '未命名章节'}`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return;
    }
    let contentPlan: any;

    try {
      contentPlan = await aiService.collectJsonResponse({
        messages: buildChapterContentPlanMessages({
          chapter: item,
          parentChapters,
          siblingChapters,
          projectOverview,
          bidAnalysisFactsText,
          globalFactTitlesText,
          regenerateRequirement,
          tableRequirement,
          maxTables,
          tableTotalSections: leaves.length,
          knowledgeItems,
        }),
        temperature: 0.2,
        logTitle: `正文编排-${item.id}-${item.title || '未命名章节'}`,
        progressLabel: '正文编排决策',
        failureMessage: '模型返回的正文编排决策格式无效',
        normalizer: (value: any) => normalizeContentPlan(value, allowedKnowledgeItemIds, allowedFactTitles),
        validator: validateContentPlan,
      });
    } catch (error: any) {
      if (isPauseLikeError(error)) {
        throw error;
      }
      contentPlan = normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
      logs = [...logs, `编排失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}，将按纯正文生成。`];
    }

    if (tableRequirement === 'none') {
      contentPlan = clearContentPlanTable(contentPlan);
    }

    contentPlans.set(item.id, contentPlan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [item.id]: createStoredContentPlan(contentPlan, tableRequirement),
    }, leaves);
    // 走节流单写线程（与 saveContentPlanForItem 一致），避免 contentConcurrency 个 planOne 并发直写
    // updateTechnicalPlan 在同一 project 行上互锁、顶破 30s 交互事务超时（"Transaction already closed"）。
    schedulePersist();
    contentStats.planning_completed += 1;
    logs = [...logs, `编排完成：${item.id} ${item.title || '未命名章节'}（知识库：${contentPlan.knowledge.item_ids.length} 条，事实变量：${contentPlan.facts.titles.length} 项，表格：${contentPlan.table.needed ? '需要' : '不需要'}）`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
  }

  async function planAll(): Promise<void> {
    refreshRunLimits(tasksToRun);
    contentStats.phase = 'planning';
    contentStats.planning_total = tasksToRun.length;
    const planningTargets: any[] = [];
    for (const context of tasksToRun) {
      const ctxItemId = String(context.item.id || '');
      const storedContentPlan = getReusableStoredContentPlan(ctxItemId);
      if (storedContentPlan?.plan) {
        contentPlans.set(ctxItemId, storedContentPlan.plan);
      } else {
        planningTargets.push(context);
      }
    }
    contentStats.planning_completed = tasksToRun.length - planningTargets.length;
    contentStats.generation_total = tasksToRun.length;
    logs = [...logs, planningTargets.length === tasksToRun.length
      ? `开始整体编排决策，共 ${tasksToRun.length} 个小节。`
      : `继续整体编排决策，共 ${tasksToRun.length} 个小节，复用 ${tasksToRun.length - planningTargets.length} 个历史编排。`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    if (planningTargets.length) {
      const [warmupTarget, ...remainingPlanningTargets] = planningTargets;
      logs = [...logs, `开始正文编排预热：${warmupTarget.item.id} ${warmupTarget.item.title || '未命名章节'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

      await planOne(warmupTarget);
      await pauseIfRequested('正文生成已在编排预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingPlanningTargets.length) {
        await waitForPromptCacheWarmupBeforeFanout(`正文编排预热完成，等待 5 秒后开始并发编排剩余 ${remainingPlanningTargets.length} 个小节。`);
        logs = [...logs, `开始并发编排剩余 ${remainingPlanningTargets.length} 个小节。`];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        await runItemsWithWorkerPool(remainingPlanningTargets, contentConcurrency, planOne, isPauseRequested);
      }
    }
    await pauseIfRequested('正文生成已在编排阶段暂停，可导出当前已完成内容，稍后继续。');

    const tableCandidates = tasksToRun.filter(({ item }: any) => contentPlans.get(item.id)?.table.needed);
    const selectedTableIds = runLimits.maxTablesForRun === null
      ? new Set(tableCandidates.map(({ item }: any) => item.id))
      : pickDistributedTableTargets(tableCandidates, runLimits.maxTablesForRun);
    if (runLimits.maxTablesForRun !== null) {
      for (const { item } of tableCandidates) {
        const tblItemId = String(item.id || '');
        if (!selectedTableIds.has(tblItemId)) {
          contentPlans.set(tblItemId, clearContentPlanTable(contentPlans.get(tblItemId)));
        }
      }
    }

    logs = [...logs, `整体编排完成：表格候选 ${tableCandidates.length} 个，${runLimits.maxTablesForRun === null ? '保持现有编排' : `入选 ${selectedTableIds.size} 个`}。`];
    await persistContentPlans(tasksToRun);
    contentStats.phase = 'generating';
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
  }

  async function waitForPromptCacheWarmupBeforeFanout(message: string): Promise<void> {
    logs = [...logs, message];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    await waitForPromptCacheWarmup();
    await pauseIfRequested('正文生成已在提示词缓存预热等待后暂停，可导出当前已完成内容，稍后继续。');
  }

  function rememberTouchedItem(itemId: string): void {
    if (itemId) {
      touchedItemIds.add(itemId);
      syncRuntime();
    }
  }

  // Rule 0: 初始大持久化（cjs:3521-3542）
  {
    const initialRuntime = syncRuntime();
    const initialIllustrationPatch = { contentIllustrationPlan: undefined };
    technicalPlan = await workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      ...initialIllustrationPatch,
      contentGenerationRuntime: initialRuntime,
      referenceKnowledgeDocumentIds,
      contentGenerationTask: await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }),
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean, {
      contentRuntime: initialRuntime,
      technicalPlanPatch: {
        outlineData,
        contentGenerationSections: sections,
        contentGenerationPlans: storedContentPlans,
        ...initialIllustrationPatch,
        contentGenerationRuntime: initialRuntime,
        referenceKnowledgeDocumentIds,
      },
    });
  }

  if (!tasksToRun.length) {
    logs = [...logs, retryContentCorrection
      ? '正文已全部生成，将直接重试内容矫正和后续处理。'
      : '正文已全部生成，将检查最低字数要求。'];
  }

  async function restoreOriginalMaterialsIfNeeded(targets: any[]): Promise<void> {
    if (!isExpansionWorkflow || !originalPlanSegments.length || !targets?.length) {
      return;
    }

    const targetStates = targets.map((context: any) => ({ context, state: getOriginalMaterialRuntimeState(context.item) }));
    const rebuildTargets = targetStates.filter(({ state }: any) => state.canRebuildRestoredContent || (targetItemId && regenerate && state.validRestored));
    const restoreTargets = targetStates
      .filter(({ state }: any) => !state.validRestored && !state.canRebuildRestoredContent)
      .map(({ context }: any) => context);
    if (!restoreTargets.length && !rebuildTargets.length) {
      logs = [...logs, '原方案还原：当前待生成小节均已完成还原，跳过还原阶段。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return;
    }

    contentStats.phase = 'restoring';
    technicalPlan = await workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'restoring' }) });
    logs = [...logs, `开始原方案还原：${originalPlanSegments.length} 个原文段，${restoreTargets.length} 个候选叶子小节，${rebuildTargets.length} 个小节可直接重建原文。`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    const assignedSourceIds = new Set<string>();
    let restoredCount = 0;
    for (const { context, state } of rebuildTargets) {
      const segments = state.sourceSegments;
      segments.forEach((segment: any) => assignedSourceIds.add(segment.id));
      const restoredContent = segments.map((segment: any) => segment.content).join('\n\n').trim();
      const originalMaterial = buildOriginalMaterialFromSegments(segments, state.originalMaterial);
      await saveSectionAndContentPlan(context.item, { status: 'idle', content: restoredContent, error: undefined }, restoredContent, {
        ...state.plan,
        original_material: originalMaterial,
      }, { logs });
      restoredCount += 1;
    }

    if (restoreTargets.length) {
      const allowedNodeIds = new Set(restoreTargets.map(({ item }: any) => item.id).filter(Boolean));
      const allowedSourceIds = new Set(originalPlanSegments.map((segment: any) => segment.id));
      const restoreMessages = buildOriginalMaterialRestoreMessages({
        targets: restoreTargets,
        originalSegments: originalPlanSegments,
        projectOverview,
        bidAnalysisFactsText,
        globalFactTitlesText,
      });
      let result: any;
      if (shouldUseAgentForMessages(aiService, restoreMessages)) {
        const messagesLength = getMessagesContentLength(restoreMessages);
        const contextLengthLimit = getTextContextLengthLimit(aiService);
        logs = [...logs, `原方案还原映射提示词 ${messagesLength} 字符，超过上下文阈值 ${Math.floor(contextLengthLimit * AGENT_CONTEXT_THRESHOLD_RATIO)}，切换 Agent 文件模式。`];
        writeDeveloperLog('original_restore.agent.start', {
          message_chars: messagesLength,
          context_length_limit: contextLengthLimit,
          threshold_ratio: AGENT_CONTEXT_THRESHOLD_RATIO,
          target_count: restoreTargets.length,
          original_segment_count: originalPlanSegments.length,
        });
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        let validatedRestoreResult = null;
        const { agentResult, outputContent } = await runContentAgentTask({
          title: '原方案正文还原映射 Agent',
          prompt: buildAgentOriginalMaterialRestorePrompt(),
          outputFile: 'original-restore-result.json',
          files: buildAgentOriginalMaterialRestoreFiles({
            targets: restoreTargets,
            originalSegments: originalPlanSegments,
            projectOverview,
            bidAnalysisFactsText,
            globalFactTitlesText,
          }),
          eventPrefix: 'original_restore.agent',
          activityLabel: 'Agent 正在判断原方案段落归属',
          startPauseMessage: '正文生成已在原方案还原 Agent 映射开始前暂停，本次 Agent 未启动；继续后将重新执行。',
          resultPauseMessage: '正文生成已在原方案还原 Agent 映射回写前暂停，本次 Agent 输出未回写；继续后将重新执行。',
          pausedLogMessage: '原方案还原 Agent 映射已暂停：本轮 Agent 已取消并清理，继续后将重新执行。',
          validateOutput: (resultForValidation: any) => {
            const outputForValidation = String(resultForValidation?.output_content || '').trim();
            const parsedForValidation = parseAgentJsonContent(outputForValidation);
            validatedRestoreResult = normalizeOriginalRestoreAssignments(parsedForValidation, { allowedNodeIds, allowedSourceIds });
            validateOriginalRestoreAssignments(validatedRestoreResult);
            return validatedRestoreResult;
          },
        });
        result = validatedRestoreResult || normalizeOriginalRestoreAssignments(parseAgentJsonContent(outputContent), { allowedNodeIds, allowedSourceIds });
        await pauseIfRequested('正文生成已在原方案还原 Agent 映射回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');
        writeDeveloperLog('original_restore.agent.validated', {
          assignment_count: result.assignments.length,
          agent_task_id: agentResult?.task_id || '',
          agent_session_id: agentResult?.session_id || '',
          output_metrics: textMetrics(outputContent),
        });
      } else {
        result = await aiService.collectJsonResponse({
          messages: restoreMessages,
          temperature: 0.1,
          logTitle: '原方案正文还原映射',
          progressLabel: '原方案还原',
          failureMessage: '模型返回的原方案还原映射格式无效',
          normalizer: (value: any) => normalizeOriginalRestoreAssignments(value, { allowedNodeIds, allowedSourceIds }),
          validator: validateOriginalRestoreAssignments,
          repairMessagesBuilder: (context: any) => buildOriginalRestoreRepairMessages(context, restoreTargets, originalPlanSegments),
          progressCallback: async (message: string) => {
            logs = [...logs, message || '原方案还原映射格式校验失败，正在修复'];
            await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
          },
        });
      }

      const targetById = new Map(restoreTargets.map((context: any) => [context.item.id, context]));
      for (const assignment of result.assignments || []) {
        const context = targetById.get(assignment.node_id);
        if (!context) {
          continue;
        }
        const segments = (assignment.source_ids || []).map((sourceId: string) => originalPlanSegmentById.get(sourceId)).filter(Boolean);
        if (!segments.length) {
          continue;
        }
        segments.forEach((segment: any) => assignedSourceIds.add(segment.id));
        const restoredContent = segments.map((segment: any) => segment.content).join('\n\n').trim();
        const plan = getContentPlanForItem(context.item.id);
        const originalMaterial = buildOriginalMaterialFromSegments(segments);
        await saveSectionAndContentPlan(context.item, { status: 'idle', content: restoredContent, error: undefined }, restoredContent, {
          ...plan,
          original_material: originalMaterial,
        }, { logs });
        restoredCount += 1;
      }
    }

    const unassignedCount = originalPlanSegments.filter((segment: any) => !assignedSourceIds.has(segment.id)).length;
    logs = [...logs, `原方案还原完成：已还原 ${restoredCount} 个小节，未分配原文段 ${unassignedCount} 个。`];
    contentStats.phase = 'generating';
    technicalPlan = await workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'generating' }) });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
  }

  async function prepareSingleSectionPlan(): Promise<void> {
    const context = tasksToRun[0];
    const singleItemId = String(context.item.id || '');
    const storedContentPlan = getReusableStoredContentPlan(singleItemId);
    contentStats.phase = 'planning';
    contentStats.planning_total = 1;
    contentStats.planning_completed = 0;
    contentStats.generation_total = 1;

    if (storedContentPlan) {
      contentPlans.set(singleItemId, storedContentPlan.plan);
      contentStats.planning_completed = 1;
      logs = [...logs, `复用历史编排：${context.item.id} ${context.item.title || '未命名章节'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    } else {
      logs = [...logs, `未找到可复用历史编排结果，将仅重新编排当前小节：${context.item.id} ${context.item.title || '未命名章节'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      await planOne(context);
      await pauseIfRequested('正文生成已在小节编排后暂停，可导出当前已完成内容，稍后继续。');
      await persistContentPlans([context]);
      logs = [...logs, `当前小节编排已保存：${context.item.id} ${context.item.title || '未命名章节'}。`];
    }

    await pauseIfRequested('正文生成已在小节编排阶段暂停，可导出当前已完成内容，稍后继续。');
    contentStats.phase = 'generating';
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
  }

  // 镜像采购需求叶子搬运：不走 LLM，逐字搬运招标原文（item.mirrorSourceText），
  // 叠加确定性语气改写（须/需→将）。全局主体替换层（供应商→我方全称、采购人→采购人全称）
  // 由 saveSection 内 applySubjectReplacement 自动叠加，与本函数正交。
  // 表格以原始 HTML <table> 保留在 mirrorSourceText 中，normalizeGeneratedMarkdown 不破坏 HTML。
  async function runMirrorLeafCarry(context: any): Promise<void> {
    const { item } = context;
    const sourceText = String(item?.mirrorSourceText || '');
    const label = `${item.id} ${item.title || '未命名章节'}`;
    if (!sourceText.trim()) {
      logs = [...logs, `镜像搬运失败（缺少招标原文）：${label}`];
      await saveSection(item, { status: 'error', content: '', error: '镜像章节缺少招标原文' }, '', { logs });
      return;
    }
    logs = [...logs, `开始镜像搬运招标原文：${label}`];
    await saveSection(item, { status: 'running', content: '', error: undefined }, '', { logs });
    const carried = applyMirrorToneRewrite(normalizeMirrorTextForCarry(sourceText));
    const content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(carried), item);
    await saveSection(item, { status: 'success', content, error: undefined }, content, {
      logs: [...logs, `镜像搬运完成：${label}`],
    });
    rememberTouchedItem(item.id);
  }

  async function runOne(context: any): Promise<void> {
    const { item } = context;
    // 镜像采购需求叶子：不走 LLM 生成，逐字搬运招标原文 + 确定性语气改写（须/需→将）。
    // 全局主体替换层（供应商→我方全称、采购人→采购人全称）在 saveSection 内自动叠加。
    if (item?.isMirror === true) {
      await runMirrorLeafCarry(context);
      return;
    }
    const previousSection = sections[item.id] || {};
    const previousContent = previousSection.content || item.content || '';
    const previousStatus = previousSection.status && previousSection.status !== 'running'
      ? previousSection.status
      : previousContent.trim() ? 'success' : 'idle';
    const isSingleSectionRegeneration = Boolean(targetItemId);
    let contentPlan = getContentPlanForItem(item.id);
    let originalState = getOriginalMaterialRuntimeState(item);
    let originalMaterial = originalState.originalMaterial;
    const needsRestoredOptimization = originalState.needsOptimization;
    let rawContent = needsRestoredOptimization ? previousContent : regenerate || retryItemIds.has(item.id) ? '' : previousContent;
    let content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(rawContent), item);
    logs = [...logs, needsRestoredOptimization
      ? `开始基于原方案优化扩写：${item.id} ${item.title || '未命名章节'}`
      : `开始生成：${item.id} ${item.title || '未命名章节'}`];
    await saveSection(item, {
      status: 'running',
      content: isSingleSectionRegeneration ? previousContent : content,
      error: undefined,
    }, isSingleSectionRegeneration ? previousContent : content, { logs });

    try {
      contentPlan = getContentPlanForItem(item.id);
      originalState = getOriginalMaterialRuntimeState(item);
      originalMaterial = originalState.originalMaterial;
      const knowledgeContents = resolveKnowledgeContents(contentPlan.knowledge?.item_ids, knowledgeContentMap);
      const selectedFactsText = resolveSelectedFactsText(contentPlan, globalFacts);
      const generationTarget = computeGenerationWordTarget(wordControl, leaves.length);
      const contentMessages = needsRestoredOptimization
        ? buildRestoredChapterContentMessages({ chapter: item, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, restoredContent: previousContent, bidderName: projectBidderName, wordControl, generationTarget })
        : buildChapterContentMessages({ chapter: item, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, bidderName: projectBidderName, wordControl, generationTarget });

      let generatedContent: string;
      if (needsRestoredOptimization && shouldUseAgentForMessages(aiService, contentMessages)) {
        const messagesLength = getMessagesContentLength(contentMessages);
        const contextLengthLimit = getTextContextLengthLimit(aiService);
        logs = [...logs, `已还原正文优化扩写提示词 ${messagesLength} 字符，超过上下文阈值 ${Math.floor(contextLengthLimit * AGENT_CONTEXT_THRESHOLD_RATIO)}，切换 Agent 文件模式：${item.id} ${item.title || '未命名章节'}。`];
        writeDeveloperLog('restored_optimization.agent.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          message_chars: messagesLength,
          context_length_limit: contextLengthLimit,
          threshold_ratio: AGENT_CONTEXT_THRESHOLD_RATIO,
          restored_content_metrics: textMetrics(previousContent),
          knowledge_content_count: knowledgeContents.length,
        });
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        const { agentResult, outputContent } = await runContentAgentTask({
          title: `已还原正文优化扩写 Agent-${item.id}`,
          prompt: buildAgentRestoredChapterContentPrompt(),
          outputFile: 'optimized-section.md',
          files: buildAgentRestoredChapterContentFiles({
            chapter: item,
            projectOverview,
            selectedFactsText,
            regenerateRequirement,
            contentPlan,
            knowledgeContents,
            restoredContent: previousContent,
          }),
          eventPrefix: 'restored_optimization.agent',
          activityLabel: 'Agent 正在优化扩写已还原正文',
          startPauseMessage: '正文生成已在已还原正文优化扩写 Agent 开始前暂停，本次 Agent 未启动；继续后将重新执行。',
          resultPauseMessage: '正文生成已在已还原正文优化扩写 Agent 回写前暂停，本次 Agent 输出未回写；继续后将重新执行。',
          pausedLogMessage: '已还原正文优化扩写 Agent 已暂停：本轮 Agent 已取消并清理，继续后将重新执行。',
        });
        generatedContent = outputContent;
        await pauseIfRequested('正文生成已在已还原正文优化扩写 Agent 回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');
        writeDeveloperLog('restored_optimization.agent.done', {
          section_id: item.id,
          title: item.title || '未命名章节',
          agent_task_id: agentResult?.task_id || '',
          agent_session_id: agentResult?.session_id || '',
          output_metrics: textMetrics(outputContent),
        });
      } else {
        generatedContent = await aiService.chat({
          messages: contentMessages,
          temperature: 0.7,
          logTitle: `${needsRestoredOptimization ? '原方案优化扩写' : '正文生成'}-${item.id}-${item.title || '未命名章节'}`,
        });
      }

      rawContent = needsRestoredOptimization ? generatedContent || '' : rawContent + (generatedContent || '');

      content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(rawContent), item);
      logs = [...logs, needsRestoredOptimization
        ? `原方案优化扩写完成：${item.id} ${item.title || '未命名章节'}`
        : `生成完成：${item.id} ${item.title || '未命名章节'}`];
      rememberTouchedItem(item.id);
      if (needsRestoredOptimization) {
        await saveSectionAndContentPlan(item, { status: 'success', content, error: undefined }, content, {
          ...contentPlan,
          original_material: normalizeOriginalMaterial({
            ...originalMaterial,
            optimized: true,
            optimized_at: now(),
          }),
        }, { logs });
      } else {
        await saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
      }
    } catch (error: any) {
      if (isPauseLikeError(error)) {
        await saveSection(item, {
          status: previousStatus,
          content: previousContent,
          error: previousSection.error,
        }, previousContent, { logs });
        throw error;
      }
      const message = error.message || '正文生成失败';
      logs = [...logs, `生成失败：${item.id} ${item.title || '未命名章节'}，${message}${isSingleSectionRegeneration ? '。已保留原正文。' : ''}`];
      await saveSection(item, {
        status: 'error',
        content: isSingleSectionRegeneration ? previousContent : content,
        error: message,
      }, isSingleSectionRegeneration ? previousContent : content, { logs });
    }
  }

  function getContentPromptWarmupKey(context: any): string {
    const originalState = getOriginalMaterialRuntimeState(context.item);
    const contentPlan = getContentPlanForItem(context.item.id);
    const branch = originalState.needsOptimization ? 'restored' : 'normal';
    const tableMode = contentPlan?.table?.needed ? 'table' : 'plain';
    return `${branch}:${tableMode}`;
  }

  function formatContentPromptWarmupLabel(key: string): string {
    if (key === 'restored:table') return '已还原优化扩写/允许表格';
    if (key === 'restored:plain') return '已还原优化扩写/无表格';
    if (key === 'normal:table') return '普通正文/允许表格';
    return '普通正文/无表格';
  }

  async function runContentTargetsWithWarmup(targets: any[], label = '正文生成'): Promise<void> {
    if (!targets.length) {
      return;
    }

    const groups = new Map<string, any[]>();
    for (const context of targets) {
      const key = getContentPromptWarmupKey(context);
      const group = groups.get(key) || [];
      group.push(context);
      groups.set(key, group);
    }

    const warmupContexts = new Set<any>();
    const warmups: Array<{ key: string; context: any }> = [];
    for (const [key, groupTargets] of groups.entries()) {
      if (groupTargets.length <= 1) {
        continue;
      }
      const context = groupTargets[0];
      warmups.push({ key, context });
      warmupContexts.add(context);
    }

    for (const { key, context } of warmups) {
      logs = [...logs, `开始${label}预热（${formatContentPromptWarmupLabel(key)}）：${context.item.id} ${context.item.title || '未命名章节'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

      await runOne(context);
      await pauseIfRequested(`正文生成已在${label}预热后暂停，可导出当前已完成内容，稍后继续。`);
    }

    const remainingTargets = targets.filter((context: any) => !warmupContexts.has(context));

    if (remainingTargets.length) {
      if (warmups.length) {
        await waitForPromptCacheWarmupBeforeFanout(`${label}分组预热完成，等待 5 秒后开始并发生成剩余 ${remainingTargets.length} 个小节。`);
      }
      logs = [...logs, warmups.length
        ? `开始并发生成剩余 ${remainingTargets.length} 个小节。`
        : `${label}无需分组预热，开始并发生成 ${remainingTargets.length} 个小节。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      await runItemsWithWorkerPool(remainingTargets, contentConcurrency, runOne, isPauseRequested);
    }
  }

  function pruneRuntimeContentPlans(): void {
    const leafIds = new Set(leaves.map(({ item }: any) => item.id));
    for (const itemId of Array.from(contentPlans.keys())) {
      if (!leafIds.has(itemId)) {
        contentPlans.delete(itemId);
      }
    }
  }

  async function refreshOutlineState(nextOutline: any[], invalidatedItemIds: Set<string> = new Set()): Promise<Record<string, unknown>> {
    outlineData = { ...outlineData, outline: nextOutline };
    for (const itemId of invalidatedItemIds) {
      delete sections[itemId];
      delete storedContentPlans[itemId];
      contentPlans.delete(itemId);
    }
    leaves = collectLeafContexts(outlineData.outline as any[]);
    sections = createInitialSections(leaves, sections);
    storedContentPlans = pruneContentGenerationPlans(storedContentPlans, leaves);
    pruneRuntimeContentPlans();
    refreshRunLimits(tasksToRun);
    const runtime = syncRuntime();
    technicalPlan = await workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    });
    const saved = technicalPlan;
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved as unknown as boolean, {
      outlineData,
      contentRuntime: runtime,
      technicalPlanPatch: {
        contentGenerationSections: sections,
        contentGenerationPlans: storedContentPlans,
        contentGenerationRuntime: runtime,
      },
    });
    return saved;
  }

  function medianLeafWords(): number {
    const words = leafWordStats()
      .map((item: any) => item.words)
      .filter((value: number) => value > 0)
      .sort((a: number, b: number) => a - b);
    if (!words.length) return 600;
    return words[Math.floor(words.length / 2)] || 600;
  }

  function pendingContentContexts(): any[] {
    return leaves.filter(({ item }: any) => {
      const section = sections[item.id];
      const content = section?.content || item.content || '';
      const originalState = getOriginalMaterialRuntimeState(item);
      return section?.status === 'error' || !String(content).trim() || originalState.needsOptimization || originalState.needsRestoreRepair;
    });
  }

  function selectEarlyContentProbeTargets(targets: any[]): any[] {
    const source = Array.isArray(targets) ? targets : [];
    if (source.length <= EARLY_CONTENT_PROBE_COUNT) {
      return source;
    }

    const indexes = [0, Math.floor((source.length - 1) / 2), source.length - 1];
    const selected = new Map<string, any>();
    for (const index of indexes) {
      const context = source[index];
      if (context?.item?.id) {
        selected.set(context.item.id, context);
      }
    }
    return Array.from(selected.values());
  }

  function averageGeneratedWords(targets: any[]): number {
    const words = (Array.isArray(targets) ? targets : [])
      .map(({ item }: any) => countContentWords(getLeafContentForWords(item)))
      .filter((value: number) => value > 0);
    if (!words.length) {
      return 0;
    }
    return Math.round(words.reduce((sum: number, value: number) => sum + value, 0) / words.length);
  }

  function estimateTotalWords(leafAverageWords: number): number {
    const averageWords = Number(leafAverageWords);
    const fallbackWords = medianLeafWords();
    const wordsPerPendingLeaf = Number.isFinite(averageWords) && averageWords > 0 ? averageWords : fallbackWords;
    return countTotalContentWords() + pendingContentContexts().length * wordsPerPendingLeaf;
  }

  function rememberRetryTargets(targets: any[]): void {
    for (const { item } of targets || []) {
      if (sections[item.id]?.status === 'error') {
        retryItemIds.add(item.id);
      }
    }
  }

  async function updateOutlineExpansionProgress(round: number, stepCompleted: number, label: string, planSnapshot?: any): Promise<void> {
    const normalizedRound = Math.max(1, Math.min(MAX_OUTLINE_EXPANSION_ROUNDS, Math.round(Number(round) || 1)));
    const normalizedStep = Math.max(0, Math.min(OUTLINE_EXPANSION_STEPS_PER_ROUND, Math.round(Number(stepCompleted) || 0)));
    contentStats.phase = 'outline-expanding';
    contentStats.outline_expansion_total = MAX_OUTLINE_EXPANSION_ROUNDS;
    contentStats.outline_expansion_completed = normalizedStep >= OUTLINE_EXPANSION_STEPS_PER_ROUND
      ? normalizedRound
      : normalizedRound - 1;
    contentStats.outline_expansion_step_total = MAX_OUTLINE_EXPANSION_ROUNDS * OUTLINE_EXPANSION_STEPS_PER_ROUND;
    contentStats.outline_expansion_step_completed = ((normalizedRound - 1) * OUTLINE_EXPANSION_STEPS_PER_ROUND) + normalizedStep;
    contentStats.outline_expansion_round = normalizedRound;
    contentStats.outline_expansion_round_total = MAX_OUTLINE_EXPANSION_ROUNDS;
    contentStats.outline_expansion_step_label = label || '';
    await updateTask(
      { status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() },
      (planSnapshot || technicalPlan) as unknown as boolean,
    );
  }

  async function runOutlineExpansionRound(round: number): Promise<number> {
    const nodeMap = createOutlineNodeMap(outlineData.outline || []);
    const restoredNodeIds = getRestoredNodeIds();
    const currentWords = countTotalContentWords();
    contentStats.phase = 'outline-expanding';
    contentStats.outline_expansion_total = MAX_OUTLINE_EXPANSION_ROUNDS;
    contentStats.outline_expansion_completed = round - 1;
    syncRuntime({ phase: 'outline-expanding' });
    logs = [...logs, `最低字数未达标，开始第 ${round}/${MAX_OUTLINE_EXPANSION_ROUNDS} 轮补目录。`];
    technicalPlan = await workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: contentRuntime });
    const started = technicalPlan;
    await updateOutlineExpansionProgress(round, 1, '准备目录上下文和字数统计', started);

    await updateOutlineExpansionProgress(round, 2, '正在请求 AI 生成新增目录');

    const patch = await aiService.collectJsonResponse({
      messages: buildOutlineExpansionMessages({
        projectOverview,
        globalFactsText,
        outlineData,
        currentWords,
        minimumWords,
        medianLeafWords: medianLeafWords(),
        round,
        nodeMap,
        restoredNodeIds,
      }),
      temperature: 0.4,
      logTitle: `最低字数补目录第${round}轮`,
      progressLabel: '最低字数补目录',
      failureMessage: '模型返回的补目录数据格式无效',
      normalizer: (value: any) => normalizeOutlineExpansionResponse(value, { nodeMap, restoredNodeIds }),
      validator: validateOutlineExpansionResponse,
      repairMessagesBuilder: (context: any) => buildOutlineExpansionRepairMessages(context, outlineData.outline || [], restoredNodeIds),
      progressCallback: async (message: string) => { await updateOutlineExpansionProgress(round, 2, message || '补目录结果格式校验失败，正在修复'); },
    });

    await updateOutlineExpansionProgress(round, 3, `补目录结果校验通过，返回 ${patch.additions.length} 条新增目录`);

    if (!patch.additions.length) {
      syncRuntime({ outline_expansion_completed: round });
      logs = [...logs, `第 ${round} 轮补目录未返回可用新增目录。`];
      await updateOutlineExpansionProgress(round, 5, '本轮未返回可用新增目录，准备评估字数');
      return 0;
    }

    await updateOutlineExpansionProgress(round, 4, '正在应用新增目录并校验完整目录结构');
    const { outline, invalidatedItemIds, addedCount } = applyOutlineExpansionAdditions(outlineData.outline || [], patch);
    syncRuntime({ outline_expansion_completed: round });
    logs = [...logs, `第 ${round} 轮补目录已应用：新增 ${addedCount} 个目录节点，清空 ${invalidatedItemIds.size} 个旧叶子正文并返还其编排额度。`];
    await refreshOutlineState(outline, invalidatedItemIds);
    await updateOutlineExpansionProgress(round, 5, `已新增 ${addedCount} 个目录节点，正在刷新待生成小节`);
    return addedCount;
  }

  async function runOutlineExpansionIfNeeded(initialEstimatedWords: number, leafAverageWords: number): Promise<number> {
    if (minimumWords <= 0) {
      return 0;
    }

    let estimatedWords = Number(initialEstimatedWords);
    if (!Number.isFinite(estimatedWords)) {
      estimatedWords = estimateTotalWords(leafAverageWords);
    }
    if (estimatedWords >= minimumWords * OUTLINE_EXPANSION_TARGET_RATIO) {
      return 0;
    }

    let addedTotal = 0;
    const completedRounds = Math.min(contentRuntime.outline_expansion_completed || 0, MAX_OUTLINE_EXPANSION_ROUNDS);
    for (let round = completedRounds + 1; round <= MAX_OUTLINE_EXPANSION_ROUNDS; round += 1) {
      try {
        addedTotal += await runOutlineExpansionRound(round);
        await updateOutlineExpansionProgress(round, OUTLINE_EXPANSION_STEPS_PER_ROUND, '本轮补目录已完成，正在检查暂停请求');
        await pauseIfRequested('正文生成已在补目录阶段暂停，可导出当前已完成内容，稍后继续。');
      } catch (error: any) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        logs = [...logs, `第 ${round} 轮补目录失败：${error.message || '模型返回无效'}。`];
        syncRuntime({ outline_expansion_completed: round });
        await updateOutlineExpansionProgress(round, OUTLINE_EXPANSION_STEPS_PER_ROUND, '本轮补目录失败，准备评估是否继续');
      }

      await updateOutlineExpansionProgress(round, OUTLINE_EXPANSION_STEPS_PER_ROUND, '正在预估补目录后的可达字数');
      estimatedWords = estimateTotalWords(leafAverageWords);
      if (estimatedWords >= minimumWords * OUTLINE_EXPANSION_TARGET_RATIO) {
        logs = [...logs, `补目录预估可达到最低字数的 ${Math.round(OUTLINE_EXPANSION_TARGET_RATIO * 100)}%，准备补充新增小节编排。`];
        await updateOutlineExpansionProgress(round, OUTLINE_EXPANSION_STEPS_PER_ROUND, '预估字数已达标，准备补充新增小节编排');
        break;
      }
    }

    return addedTotal;
  }

  async function runEarlyContentProbeIfNeeded(): Promise<boolean> {
    if (minimumWords <= 0 || targetItemId || !tasksToRun.length) {
      return false;
    }

    const probeTargets = selectEarlyContentProbeTargets(tasksToRun);
    if (!probeTargets.length) {
      return false;
    }

    logs = [...logs, `最低字数预估：先生成 ${probeTargets.length} 个样本小节。`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    await runContentTargetsWithWarmup(probeTargets, '最低字数采样');
    await pauseIfRequested('正文生成已在最低字数采样阶段暂停，可导出当前已完成内容，稍后继续。');

    const averageWords = averageGeneratedWords(probeTargets);
    tasksToRun = pendingContentContexts();
    rememberRetryTargets(tasksToRun);

    if (averageWords <= 0) {
      logs = [...logs, '最低字数预估：样本正文未成功生成，跳过前置补目录。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return false;
    }

    const estimatedWords = estimateTotalWords(averageWords);
    logs = [...logs, `最低字数预估：样本平均 ${averageWords} 字，预计全文约 ${estimatedWords} 字。`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    const addedCount = await runOutlineExpansionIfNeeded(estimatedWords, averageWords);
    tasksToRun = pendingContentContexts();
    rememberRetryTargets(tasksToRun);
    if (addedCount > 0) {
      logs = [...logs, `补目录完成，开始为 ${tasksToRun.length} 个待生成小节补充编排。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      await planAll();
      await pauseIfRequested('正文生成已在补目录新增正文编排后暂停，可导出当前已完成内容，稍后继续。');
      tasksToRun = pendingContentContexts();
      rememberRetryTargets(tasksToRun);
      return true;
    }

    const nextEstimatedWords = estimateTotalWords(averageWords);
    logs = [...logs, nextEstimatedWords >= minimumWords * OUTLINE_EXPANSION_TARGET_RATIO
      ? '最低字数预估已达到补目录阈值，继续生成正文。'
      : '补目录未新增可用目录，继续生成正文并由后续扩写兜底。'];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    return false;
  }

  function createExpansionCycle(currentWords: number): string[] {
    const candidates = leafWordStats()
      .filter(({ item, content }: any) => sections[item.id]?.status === 'success' && String(content || '').trim())
      .sort((a: any, b: any) => a.words - b.words);
    const orderedIds = orderExpansionCandidates(candidates).map(({ item }: any) => item.id);
    syncRuntime({
      expansion_cycle_item_ids: orderedIds,
      expansion_attempted_item_ids: [],
      expansion_cycle_start_words: currentWords,
    });
    return orderedIds;
  }

  function getExpansionCycle(currentWords: number): { cycleIds: string[]; attemptedIds: Set<string> } {
    let cycleIds = contentRuntime.expansion_cycle_item_ids.filter((itemId: string) => sections[itemId]?.status === 'success');
    let attemptedIds = new Set<string>(contentRuntime.expansion_attempted_item_ids);
    if (!cycleIds.length || cycleIds.every((itemId: string) => attemptedIds.has(itemId))) {
      cycleIds = createExpansionCycle(currentWords);
      attemptedIds = new Set<string>(contentRuntime.expansion_attempted_item_ids);
    }
    return { cycleIds, attemptedIds };
  }

  function persistExpansionAttempted(attemptedIds: Set<string>): void {
    syncRuntime({ expansion_attempted_item_ids: Array.from(attemptedIds) });
    schedulePersist();
  }

  function selectNextExpansionContext(cycleIds: string[], attemptedIds: Set<string>): any | null {
    const statsById = new Map(leafWordStats().map((context: any) => [context.item.id, context]));
    let changed = false;
    for (const itemId of cycleIds) {
      if (attemptedIds.has(itemId)) {
        continue;
      }
      const context = statsById.get(itemId);
      if (context && sections[itemId]?.status === 'success' && String(context.content || '').trim()) {
        return context;
      }
      attemptedIds.add(itemId);
      changed = true;
    }
    if (changed) {
      persistExpansionAttempted(attemptedIds);
    }
    return null;
  }

  async function runExpansionWorkerPool(startWords: number): Promise<{ currentWords: number; completesCycle: boolean; launchedCount: number }> {
    let currentWords = startWords;
    const { cycleIds, attemptedIds } = getExpansionCycle(currentWords);
    let launchedCount = 0;
    let minimumReachedLogged = false;
    let pauseLogged = false;

    await appendDeveloperLog(`扩写工作池启动：并发 ${contentConcurrency}，候选 ${cycleIds.filter((itemId: string) => !attemptedIds.has(itemId)).length} 个，当前 ${currentWords}/${minimumWords} 字。`);

    function remainingCandidateCount(): number {
      const statsById = new Map(leafWordStats().map((context: any) => [context.item.id, context]));
      return cycleIds.filter((itemId: string) => {
        const context = statsById.get(itemId);
        return !attemptedIds.has(itemId) && context && sections[itemId]?.status === 'success' && String(context.content || '').trim();
      }).length;
    }

    function takeNextExpansionContext(): any | null {
      const context = selectNextExpansionContext(cycleIds, attemptedIds);
      if (!context) {
        return null;
      }
      attemptedIds.add(context.item.id);
      persistExpansionAttempted(attemptedIds);
      launchedCount += 1;
      return context;
    }

    if (remainingCandidateCount() > 1 && currentWords < minimumWords && !isPauseRequested()) {
      const warmupContext = takeNextExpansionContext();
      if (warmupContext) {
        logs = [...logs, `开始正文扩写预热：${warmupContext.item.id} ${warmupContext.item.title || '未命名章节'}。`];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        await appendDeveloperLog(`扩写预热请求发出：${warmupContext.item.id} ${warmupContext.item.title || '未命名章节'}。`);
        await expandOneSection(warmupContext);
        currentWords = countTotalContentWords();
        await appendDeveloperLog(`扩写预热请求完成：${warmupContext.item.id} ${warmupContext.item.title || '未命名章节'}，当前 ${currentWords}/${minimumWords} 字。`);
        await pauseIfRequested('正文生成已在扩写预热后暂停，可导出当前已完成内容，稍后继续。');
        if (currentWords >= minimumWords) {
          await appendDeveloperLog('扩写预热后已达最低字数，跳过后续并发扩写。');
          return {
            currentWords,
            completesCycle: cycleIds.length > 0 && cycleIds.every((itemId: string) => attemptedIds.has(itemId)),
            launchedCount,
          };
        }
        if (remainingCandidateCount() > 0) {
          await waitForPromptCacheWarmupBeforeFanout(`正文扩写预热完成，等待 5 秒后开始并发扩写剩余 ${remainingCandidateCount()} 个候选小节。`);
          logs = [...logs, `开始并发扩写剩余 ${remainingCandidateCount()} 个候选小节。`];
          await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        }
      }
    }

    await runWorkerPool({
      limit: contentConcurrency,
      shouldStop: () => currentWords >= minimumWords || isPauseRequested(),
      getNextItem() {
        if (currentWords >= minimumWords) {
          if (!minimumReachedLogged) {
            void appendDeveloperLog('扩写已达最低字数，停止调度新请求，等待已发出的请求完成。');
            minimumReachedLogged = true;
          }
          return null;
        }
        if (isPauseRequested()) {
          if (!pauseLogged) {
            void appendDeveloperLog('扩写暂停请求已收到，停止调度新请求，等待已发出的请求完成。');
            pauseLogged = true;
          }
          return null;
        }
        const context = takeNextExpansionContext();
        if (!context) {
          return null;
        }
        return context;
      },
      onItemStart(context: any, activeCount: number) {
        void appendDeveloperLog(`扩写请求发出：${context.item.id} ${context.item.title || '未命名章节'}，在飞 ${activeCount}/${contentConcurrency}。`);
      },
      async worker(context: any) {
        await expandOneSection(context);
        return context.item;
      },
      async onItemComplete(_context: any, item: any, activeCount: number) {
        currentWords = countTotalContentWords();
        await appendDeveloperLog(`扩写请求完成：${item.id} ${item.title || '未命名章节'}，当前 ${currentWords}/${minimumWords} 字，在飞 ${activeCount}/${contentConcurrency}。`);
        if (currentWords >= minimumWords) {
          if (!minimumReachedLogged) {
            void appendDeveloperLog('扩写已达最低字数，停止调度新请求，等待已发出的请求完成。');
            minimumReachedLogged = true;
          }
        } else if (isPauseRequested()) {
          if (!pauseLogged) {
            void appendDeveloperLog('扩写暂停请求已收到，停止调度新请求，等待已发出的请求完成。');
            pauseLogged = true;
          }
        }
      },
    });

    return {
      currentWords,
      completesCycle: cycleIds.length > 0 && cycleIds.every((itemId: string) => attemptedIds.has(itemId)),
      launchedCount,
    };
  }

  async function expandOneSection(context: any): Promise<void> {
    const { item, content, words } = context;
    const targetWords = Math.max(words * 2, words + MIN_SECTION_EXPANSION_INCREMENT);
    await adjustOneSectionWords(context, {
      mode: 'expand',
      targetWords,
      label: '扩写',
      enforceDirection: true,
    });
  }

  async function adjustOneSectionWords(context: any, options: {
    mode: 'expand' | 'shrink';
    targetWords: number;
    label: string;
    enforceDirection?: boolean;
    enforceSectionBounds?: boolean;
    enforceTotalBounds?: boolean;
  }): Promise<boolean> {
    const { item } = context;
    if (item?.isMirror === true) {
      logs = [...logs, `${options.label}跳过镜像章节：${item.id} ${item.title || '未命名章节'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return false;
    }
    const content = getLeafContentForWords(item);
    const words = countContentWords(content);
    if (!String(content || '').trim() || words <= 0) {
      return false;
    }
    const storedContentPlan = getReusableStoredContentPlan(item.id);
    const contentPlan = contentPlans.get(item.id) || storedContentPlan?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
    const selectedFactsText = resolveSelectedFactsText(contentPlan, globalFacts);
    logs = [...logs, `开始${options.label}：${item.id} ${item.title || '未命名章节'}（当前 ${words} 字，目标 ${options.targetWords} 字）。`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    try {
      const patch = await aiService.collectJsonResponse({
        messages: buildContentExpansionMessages({
          outlineData,
          context,
          projectOverview,
          selectedFactsText,
          currentContent: content,
          currentWords: words,
          targetWords: options.targetWords,
          mode: options.mode,
        }),
        temperature: 0.7,
        logTitle: `正文${options.label}-${item.id}-${item.title || '未命名章节'}`,
        progressLabel: `正文${options.label}`,
        failureMessage: `模型返回的正文${options.label}结果格式无效`,
        normalizer: normalizeContentExpansionPatch,
        validator: validateContentExpansionPatch,
        repairMessagesBuilder: (contextForRepair: any) => buildContentExpansionRepairMessages(contextForRepair, content),
      });
      if (options.mode === 'shrink' && patch.operation !== 'replace') {
        throw new Error('正文精简必须返回 replace 操作');
      }
      const nextContent = applyContentExpansionPatch(content, patch);
      const nextWords = countContentWords(nextContent);
      if (options.enforceDirection && options.mode === 'expand' && nextWords <= words) {
        throw new Error('字数调整后没有增加');
      }
      if (options.enforceDirection && options.mode === 'shrink' && nextWords >= words) {
        throw new Error('字数调整后没有减少');
      }
      if (options.enforceSectionBounds && wordControl.strictSectionWords && (nextWords < wordControl.sectionMinimumWords || nextWords > wordControl.sectionMaximumWords)) {
        throw new Error('本轮调整会使小节超出强控范围');
      }
      if (options.enforceTotalBounds !== false) {
        const nextTotalWords = countTotalContentWords() - words + nextWords;
        if (maximumWords > 0 && options.mode === 'expand' && nextTotalWords > maximumWords) {
          throw new Error('本轮扩写会使全文超过最多字数');
        }
        if (minimumWords > 0 && options.mode === 'shrink' && nextTotalWords < minimumWords) {
          throw new Error('本轮精简会使全文低于最少字数');
        }
      }
      logs = [...logs, `${options.label}完成：${item.id} ${item.title || '未命名章节'}（${words} -> ${nextWords} 字）。`];
      rememberTouchedItem(item.id);
      await saveSection(item, { status: 'success', content: nextContent, error: undefined }, nextContent, { logs });
      return true;
    } catch (error: any) {
      if (isPauseLikeError(error)) {
        throw error;
      }
      logs = [...logs, `${options.label}失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return false;
    }
  }

  async function ensureMinimumWords(): Promise<void> {
    if (minimumWords <= 0) {
      return;
    }
    let currentWords = countTotalContentWords();
    logs = [...logs, `最低字数兜底检查：当前总字数 ${currentWords} 字，最低字数 ${minimumWords} 字。`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    if (currentWords >= minimumWords) {
      logs = [...logs, '当前总字数已达到最低字数要求。'];
      return;
    }
    while (currentWords < minimumWords) {
      contentStats.phase = 'expanding';
      logs = [...logs, `开始正文扩写，当前 ${currentWords}/${minimumWords} 字。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

      const expansionResult = await runExpansionWorkerPool(currentWords);
      currentWords = expansionResult.currentWords;
      if (!expansionResult.launchedCount) {
        await pauseIfRequested('正文生成已在扩写阶段暂停，可导出当前已完成内容，稍后继续。');
        throw new Error('没有可扩写的成功正文小节，无法补足最低字数');
      }
      if (expansionResult.completesCycle) {
        const expansionCycleStartWords = Number.isFinite(contentRuntime.expansion_cycle_start_words)
          ? contentRuntime.expansion_cycle_start_words
          : currentWords;
        if (currentWords <= expansionCycleStartWords) {
          const message = `正文扩写已覆盖一轮可选小节，但总字数没有增长，无法继续补足最低字数（当前 ${currentWords}/${minimumWords} 字）。`;
          logs = [...logs, message];
          await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
          throw new Error(message);
        }
        syncRuntime({
          expansion_cycle_item_ids: [],
          expansion_attempted_item_ids: [],
          expansion_cycle_start_words: currentWords,
        });
      }
      schedulePersist();
      await pauseIfRequested('正文生成已在扩写阶段暂停，可导出当前已完成内容，稍后继续。');
    }

    logs = [...logs, `最低字数已达成：${currentWords}/${minimumWords} 字，准备进入后续阶段。`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
  }

  function sectionWordAdjustmentTargets(): any[] {
    if (!wordControl.strictSectionWords) return [];
    return leafWordStats()
      .filter(({ item, content }: any) => item?.isMirror !== true && sections[item.id]?.status === 'success' && String(content || '').trim())
      .filter(({ words }: any) => words > 0 && (words < wordControl.sectionMinimumWords || words > wordControl.sectionMaximumWords));
  }

  async function runSectionWordAdjustmentsIfNeeded(): Promise<void> {
    if (!wordControl.strictSectionWords) {
      return;
    }
    let targets = sectionWordAdjustmentTargets();
    if (!targets.length) {
      return;
    }
    contentStats.phase = 'expanding';
    contentStats.section_adjustment_total = targets.length;
    contentStats.section_adjustment_completed = 0;
    logs = [...logs, `开始强控小节字数检查：${targets.length} 个小节需调整，目标 ${wordControl.sectionWords} 字，范围 ${wordControl.sectionMinimumWords}-${wordControl.sectionMaximumWords} 字。`];
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    for (let round = 1; round <= MAX_WORD_ADJUSTMENT_ROUNDS; round += 1) {
      let adjustedThisRound = 0;
      for (const context of targets) {
        const currentWords = countContentWords(getLeafContentForWords(context.item));
        if (currentWords <= 0 || (currentWords >= wordControl.sectionMinimumWords && currentWords <= wordControl.sectionMaximumWords)) {
          continue;
        }
        const mode = currentWords < wordControl.sectionMinimumWords ? 'expand' : 'shrink';
        contentStats.section_adjustment_item_id = context.item.id;
        contentStats.section_adjustment_round = round;
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        const applied = await adjustOneSectionWords(context, {
          mode,
          targetWords: wordControl.sectionWords,
          label: mode === 'expand' ? '小节字数扩写' : '小节字数精简',
          enforceDirection: true,
          enforceSectionBounds: false,
          enforceTotalBounds: !targetItemId,
        });
        if (applied) adjustedThisRound += 1;
        contentStats.section_adjustment_completed += 1;
        await pauseIfRequested('正文生成已在小节字数调整阶段暂停，可导出当前已完成内容，稍后继续。');
      }
      targets = sectionWordAdjustmentTargets();
      if (!targets.length) {
        logs = [...logs, '强控小节字数调整完成。'];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        return;
      }
      if (!adjustedThisRound) {
        logs = [...logs, `强控小节字数仍有 ${targets.length} 个小节未达标，已达到本轮可调整边界，后续建议人工核对。`];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        return;
      }
    }
    targets = sectionWordAdjustmentTargets();
    if (targets.length) {
      logs = [...logs, `强控小节字数调整结束，仍有 ${targets.length} 个小节需人工核对。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    }
  }

  function totalWordDirection(): { mode: 'expand' | 'shrink'; currentWords: number; targetWords: number } | null {
    const currentWords = countTotalContentWords();
    if (minimumWords > 0 && currentWords < minimumWords) {
      return { mode: 'expand', currentWords, targetWords: minimumWords };
    }
    if (maximumWords > 0 && currentWords > maximumWords) {
      return { mode: 'shrink', currentWords, targetWords: maximumWords };
    }
    return null;
  }

  function selectTotalAdjustmentCandidates(mode: 'expand' | 'shrink'): any[] {
    const candidates = leafWordStats()
      .filter(({ item, content }: any) => item?.isMirror !== true && sections[item.id]?.status === 'success' && String(content || '').trim())
      .filter(({ words }: any) => words > 0);
    return mode === 'shrink'
      ? candidates.sort((a: any, b: any) => b.words - a.words)
      : orderExpansionCandidates(candidates);
  }

  async function ensureTotalWordBounds(): Promise<void> {
    let direction = totalWordDirection();
    if (!direction) {
      return;
    }
    if (direction.mode === 'expand') {
      await ensureMinimumWords();
      direction = totalWordDirection();
      if (!direction || direction.mode !== 'shrink') {
        return;
      }
    }

    contentStats.phase = 'expanding';
    for (let round = 1; direction && direction.mode === 'shrink' && round <= MAX_WORD_ADJUSTMENT_ROUNDS; round += 1) {
      contentStats.total_adjustment_round = round;
      contentStats.total_adjustment_mode = direction.mode;
      contentStats.total_adjustment_target_words = direction.targetWords;
      const before = direction.currentWords;
      const candidates = selectTotalAdjustmentCandidates(direction.mode);
      logs = [...logs, `全文字数调整第 ${round}/${MAX_WORD_ADJUSTMENT_ROUNDS} 轮：当前 ${before} 字，最多 ${maximumWords} 字，准备精简 ${Math.min(candidates.length, 6)} 个小节。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      if (!candidates.length) {
        throw new Error(`全文字数超过最多字数，但没有可精简的小节（当前 ${before}/${maximumWords} 字）`);
      }
      let appliedCount = 0;
      for (const context of candidates.slice(0, 6)) {
        const currentWords = countContentWords(getLeafContentForWords(context.item));
        const guidanceWords = wordControl.sectionWords > 0 ? wordControl.sectionWords : DEFAULT_SECTION_WORD_GUIDANCE;
        const targetWords = Math.max(200, Math.min(Math.floor(currentWords * 0.8), guidanceWords));
        const applied = await adjustOneSectionWords(context, {
          mode: 'shrink',
          targetWords,
          label: '全文字数精简',
          enforceDirection: true,
          enforceSectionBounds: wordControl.strictSectionWords,
          enforceTotalBounds: true,
        });
        if (applied) appliedCount += 1;
        await pauseIfRequested('正文生成已在全文字数调整阶段暂停，可导出当前已完成内容，稍后继续。');
        direction = totalWordDirection();
        if (!direction || direction.mode !== 'shrink') {
          logs = [...logs, `全文字数已控制在上限内：当前 ${countTotalContentWords()}/${maximumWords} 字。`];
          await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
          return;
        }
      }
      const after = countTotalContentWords();
      if (!appliedCount || after >= before) {
        const message = `全文字数精简未能继续降低总字数（当前 ${after}/${maximumWords} 字），建议人工核对。`;
        logs = [...logs, message];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        throw new Error(message);
      }
      direction = totalWordDirection();
    }

    direction = totalWordDirection();
    if (direction?.mode === 'shrink') {
      throw new Error(`全文字数仍超过最多字数（当前 ${direction.currentWords}/${maximumWords} 字），建议人工核对。`);
    }
  }

  function buildOriginalCoverageAuditTargets(auditTargetItemId = ''): any[] {
    if (!isExpansionWorkflow || !originalPlanSegments.length) {
      return [];
    }
    const normalizedTargetId = String(auditTargetItemId || '').trim();
    const segmentMap = new Map(originalPlanSegments.map((segment: any) => [segment.id, segment]));
    return leaves
      .filter(({ item }: any) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context: any) => {
        const originalState = getOriginalMaterialRuntimeState(context.item);
        const sources = originalState.originalMaterial.source_ids.map((sourceId: string) => segmentMap.get(sourceId)).filter(Boolean);
        return {
          ...context,
          content: originalState.content,
          originalMaterial: originalState.originalMaterial,
          sources,
          originalState,
        };
      })
      .filter(({ item, originalState, sources }: any) => sections[item.id]?.status === 'success' && originalState.validRestored && !originalState.needsOptimization && sources.length);
  }

  function buildAgentOriginalCoverageSourcesMarkdown(targets: any[]): string {
    const lines = ['# 原方案覆盖来源段', ''];
    for (const target of targets || []) {
      const id = target.item?.id || 'unknown';
      const title = target.item?.title || '未命名章节';
      lines.push(`## ${id} ${title}`);
      lines.push(`章节路径：${formatChapterPath(target)}`);
      lines.push('需要保留的来源段：');
      lines.push(formatOriginalCoverageSources(target.sources) || '未提供');
      lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  function buildAgentOriginalCoverageRepairPrompt(): string {
    return `请在当前工作目录中完成原方案覆盖修复，让 technical-plan.md 成为程序可继续解析和回写的最终正文文件。

workspace 文件说明：
- original-coverage-sources.md：每个章节对应需要保留的来源段，是判断原方案核心内容是否已保留的依据。
- technical-plan.md：当前技术方案正文，包含章节标题、section id 和 yibiao-section-start / yibiao-section-end 标记。

任务目标：
检查并修复 technical-plan.md，使各章节正文尽量保留 original-coverage-sources.md 中对应来源段的实质内容。

工作方式由你自行决定。可以搜索、分段读取、建立索引、创建草稿或中间文件，并多轮编辑 technical-plan.md；不需要按固定顺序读取文件，也不需要在单次模型输出中完成全部修复。

最终 technical-plan.md 需要满足：
- 保留所有章节编号、章节标题、HTML 注释标记和 section id。
- 保留原章节结构，不新增、删除或重排章节。
- 正文修改范围限定在 yibiao-section-start 和 yibiao-section-end 标记之间。
- 补回来源段中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后、实施方法等内容；不追求逐字一致。
- 如果来源段与当前正文存在明显冲突，可以保留当前正文，后续会由全文一致性审计或人工核对处理。
- 用户可见正文中不出现"原方案""来源段""用户原文"或类似过程性表述。`;
  }

  async function updateAgentOriginalCoverageProgress(step: number, label: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    contentStats.phase = 'original-auditing';
    contentStats.audit_repair_mode = 'agent';
    contentStats.audit_agent_step_total = 5;
    contentStats.audit_agent_step_completed = Math.max(0, Math.min(5, Number(step) || 0));
    contentStats.audit_agent_step_label = label || '';
    Object.assign(contentStats, extra || {});
    const runtime = syncRuntime({ phase: 'original-auditing' });
    technicalPlan = await workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: runtime });
    const saved = technicalPlan;
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved as unknown as boolean, { contentRuntime: runtime });
    return saved;
  }

  async function repairOriginalCoverageSection({ target, coverageItems }: any): Promise<{ appliedCount: number; failed: boolean; paused?: boolean; errors?: string[] }> {
    const { item } = target;
    let currentContent = sections[item.id]?.content || item.content || '';
    let failures: string[] = [];
    let appliedTotal = 0;
    writeDeveloperLog('original_coverage.repair.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      issue_count: (coverageItems || []).length,
      coverage_items: coverageItems,
      content_metrics: textMetrics(currentContent),
    });

    for (let attempt = 1; attempt <= ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      if (isPauseRequested()) {
        writeDeveloperLog('original_coverage.repair.section.paused', {
          section_id: item.id,
          title: item.title || '未命名章节',
          applied_count: appliedTotal,
        });
        return { appliedCount: appliedTotal, failed: false, paused: true };
      }

      try {
        writeDeveloperLog('original_coverage.repair.attempt.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          max_attempts: ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS,
          previous_failures: failures,
          content_metrics: textMetrics(currentContent),
        });
        const patch = await aiService.collectJsonResponse({
          messages: buildOriginalCoverageRepairMessages({
            target,
            coverageItems,
            currentContent,
            attempt,
            failures,
            tableRequirement,
          } as any),
          temperature: 0.2,
          logTitle: `原方案覆盖修复-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '原方案覆盖修复',
          failureMessage: '模型返回的原方案覆盖修复结果格式无效',
          normalizer: normalizeContentExpansionPatch,
          validator: validateContentExpansionPatch,
          repairMessagesBuilder: (contextForRepair: any) => buildContentExpansionRepairMessages(contextForRepair, currentContent),
          max_retries: 1,
        });
        writeDeveloperLog('original_coverage.repair.response', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          patch,
        });

        const nextContent = applyContentExpansionPatch(currentContent, patch);
        if (normalizeNewlines(nextContent).trim() === normalizeNewlines(currentContent).trim()) {
          failures = ['补写 patch 应用后正文没有变化'];
          writeDeveloperLog('original_coverage.repair.no_change', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            patch,
          });
        } else {
          currentContent = nextContent;
          appliedTotal += 1;
          rememberTouchedItem(item.id);
          await saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs });
          writeDeveloperLog('original_coverage.repair.section.saved', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            applied_total: appliedTotal,
            content_metrics: textMetrics(currentContent),
          });
          return { appliedCount: appliedTotal, failed: false, paused: false };
        }
      } catch (error: any) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        failures = [error.message || '模型返回无效'];
        writeDeveloperLog('original_coverage.repair.attempt.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      }

      logs = [...logs, `原方案覆盖修复第 ${attempt}/${ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS} 次未完成：${item.id} ${item.title || '未命名章节'}，${failures.join('；')}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    }

    writeDeveloperLog('original_coverage.repair.section.done', {
      section_id: item.id,
      title: item.title || '未命名章节',
      applied_count: appliedTotal,
      failed: true,
      errors: failures,
    });
    return { appliedCount: appliedTotal, failed: true, paused: false, errors: failures };
  }

  async function runAgentOriginalCoverageRepairIfEnabled(): Promise<{ ran: boolean; fixedCount: number; failedCount: number; skipped?: boolean; reason?: string }> {
    if (!isExpansionWorkflow) {
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!enableOriginalPlanCoverageAudit) {
      writeDeveloperLog('original_coverage.agent.skipped', { reason: 'disabled' });
      logs = [...logs, '原方案覆盖审计未启用，跳过 Agent 覆盖修复阶段。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const coverageTargets = buildOriginalCoverageAuditTargets('');
    const sectionIndex = buildAgentConsistencySectionIndex(coverageTargets);
    if (!sectionIndex.size) {
      writeDeveloperLog('original_coverage.agent.skipped', { reason: 'no_targets' });
      logs = [...logs, '原方案覆盖 Agent 修复跳过：没有可检查的已还原成功正文小节。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    contentStats.audit_group_total = 0;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    logs = [...logs, `开始 Agent 原方案覆盖修复：共 ${sectionIndex.size} 个已还原小节。`];
    writeDeveloperLog('original_coverage.agent.start', {
      section_count: sectionIndex.size,
      sections: coverageTargets.map((target: any) => ({
        id: target.item.id,
        title: target.item.title || '未命名章节',
        source_ids: target.sources.map((segment: any) => segment.id),
        content_metrics: textMetrics(target.content),
      })),
    });

    await updateAgentOriginalCoverageProgress(1, '准备原方案覆盖 Agent 输入文件');
    const files = [
      { path: 'original-coverage-sources.md', content: buildAgentOriginalCoverageSourcesMarkdown(coverageTargets) },
      { path: 'technical-plan.md', content: buildAgentTechnicalPlanMarkdown(sectionIndex) },
    ];
    await pauseIfRequested('正文生成已在原方案覆盖 Agent 修复开始前暂停，本次 Agent 未启动；继续后将重新执行。');

    if (!agentService?.runTask) {
      const failedCount = sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      logs = [...logs, `原方案覆盖 Agent 修复无法启动：Agent 服务尚未初始化，${failedCount} 个小节需人工核对。`];
      writeDeveloperLog('original_coverage.agent.unavailable', { failed_count: failedCount });
      await updateAgentOriginalCoverageProgress(5, '原方案覆盖 Agent 不可用', { audit_agent_failed_sections: failedCount });
      return { ran: true, fixedCount: 0, failedCount };
    }

    await updateAgentOriginalCoverageProgress(2, 'Agent 正在检查并补回原方案内容');
    const agentAbortController = new AbortController();
    let pauseWatcher: ReturnType<typeof setInterval> | null = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested(): void {
      if (!isPauseRequested()) {
        return;
      }
      if (!pauseLogged) {
        pauseLogged = true;
        logs = [...logs, '已请求暂停原方案覆盖 Agent 修复，正在取消本轮 Agent 任务。'];
        void updateAgentOriginalCoverageProgress(0, '正在取消本轮原方案覆盖 Agent 修复，继续后将重新执行');
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      await pauseIfRequested('正文生成已在原方案覆盖 Agent 修复开始前暂停，本次 Agent 未启动；继续后将重新执行。');
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title: '原方案覆盖 Agent 修复',
        prompt: buildAgentOriginalCoverageRepairPrompt(),
        output_file: 'technical-plan.md',
        files,
        timeout_ms: 30 * 60 * 1000,
        max_retries: 1,
        signal: agentAbortController.signal,
        validateOutput: (resultForValidation: any) => {
          const repairedMarkdownForValidation = String(resultForValidation?.output_content || '').trim();
          if (!repairedMarkdownForValidation) {
            throw new Error('Agent 未返回修复后的 technical-plan.md');
          }
          const parsedSectionsForValidation = parseAgentSectionMarkdown(repairedMarkdownForValidation);
          validateAgentConsistencySections(parsedSectionsForValidation, sectionIndex);
          return { section_count: parsedSectionsForValidation.size };
        },
        onActivity: createAgentActivityProgressHandler(updateAgentOriginalCoverageProgress, 2, 'Agent 正在检查并补回原方案内容'),
      }, 'original_coverage.agent');
      if (isAgentBusyResult(agentResult)) {
        logs = [...logs, 'Agent 正在处理其他任务，本轮跳过原方案覆盖 Agent 修复。'];
        writeDeveloperLog('original_coverage.agent.busy', { active_task: agentResult?.active_task || null });
        await updateAgentOriginalCoverageProgress(0, 'Agent 正忙，已跳过原方案覆盖 Agent 修复', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        return { ran: false, fixedCount: 0, failedCount: 0, skipped: true, reason: 'busy' };
      }
      await pauseIfRequested('正文生成已在原方案覆盖 Agent 修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');

      await updateAgentOriginalCoverageProgress(3, '读取 Agent 修复后的正文');
      const repairedMarkdown = String(agentResult?.output_content || '').trim();
      if (!repairedMarkdown) {
        writeDeveloperLog('original_coverage.agent.empty_output', { agent_result: agentResult });
        throw new Error('Agent 未返回修复后的 technical-plan.md');
      }

      await updateAgentOriginalCoverageProgress(4, '解析并校验 Agent 修复结果');
      const parsedSections = parseAgentSectionMarkdown(repairedMarkdown);
      validateAgentConsistencySections(parsedSections, sectionIndex);
      await pauseIfRequested('正文生成已在原方案覆盖 Agent 修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');

      await updateAgentOriginalCoverageProgress(5, '回写 Agent 修改的小节');
      const applyResult = applyAgentConsistencySections(parsedSections, sectionIndex, new Set(sectionIndex.keys()));
      contentStats.audit_agent_changed_sections = applyResult.changedCount;
      logs = [...logs, applyResult.changedCount
        ? `原方案覆盖 Agent 修复完成：已回写 ${applyResult.changedCount} 个小节（${applyResult.changedIds.join('、')}）。`
        : '原方案覆盖 Agent 修复完成：未发现需要回写的小节。'];
      writeDeveloperLog('original_coverage.agent.done', {
        changed_count: applyResult.changedCount,
        skipped_count: applyResult.skippedCount,
        changed_ids: applyResult.changedIds,
        agent_task_id: agentResult?.task_id || '',
        agent_session_id: agentResult?.session_id || '',
      });
      await updateAgentOriginalCoverageProgress(5, '原方案覆盖 Agent 修复完成', { audit_agent_changed_sections: applyResult.changedCount });
      return { ran: true, fixedCount: applyResult.changedCount, failedCount: 0 };
    } catch (error: any) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        contentStats.audit_agent_changed_sections = 0;
        contentStats.audit_agent_failed_sections = 0;
        logs = [...logs, '原方案覆盖 Agent 修复已暂停：本轮 Agent 已取消并清理，继续后将重新执行。'];
        writeDeveloperLog('original_coverage.agent.paused', {
          section_count: sectionIndex.size,
          error: error.message || String(error),
        });
        await updateAgentOriginalCoverageProgress(0, '原方案覆盖 Agent 修复已暂停，继续后将重新执行', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        await pauseIfRequested('正文生成已在原方案覆盖 Agent 修复阶段暂停，本次 Agent 已取消；继续后将重新执行。');
      }

      const failedCount = sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      logs = [...logs, `原方案覆盖 Agent 修复失败：${error.message || '未知错误'}。已保留原正文，${failedCount} 个小节需人工核对，任务将继续进入后续流程。`];
      writeDeveloperLog('original_coverage.agent.failed', {
        failed_count: failedCount,
        ...agentErrorDiagnostics(error),
      });
      await updateAgentOriginalCoverageProgress(contentStats.audit_agent_step_completed || 2, '原方案覆盖 Agent 修复失败', {
        audit_agent_failed_sections: failedCount,
      });
      return { ran: true, fixedCount: 0, failedCount };
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  async function runOriginalPlanCoverageAuditIfEnabled(options: { targetItemId?: string } = {}): Promise<{ ran: boolean; fixedCount: number; failedCount: number }> {
    if (!isExpansionWorkflow) {
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!enableOriginalPlanCoverageAudit) {
      writeDeveloperLog('original_coverage.audit.skipped', { reason: 'disabled' });
      logs = [...logs, '原方案覆盖审计未启用，跳过审计阶段。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditTargets = buildOriginalCoverageAuditTargets(options.targetItemId || targetItemId);
    if (!auditTargets.length) {
      writeDeveloperLog('original_coverage.audit.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      logs = [...logs, '原方案覆盖审计跳过：没有可审计的已还原成功正文小节。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const coverageIssuesBySectionId = new Map<string, any>();
    let issueCount = 0;
    let conflictCount = 0;
    contentStats.phase = 'original-auditing';
    contentStats.audit_repair_mode = 'normal';
    contentStats.audit_group_total = auditTargets.length;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_step_total = 0;
    contentStats.audit_agent_step_completed = 0;
    contentStats.audit_agent_step_label = '';
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    technicalPlan = await workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'original-auditing' }) });
    logs = [...logs, `开始原方案覆盖审计：${auditTargets.length} 个已还原小节，并发 ${contentConcurrency}。`];
    writeDeveloperLog('original_coverage.audit.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      target_count: auditTargets.length,
      concurrency: contentConcurrency,
      targets: auditTargets.map((target: any) => ({
        section_id: target.item.id,
        title: target.item.title || '未命名章节',
        source_ids: target.sources.map((segment: any) => segment.id),
        content_metrics: textMetrics(target.content),
      })),
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    async function auditOriginalCoverageTarget(target: any): Promise<void> {
      const allowedSourceIds = new Set<string>(target.sources.map((segment: any) => String(segment.id || '')).filter(Boolean));
      try {
        writeDeveloperLog('original_coverage.audit.section.start', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          source_ids: [...allowedSourceIds],
        });
        const response = await aiService.collectJsonResponse({
          messages: buildOriginalCoverageAuditMessages({ target }),
          temperature: 0.1,
          logTitle: `原方案覆盖审计-${target.item.id}-${target.item.title || '未命名章节'}`,
          progressLabel: '原方案覆盖审计',
          failureMessage: '模型返回的原方案覆盖审计结果格式无效',
          normalizer: (value: any) => normalizeOriginalCoverageAuditResponse(value, { allowedSourceIds, expectedNodeId: target.item.id }),
          validator: (value: any) => validateOriginalCoverageAuditResponse(value, allowedSourceIds),
          repairMessagesBuilder: (contextForRepair: any) => buildOriginalCoverageAuditJsonRepairMessages(contextForRepair, target),
          max_retries: 1,
        });
        const coverageItems = response.items || [];
        const repairItems = coverageItems.filter((item: any) => ['partial', 'missing'].includes(item.status));
        const conflictItems = coverageItems.filter((item: any) => item.status === 'conflict');
        if (repairItems.length) {
          coverageIssuesBySectionId.set(target.item.id, { target, coverageItems: repairItems });
        }
        issueCount += repairItems.length + conflictItems.length;
        conflictCount += conflictItems.length;
        contentStats.audit_conflict_total = issueCount;
        logs = [...logs, `原方案覆盖审计完成：${target.item.id} ${target.item.title || '未命名章节'}，需补写 ${repairItems.length} 段，冲突 ${conflictItems.length} 段。`];
        writeDeveloperLog('original_coverage.audit.section.success', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          items: coverageItems,
          repair_count: repairItems.length,
          conflict_count: conflictItems.length,
        });
      } catch (error: any) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        logs = [...logs, `原方案覆盖审计失败：${target.item.id} ${target.item.title || '未命名章节'}，${error.message || '模型返回无效'}，已跳过该小节。`];
        writeDeveloperLog('original_coverage.audit.section.error', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      } finally {
        contentStats.audit_group_completed += 1;
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      }
    }

    if (auditTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = auditTargets;
      logs = [...logs, `开始原方案覆盖审计预热：${warmupTarget.item.id} ${warmupTarget.item.title || '未命名章节'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

      await auditOriginalCoverageTarget(warmupTarget);
      await pauseIfRequested('正文生成已在原方案覆盖审计预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        await waitForPromptCacheWarmupBeforeFanout(`原方案覆盖审计预热完成，等待 5 秒后开始并发审计剩余 ${remainingTargets.length} 个小节。`);
        logs = [...logs, `开始并发审计剩余 ${remainingTargets.length} 个小节。`];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, auditOriginalCoverageTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(auditTargets, contentConcurrency, auditOriginalCoverageTarget, isPauseRequested);
    }

    await pauseIfRequested('正文生成已在原方案覆盖审计阶段暂停，可导出当前已完成内容，稍后继续。');

    const repairTargets = Array.from(coverageIssuesBySectionId.values());
    contentStats.audit_fix_total = repairTargets.length;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    logs = [...logs, repairTargets.length
      ? `原方案覆盖审计发现 ${repairTargets.length} 个小节需要补写，开始局部修复。${conflictCount ? `另有 ${conflictCount} 个来源段存在冲突，保留给一致性审计或人工核对。` : ''}`
      : `原方案覆盖审计未发现需要自动补写的来源段。${conflictCount ? `发现 ${conflictCount} 个冲突来源段，保留给一致性审计或人工核对。` : ''}`];
    writeDeveloperLog('original_coverage.repair.start', {
      target_count: repairTargets.length,
      conflict_count: conflictCount,
      issue_count: issueCount,
      concurrency: contentConcurrency,
      targets: repairTargets.map(({ target, coverageItems }: any) => ({
        section_id: target.item.id,
        title: target.item.title || '未命名章节',
        coverage_items: coverageItems,
      })),
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    if (!repairTargets.length) {
      writeDeveloperLog('original_coverage.audit.done', { fixed_count: 0, failed_count: 0, repair_target_count: 0, conflict_count: conflictCount });
      return { ran: true, fixedCount: 0, failedCount: 0 };
    }

    let fixedCount = 0;
    async function repairOriginalCoverageTarget(target: any): Promise<void> {
      const item = target.target.item;
      try {
        const result = await repairOriginalCoverageSection(target);
        if (result.appliedCount > 0) {
          fixedCount += 1;
          logs = [...logs, `原方案覆盖修复完成：${item.id} ${item.title || '未命名章节'}，应用 ${result.appliedCount} 个局部补写。`];
        }
        if (result.failed) {
          contentStats.audit_fix_failed += 1;
          logs = [...logs, `原方案覆盖修复需人工核对：${item.id} ${item.title || '未命名章节'}，${(result.errors || []).join('；') || '未能应用补写 patch'}。`];
        }
      } catch (error: any) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        contentStats.audit_fix_failed += 1;
        logs = [...logs, `原方案覆盖修复失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
      } finally {
        contentStats.audit_fix_completed += 1;
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      }
    }

    if (repairTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = repairTargets;
      logs = [...logs, `开始原方案覆盖修复预热：${warmupTarget.target.item.id} ${warmupTarget.target.item.title || '未命名章节'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

      await repairOriginalCoverageTarget(warmupTarget);
      await pauseIfRequested('正文生成已在原方案覆盖修复预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        await waitForPromptCacheWarmupBeforeFanout(`原方案覆盖修复预热完成，等待 5 秒后开始并发修复剩余 ${remainingTargets.length} 个小节。`);
        logs = [...logs, `开始并发修复剩余 ${remainingTargets.length} 个小节。`];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, repairOriginalCoverageTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(repairTargets, contentConcurrency, repairOriginalCoverageTarget, isPauseRequested);
    }

    await pauseIfRequested('正文生成已在原方案覆盖修复阶段暂停，可导出当前已完成内容，稍后继续。');

    logs = [...logs, `原方案覆盖审计完成：发现 ${repairTargets.length} 个需补写小节，成功修复 ${fixedCount} 个，${contentStats.audit_fix_failed} 个需人工核对。`];
    writeDeveloperLog('original_coverage.audit.done', {
      repair_target_count: repairTargets.length,
      fixed_count: fixedCount,
      failed_count: contentStats.audit_fix_failed,
      conflict_count: conflictCount,
      issue_count: issueCount,
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    return { ran: true, fixedCount, failedCount: contentStats.audit_fix_failed };
  }

  function buildConsistencyAuditTargets(auditTargetItemId = ''): any[] {
    const normalizedTargetId = String(auditTargetItemId || '').trim();
    return leaves
      .filter(({ item }: any) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context: any) => {
        const content = sections[context.item.id]?.content || context.item.content || '';
        return {
          ...context,
          content,
          words: countContentWords(content),
        };
      })
      .filter(({ item, content }: any) => sections[item.id]?.status === 'success' && String(content || '').trim());
  }

  function buildConsistencyAuditGroups(targets: any[]): any[] {
    const totalWords = (targets || []).reduce((sum: number, item: any) => sum + item.words, 0);
    if (!targets?.length) {
      return [];
    }

    let groupCount = 1;
    if (totalWords > CONSISTENCY_AUDIT_GROUP_WORD_LIMIT) {
      groupCount = 2;
      while (totalWords / groupCount > CONSISTENCY_AUDIT_GROUP_WORD_LIMIT) {
        groupCount += 1;
      }
    }
    const targetWords = Math.max(1, Math.ceil(totalWords / groupCount));
    const groups: any[] = [];
    let current = { index: 1, items: [] as any[], words: 0, targetWords };

    for (const target of targets) {
      if (current.items.length && current.words + target.words > targetWords && groups.length < groupCount - 1) {
        groups.push(current);
        current = { index: groups.length + 1, items: [], words: 0, targetWords };
      }
      current.items.push(target);
      current.words += target.words;
    }
    if (current.items.length) {
      groups.push(current);
    }
    return groups.map((group, index) => ({ ...group, index: index + 1, total: groups.length, totalWords }));
  }

  function buildAgentConsistencySectionIndex(targets: any[]): Map<string, any> {
    const index = new Map<string, any>();
    for (const context of targets || []) {
      const id = String(context.item?.id || '').trim();
      const content = String(context.content || '').trim();
      if (!id || !content) {
        continue;
      }
      index.set(id, {
        ...context,
        originalContent: content,
        originalHash: textHash(content),
      });
    }
    return index;
  }

  function renderAgentTechnicalPlanOutline(items: any[], sectionIndex: Map<string, any>, level = 1, lines: string[] = []): string[] {
    for (const item of items || []) {
      const id = String(item?.id || '').trim();
      const title = singleLine(item?.title || '未命名章节');
      const headingLevel = Math.min(level + 1, 6);
      lines.push(`${'#'.repeat(headingLevel)} ${id ? `${id} ` : ''}${title}`.trim());

      if (item?.children?.length) {
        renderAgentTechnicalPlanOutline(item.children, sectionIndex, level + 1, lines);
        continue;
      }

      const section = sectionIndex.get(id);
      if (!section) {
        continue;
      }
      lines.push(`<!-- yibiao-section-start id="${escapeSectionAttribute(id)}" title="${escapeSectionAttribute(title)}" -->`);
      lines.push(section.originalContent);
      lines.push(`<!-- yibiao-section-end id="${escapeSectionAttribute(id)}" -->`);
    }
    return lines;
  }

  function buildAgentTechnicalPlanMarkdown(sectionIndex: Map<string, any>): string {
    const lines = ['# 技术方案正文', ''];
    renderAgentTechnicalPlanOutline(outlineData.outline || [], sectionIndex, 1, lines);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  function buildAgentGlobalFactsMarkdown(): string {
    return [
      '# 全局事实变量',
      globalFactsText || '未提供',
      '# Step02 关键解析结果',
      bidAnalysisFactsText || '未提供',
    ].join('\n\n');
  }

  function buildAgentConsistencyRepairPrompt(): string {
    return `请在当前工作目录中完成全文一致性修复，让 technical-plan.md 成为程序可继续解析和回写的最终正文文件。

workspace 文件说明：
- global-facts.md：全局事实变量、Step02 关键解析结果和需要保持一致的项目信息。
- technical-plan.md：当前技术方案正文全文，包含章节标题、section id 和 yibiao-section-start / yibiao-section-end 标记。

任务目标：
审计并修复 technical-plan.md，使正文不与 global-facts.md 中的全局事实变量冲突，并尽量消除正文前后矛盾。

工作方式由你自行决定。可以搜索、分段读取、建立索引、创建草稿或中间文件，并多轮编辑 technical-plan.md；不需要按固定顺序读取文件，也不需要在单次模型输出中完成全部修复。

最终 technical-plan.md 需要满足：
- 保留所有章节编号、章节标题、HTML 注释标记和 section id。
- 保留原章节结构，不新增、删除或重排章节。
- 正文修改范围限定在 yibiao-section-start 和 yibiao-section-end 标记之间。
- 修复事实冲突、前后矛盾、同一信息多处表达不一致等问题。
- 优先以 global-facts.md 中的事实变量和关键项目信息为准。`;
  }

  async function updateAgentConsistencyProgress(step: number, label: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    contentStats.phase = 'auditing';
    contentStats.audit_repair_mode = 'agent';
    contentStats.audit_agent_step_total = 5;
    contentStats.audit_agent_step_completed = Math.max(0, Math.min(5, Number(step) || 0));
    contentStats.audit_agent_step_label = label || '';
    Object.assign(contentStats, extra || {});
    const runtime = syncRuntime({ phase: 'auditing' });
    technicalPlan = await workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: runtime });
    const saved = technicalPlan;
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, saved as unknown as boolean, { contentRuntime: runtime });
    return saved;
  }

  function validateAgentConsistencySections(parsedSections: Map<string, string>, sectionIndex: Map<string, any>): void {
    for (const id of parsedSections.keys()) {
      if (!sectionIndex.has(id)) {
        throw new Error(`Agent 输出包含未知小节：${id}`);
      }
    }
    for (const [id, section] of sectionIndex.entries()) {
      if (!parsedSections.has(id)) {
        throw new Error(`Agent 输出缺少小节：${id}`);
      }
      const nextContent = String(parsedSections.get(id) || '').trim();
      if (String(section.originalContent || '').trim() && !nextContent) {
        throw new Error(`Agent 输出把非空小节改为空：${id}`);
      }
    }
  }

  function applyAgentConsistencySections(parsedSections: Map<string, string>, sectionIndex: Map<string, any>, writableIds: Set<string>): { changedCount: number; skippedCount: number; changedIds: string[] } {
    let changedCount = 0;
    let skippedCount = 0;
    const changedIds: string[] = [];
    for (const [id, section] of sectionIndex.entries()) {
      if (writableIds instanceof Set && !writableIds.has(id)) {
        skippedCount += 1;
        continue;
      }
      const nextContent = String(parsedSections.get(id) || '').trim();
      const currentContent = String(section.originalContent || '').trim();
      if (normalizeNewlines(nextContent).trim() === normalizeNewlines(currentContent).trim()) {
        skippedCount += 1;
        continue;
      }
      changedCount += 1;
      changedIds.push(id);
      rememberTouchedItem(id);
      void saveSection(section.item, { status: 'success', content: nextContent, error: undefined }, nextContent, { logs });
    }
    return { changedCount, skippedCount, changedIds };
  }

  async function runAgentConsistencyRepairIfEnabled(options: { targetItemId?: string } = {}): Promise<{ ran: boolean; fixedCount: number; failedCount: number; skipped?: boolean; reason?: string }> {
    if (!enableConsistencyAudit) {
      writeDeveloperLog('consistency.agent.skipped', { reason: 'disabled' });
      logs = [...logs, '全文一致性审计未启用，跳过 Agent 一致性修复阶段。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!agentService?.runTask) {
      throw new Error('Agent 服务尚未初始化，无法执行 Agent 一致性修复');
    }

    const allTargets = buildConsistencyAuditTargets('');
    const sectionIndex = buildAgentConsistencySectionIndex(allTargets);
    if (!sectionIndex.size) {
      writeDeveloperLog('consistency.agent.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      logs = [...logs, 'Agent 一致性修复跳过：没有可审计的成功正文小节。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const normalizedTargetId = String(options.targetItemId || targetItemId || '').trim();
    const writableIds = normalizedTargetId ? new Set([normalizedTargetId]) : new Set(sectionIndex.keys());
    if (normalizedTargetId && !sectionIndex.has(normalizedTargetId)) {
      logs = [...logs, `Agent 一致性修复跳过：目标小节 ${normalizedTargetId} 当前没有成功正文。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    contentStats.audit_group_total = 0;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    logs = [...logs, `开始 Agent 全文一致性修复：共 ${sectionIndex.size} 个正文小节${normalizedTargetId ? `，仅回写目标小节 ${normalizedTargetId}` : ''}。`];
    writeDeveloperLog('consistency.agent.start', {
      target_item_id: normalizedTargetId,
      section_count: sectionIndex.size,
      writable_ids: [...writableIds],
      sections: Array.from(sectionIndex.values()).map((section: any) => ({
        id: section.item.id,
        title: section.item.title || '未命名章节',
        content_metrics: textMetrics(section.originalContent),
      })),
    });

    await updateAgentConsistencyProgress(1, '准备 Agent 输入文件');
    const files = [
      { path: 'global-facts.md', content: buildAgentGlobalFactsMarkdown() },
      { path: 'technical-plan.md', content: buildAgentTechnicalPlanMarkdown(sectionIndex) },
    ];
    await pauseIfRequested('正文生成已在 Agent 全文一致性修复开始前暂停，本次 Agent 未启动；继续后将重新执行 Agent 修复。');

    await updateAgentConsistencyProgress(2, 'Agent 正在审计并修复全文');
    const agentAbortController = new AbortController();
    let pauseWatcher: ReturnType<typeof setInterval> | null = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested(): void {
      if (!isPauseRequested()) {
        return;
      }
      if (!pauseLogged) {
        pauseLogged = true;
        logs = [...logs, '已请求暂停 Agent 一致性修复，正在取消本轮 Agent 任务。'];
        void updateAgentConsistencyProgress(0, '正在取消本轮 Agent 修复，继续后将重新执行');
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      await pauseIfRequested('正文生成已在 Agent 全文一致性修复开始前暂停，本次 Agent 未启动；继续后将重新执行 Agent 修复。');
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title: '全文一致性 Agent 修复',
        prompt: buildAgentConsistencyRepairPrompt(),
        output_file: 'technical-plan.md',
        files,
        timeout_ms: 30 * 60 * 1000,
        max_retries: 1,
        signal: agentAbortController.signal,
        validateOutput: (resultForValidation: any) => {
          const repairedMarkdownForValidation = String(resultForValidation?.output_content || '').trim();
          if (!repairedMarkdownForValidation) {
            throw new Error('Agent 未返回修复后的 technical-plan.md');
          }
          const parsedSectionsForValidation = parseAgentSectionMarkdown(repairedMarkdownForValidation);
          validateAgentConsistencySections(parsedSectionsForValidation, sectionIndex);
          return { section_count: parsedSectionsForValidation.size };
        },
        onActivity: createAgentActivityProgressHandler(updateAgentConsistencyProgress, 2, 'Agent 正在审计并修复全文'),
      }, 'consistency.agent');
      if (isAgentBusyResult(agentResult)) {
        logs = [...logs, 'Agent 正在处理其他任务，本轮跳过 Agent 一致性修复。'];
        writeDeveloperLog('consistency.agent.busy', { active_task: agentResult?.active_task || null });
        await updateAgentConsistencyProgress(0, 'Agent 正忙，已跳过本轮 Agent 修复', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        return { ran: false, fixedCount: 0, failedCount: 0, skipped: true, reason: 'busy' };
      }
      await pauseIfRequested('正文生成已在 Agent 全文一致性修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行 Agent 修复。');

      await updateAgentConsistencyProgress(3, '读取 Agent 修复后的全文');
      const repairedMarkdown = String(agentResult?.output_content || '').trim();
      if (!repairedMarkdown) {
        writeDeveloperLog('consistency.agent.empty_output', { agent_result: agentResult });
        throw new Error('Agent 未返回修复后的 technical-plan.md');
      }

      await updateAgentConsistencyProgress(4, '解析并校验 Agent 修复结果');
      const parsedSections = parseAgentSectionMarkdown(repairedMarkdown);
      validateAgentConsistencySections(parsedSections, sectionIndex);
      await pauseIfRequested('正文生成已在 Agent 全文一致性修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行 Agent 修复。');

      await updateAgentConsistencyProgress(5, '回写 Agent 修改的小节');
      const applyResult = applyAgentConsistencySections(parsedSections, sectionIndex, writableIds);
      contentStats.audit_agent_changed_sections = applyResult.changedCount;
      logs = [...logs, applyResult.changedCount
        ? `Agent 一致性修复完成：已回写 ${applyResult.changedCount} 个小节（${applyResult.changedIds.join('、')}）。`
        : 'Agent 一致性修复完成：未发现需要回写的小节。'];
      writeDeveloperLog('consistency.agent.done', {
        changed_count: applyResult.changedCount,
        skipped_count: applyResult.skippedCount,
        changed_ids: applyResult.changedIds,
        agent_task_id: agentResult?.task_id || '',
        agent_session_id: agentResult?.session_id || '',
      });
      await updateAgentConsistencyProgress(5, 'Agent 一致性修复完成', { audit_agent_changed_sections: applyResult.changedCount });
      return { ran: true, fixedCount: applyResult.changedCount, failedCount: 0 };
    } catch (error: any) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        contentStats.audit_agent_changed_sections = 0;
        contentStats.audit_agent_failed_sections = 0;
        logs = [...logs, 'Agent 一致性修复已暂停：本轮 Agent 已取消并清理，继续后将重新执行。'];
        writeDeveloperLog('consistency.agent.paused', {
          target_item_id: normalizedTargetId,
          section_count: sectionIndex.size,
          error: error.message || String(error),
        });
        await updateAgentConsistencyProgress(0, 'Agent 修复已暂停，继续后将重新执行', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        await pauseIfRequested('正文生成已在 Agent 全文一致性修复阶段暂停，本次 Agent 已取消；继续后将重新执行 Agent 修复。');
      }
      const failedCount = normalizedTargetId ? 1 : sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      logs = [...logs, `Agent 一致性修复失败：${error.message || '未知错误'}。已保留原正文，未回退普通修复。`];
      writeDeveloperLog('consistency.agent.failed', {
        target_item_id: normalizedTargetId,
        failed_count: failedCount,
        ...agentErrorDiagnostics(error),
      });
      await updateAgentConsistencyProgress(contentStats.audit_agent_step_completed || 2, 'Agent 一致性修复失败', {
        audit_agent_failed_sections: failedCount,
      });
      throw error;
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  async function repairConsistencySection({ context, conflicts }: any): Promise<{ appliedCount: number; failed: boolean; paused?: boolean; errors?: string[] }> {
    const { item } = context;
    let currentContent = sections[item.id]?.content || item.content || '';
    let failures: string[] = [];
    let appliedTotal = 0;
    writeDeveloperLog('consistency.repair.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      conflict_count: (conflicts || []).length,
      conflicts,
      content_metrics: textMetrics(currentContent),
    });

    for (let attempt = 1; attempt <= CONSISTENCY_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      if (isPauseRequested()) {
        writeDeveloperLog('consistency.repair.section.paused', {
          section_id: item.id,
          title: item.title || '未命名章节',
          applied_count: appliedTotal,
        });
        return { appliedCount: appliedTotal, failed: false, paused: true };
      }

      try {
        writeDeveloperLog('consistency.repair.attempt.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          max_attempts: CONSISTENCY_REPAIR_MAX_ATTEMPTS,
          previous_failures: failures,
          content_metrics: textMetrics(currentContent),
        });
        const response = await aiService.collectJsonResponse({
          messages: buildConsistencyRepairMessages({
            context,
            conflicts,
            globalFactsText,
            bidAnalysisFactsText,
            currentContent,
            attempt,
            failures,
            tableRequirement,
          }),
          temperature: 0.1,
          logTitle: `一致性修复-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '正文一致性修复',
          failureMessage: '模型返回的正文一致性修复结果格式无效',
          normalizer: (value: any) => normalizeConsistencyRepairResponse(value, item.id),
          validator: validateConsistencyRepairResponse,
          repairMessagesBuilder: (contextForRepair: any) => buildConsistencyRepairJsonRepairMessages(contextForRepair, item.id),
          max_retries: 1,
        });
        writeDeveloperLog('consistency.repair.response', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          patch_count: response.patches.length,
          patches: response.patches,
        });

        if (!response.patches.length) {
          failures = ['模型未返回可应用的 patches'];
          writeDeveloperLog('consistency.repair.no_patches', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
          });
        } else {
          const result = applyConsistencyRepairPatches(currentContent, response.patches);
          writeDeveloperLog('consistency.repair.apply_result', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            applied_count: result.appliedCount,
            errors: result.errors,
            patch_results: result.patchResults,
          });
          if (result.appliedCount > 0) {
            currentContent = result.content;
            appliedTotal += result.appliedCount;
            rememberTouchedItem(item.id);
            await saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs });
            writeDeveloperLog('consistency.repair.section.saved', {
              section_id: item.id,
              title: item.title || '未命名章节',
              attempt,
              applied_total: appliedTotal,
              content_metrics: textMetrics(currentContent),
            });
          }
          if (!result.errors.length) {
            writeDeveloperLog('consistency.repair.section.done', {
              section_id: item.id,
              title: item.title || '未命名章节',
              applied_count: appliedTotal,
              failed: false,
            });
            return { appliedCount: appliedTotal, failed: false, paused: false };
          }
          failures = result.errors;
        }
      } catch (error: any) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        failures = [error.message || '模型返回无效'];
        writeDeveloperLog('consistency.repair.attempt.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      }

      logs = [...logs, `一致性修复第 ${attempt}/${CONSISTENCY_REPAIR_MAX_ATTEMPTS} 次未完成：${item.id} ${item.title || '未命名章节'}，${failures.join('；')}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    }

    writeDeveloperLog('consistency.repair.section.done', {
      section_id: item.id,
      title: item.title || '未命名章节',
      applied_count: appliedTotal,
      failed: true,
      errors: failures,
    });
    return { appliedCount: appliedTotal, failed: true, paused: false, errors: failures };
  }

  async function runConsistencyAuditIfEnabled(options: { targetItemId?: string } = {}): Promise<{ ran: boolean; fixedCount: number; failedCount: number }> {
    if (!enableConsistencyAudit) {
      writeDeveloperLog('consistency.audit.skipped', { reason: 'disabled' });
      logs = [...logs, '全文一致性审计未启用，跳过审计阶段。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditTargets = buildConsistencyAuditTargets(options.targetItemId || targetItemId);
    if (!auditTargets.length) {
      writeDeveloperLog('consistency.audit.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      logs = [...logs, '全文一致性审计跳过：没有可审计的成功正文小节。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditGroups = buildConsistencyAuditGroups(auditTargets);
    const targetById = new Map(auditTargets.map((context: any) => [context.item.id, context]));
    const conflictsBySectionId = new Map<string, any[]>();

    contentStats.phase = 'auditing';
    contentStats.audit_repair_mode = 'normal';
    contentStats.audit_group_total = auditGroups.length;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_step_total = 0;
    contentStats.audit_agent_step_completed = 0;
    contentStats.audit_agent_step_label = '';
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    technicalPlan = await workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'auditing' }) });
    logs = [...logs, `开始全文一致性审计：${auditTargets.length} 个小节，拆分为 ${auditGroups.length} 组，并发 ${contentConcurrency}。`];
    writeDeveloperLog('consistency.audit.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      target_count: auditTargets.length,
      group_count: auditGroups.length,
      concurrency: contentConcurrency,
      group_word_limit: CONSISTENCY_AUDIT_GROUP_WORD_LIMIT,
      groups: auditGroups.map((group: any) => ({
        index: group.index,
        total: group.total,
        words: group.words,
        target_words: group.targetWords,
        total_words: group.totalWords,
        sections: group.items.map(({ item, words, content }: any) => ({
          id: item.id,
          title: item.title || '未命名章节',
          words,
          content_metrics: textMetrics(content),
        })),
      })),
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    async function auditConsistencyGroup(group: any): Promise<void> {
      const allowedIds = new Set<string>(group.items.map(({ item }: any) => String(item.id || '')).filter(Boolean));
      try {
        writeDeveloperLog('consistency.audit.group.start', {
          index: group.index,
          total: group.total,
          words: group.words,
          allowed_ids: [...allowedIds],
        });
        const response = await aiService.collectJsonResponse({
          messages: buildConsistencyAuditMessages({ group, globalFactsText, bidAnalysisFactsText, bidderName: projectBidderName }),
          temperature: 0.1,
          logTitle: `一致性审计-${group.index}-${group.total}`,
          progressLabel: '全文一致性审计',
          failureMessage: '模型返回的一致性审计结果格式无效',
          normalizer: (value: any) => normalizeConsistencyAuditResponse(value, allowedIds),
          validator: validateConsistencyAuditResponse,
          repairMessagesBuilder: (contextForRepair: any) => buildConsistencyAuditRepairMessages(contextForRepair, allowedIds),
          max_retries: 1,
        });

        for (const conflict of response.conflicts) {
          const list = conflictsBySectionId.get(conflict.section_id) || [];
          list.push(conflict);
          conflictsBySectionId.set(conflict.section_id, list);
        }
        contentStats.audit_conflict_total = conflictsBySectionId.size;
        logs = [...logs, `一致性审计完成：第 ${group.index}/${group.total} 组，发现 ${response.conflicts.length} 条冲突，累计 ${conflictsBySectionId.size} 个冲突小节。`];
        writeDeveloperLog('consistency.audit.group.success', {
          index: group.index,
          total: group.total,
          conflict_count: response.conflicts.length,
          conflicts: response.conflicts,
          conflict_section_count: conflictsBySectionId.size,
        });
      } catch (error: any) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        logs = [...logs, `一致性审计失败：第 ${group.index}/${group.total} 组，${error.message || '模型返回无效'}，已跳过该组。`];
        writeDeveloperLog('consistency.audit.group.error', {
          index: group.index,
          total: group.total,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      } finally {
        contentStats.audit_group_completed += 1;
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      }
    }

    if (auditGroups.length > 1) {
      const [warmupGroup, ...remainingGroups] = auditGroups;
      logs = [...logs, `开始全文一致性审计预热：第 ${warmupGroup.index}/${warmupGroup.total} 组。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

      await auditConsistencyGroup(warmupGroup);
      await pauseIfRequested('正文生成已在一致性审计预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingGroups.length) {
        await waitForPromptCacheWarmupBeforeFanout(`全文一致性审计预热完成，等待 5 秒后开始并发审计剩余 ${remainingGroups.length} 组。`);
        logs = [...logs, `开始并发审计剩余 ${remainingGroups.length} 组。`];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        await runItemsWithWorkerPool(remainingGroups, contentConcurrency, auditConsistencyGroup, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(auditGroups, contentConcurrency, auditConsistencyGroup, isPauseRequested);
    }

    await pauseIfRequested('正文生成已在一致性审计阶段暂停，可导出当前已完成内容，稍后继续。');

    const repairTargets = Array.from(conflictsBySectionId.entries())
      .map(([sectionId, conflicts]) => ({ context: targetById.get(sectionId), conflicts }))
      .filter((target: any) => target.context);
    contentStats.audit_fix_total = repairTargets.length;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    logs = [...logs, repairTargets.length
      ? `一致性审计发现 ${repairTargets.length} 个冲突小节，开始局部修复，并发 ${contentConcurrency}。`
      : '一致性审计未发现需要修复的事实冲突。'];
    writeDeveloperLog('consistency.repair.start', {
      target_count: repairTargets.length,
      concurrency: contentConcurrency,
      targets: repairTargets.map(({ context, conflicts }: any) => ({
        section_id: context.item.id,
        title: context.item.title || '未命名章节',
        conflict_count: conflicts.length,
        conflicts,
      })),
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    if (!repairTargets.length) {
      writeDeveloperLog('consistency.audit.done', { fixed_count: 0, failed_count: 0, repair_target_count: 0 });
      return { ran: true, fixedCount: 0, failedCount: 0 };
    }

    let fixedCount = 0;
    async function repairConsistencyTarget(target: any): Promise<void> {
      const item = target.context.item;
      try {
        const result = await repairConsistencySection(target);
        if (result.appliedCount > 0) {
          fixedCount += 1;
          logs = [...logs, `一致性修复完成：${item.id} ${item.title || '未命名章节'}，应用 ${result.appliedCount} 个局部替换。`];
        }
        if (result.failed) {
          contentStats.audit_fix_failed += 1;
          logs = [...logs, `一致性修复需人工核对：${item.id} ${item.title || '未命名章节'}，${(result.errors || []).join('；') || '未能唯一定位替换内容'}。`];
        }
      } catch (error: any) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        contentStats.audit_fix_failed += 1;
        logs = [...logs, `一致性修复失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
      } finally {
        contentStats.audit_fix_completed += 1;
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      }
    }

    if (repairTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = repairTargets;
      logs = [...logs, `开始一致性修复预热：${warmupTarget.context.item.id} ${warmupTarget.context.item.title || '未命名章节'}。`];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

      await repairConsistencyTarget(warmupTarget);
      await pauseIfRequested('正文生成已在一致性修复预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        await waitForPromptCacheWarmupBeforeFanout(`一致性修复预热完成，等待 5 秒后开始并发修复剩余 ${remainingTargets.length} 个小节。`);
        logs = [...logs, `开始并发修复剩余 ${remainingTargets.length} 个小节。`];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, repairConsistencyTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(repairTargets, contentConcurrency, repairConsistencyTarget, isPauseRequested);
    }

    await pauseIfRequested('正文生成已在一致性修复阶段暂停，可导出当前已完成内容，稍后继续。');

    logs = [...logs, `一致性审计完成：发现 ${repairTargets.length} 个冲突小节，成功修复 ${fixedCount} 个，${contentStats.audit_fix_failed} 个需人工核对。`];
    writeDeveloperLog('consistency.audit.done', {
      repair_target_count: repairTargets.length,
      fixed_count: fixedCount,
      failed_count: contentStats.audit_fix_failed,
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    return { ran: true, fixedCount, failedCount: contentStats.audit_fix_failed };
  }

  function getCurrentSuccessfulContent(item: any): string {
    const currentSections = (technicalPlan.contentGenerationSections || sections) as ContentSectionMap;
    const section = currentSections[item.id] || {};
    return section.status === 'success' ? String(section.content || '') : '';
  }

  function buildTableCleanupTargets(cleanupTargetItemId = ''): any[] {
    const normalizedTargetId = String(cleanupTargetItemId || '').trim();
    return leaves
      .filter(({ item }: any) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context: any) => {
        const content = getCurrentSuccessfulContent(context.item);
        return {
          ...context,
          content,
          tables: extractContentTableBlocks(content),
        };
      })
      .filter(({ content, tables }: any) => String(content || '').trim() && tables.length);
  }

  async function cleanupTablesForSection(target: any): Promise<{ rewrittenCount: number; skippedCount: number }> {
    const { item } = target;
    let currentContent = target.content;
    const originalTables = extractContentTableBlocks(currentContent);
    let rewrittenCount = 0;
    let skippedCount = 0;
    if (!originalTables.length) {
      return { rewrittenCount, skippedCount };
    }

    const batches = createTableCleanupBatches(originalTables).reverse();
    writeDeveloperLog('table_cleanup.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      table_count: originalTables.length,
      batch_count: batches.length,
      content_metrics: textMetrics(currentContent),
    });

    for (const batch of batches) {
      await pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const allowedTableIds = new Set(batch.map((table: any) => table.id));
      const tableById = new Map(batch.map((table: any) => [table.id, table]));
      try {
        const response = await aiService.collectJsonResponse({
          messages: buildTableCleanupMessages({ chapter: item, tables: batch }),
          temperature: 0.2,
          logTitle: `正文去表格-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '正文去表格',
          failureMessage: '模型返回的表格转换结果格式无效',
          normalizer: (value: any) => normalizeTableCleanupResponse(value, allowedTableIds),
          validator: validateTableCleanupResponse,
          max_retries: 1,
        });
        const edits: Array<{ start: number; end: number; newText: string }> = [];
        const returnedIds = new Set<string>();
        for (const replacement of response.replacements || []) {
          const table = tableById.get(replacement.table_id);
          returnedIds.add(replacement.table_id);
          if (!table) {
            continue;
          }
          if (containsContentTable(replacement.replacement_text)) {
            skippedCount += 1;
            writeDeveloperLog('table_cleanup.replacement.skipped', {
              section_id: item.id,
              table_id: table.id,
              reason: 'replacement_still_contains_table',
              replacement_metrics: textMetrics(replacement.replacement_text),
            });
            continue;
          }
          edits.push({ start: table.start, end: table.end, newText: replacement.replacement_text });
        }

        const missingCount = batch.filter((table: any) => !returnedIds.has(table.id)).length;
        skippedCount += missingCount;
        if (!edits.length) {
          contentStats.table_cleanup_completed += batch.length;
          await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
          continue;
        }

        const editResult = applyRangeEdits(currentContent, edits);
        if (editResult.errors.length) {
          skippedCount += edits.length;
          writeDeveloperLog('table_cleanup.apply.failed', {
            section_id: item.id,
            errors: editResult.errors,
            edit_count: edits.length,
          });
        } else {
          currentContent = editResult.content;
          rewrittenCount += editResult.edits.length;
          contentStats.table_cleanup_rewritten += editResult.edits.length;
          rememberTouchedItem(item.id);
          await saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs });
          writeDeveloperLog('table_cleanup.apply.success', {
            section_id: item.id,
            applied_count: editResult.edits.length,
            edit_results: editResult.edits,
            content_metrics: textMetrics(currentContent),
          });
        }
        contentStats.table_cleanup_completed += batch.length;
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      } catch (error: any) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        skippedCount += batch.length;
        contentStats.table_cleanup_completed += batch.length;
        logs = [...logs, `正文去表格跳过：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`];
        writeDeveloperLog('table_cleanup.batch.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          table_ids: batch.map((table: any) => table.id),
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      }
    }

    const remainingTables = extractContentTableBlocks(currentContent).length;
    if (remainingTables) {
      writeDeveloperLog('table_cleanup.section.remaining', {
        section_id: item.id,
        title: item.title || '未命名章节',
        remaining_tables: remainingTables,
      });
    }
    return { rewrittenCount, skippedCount: Math.max(0, originalTables.length - rewrittenCount) };
  }

  async function removeTablesBeforeIllustration(options: { targetItemId?: string } = {}): Promise<{ ran: boolean; rewrittenCount: number; skippedCount: number }> {
    if (tableRequirement !== 'none') {
      return { ran: false, rewrittenCount: 0, skippedCount: 0 };
    }

    contentStats.phase = 'table-cleaning';
    contentStats.table_cleanup_total = 0;
    contentStats.table_cleanup_completed = 0;
    contentStats.table_cleanup_rewritten = 0;
    contentStats.table_cleanup_skipped = 0;
    technicalPlan = await workspaceStore.updateTechnicalPlan({ contentGenerationRuntime: syncRuntime({ phase: 'table-cleaning' }) });
    const phaseSaved = technicalPlan;
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, phaseSaved as unknown as boolean);

    const targets = buildTableCleanupTargets(options.targetItemId || targetItemId);
    const tableTotal = targets.reduce((sum: number, target: any) => sum + target.tables.length, 0);
    contentStats.table_cleanup_total = tableTotal;

    if (!tableTotal) {
      logs = [...logs, '正文去表格检查完成：未发现需要转换的表格。'];
      await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      return { ran: true, rewrittenCount: 0, skippedCount: 0 };
    }

    logs = [...logs, `开始正文去表格：发现 ${targets.length} 个小节、${tableTotal} 个表格，将转换为普通文字描述。`];
    writeDeveloperLog('table_cleanup.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      section_count: targets.length,
      table_count: tableTotal,
      sections: targets.map(({ item, tables }: any) => ({ id: item.id, title: item.title || '未命名章节', table_count: tables.length })),
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);

    let rewrittenCount = 0;
    let skippedCount = 0;
    for (const target of targets) {
      await pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const result = await cleanupTablesForSection(target);
      rewrittenCount += result.rewrittenCount;
      skippedCount += result.skippedCount;
      contentStats.table_cleanup_skipped = skippedCount;
    }

    await pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
    logs = [...logs, `正文去表格完成：成功转换 ${rewrittenCount} 个表格，跳过 ${skippedCount} 个。`];
    writeDeveloperLog('table_cleanup.done', {
      table_count: tableTotal,
      rewritten_count: rewrittenCount,
      skipped_count: skippedCount,
    });
    await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
    return { ran: true, rewrittenCount, skippedCount };
  }

  // === 主流程（cjs:6400-6514，插图分支已裁剪） ===

  try {
    if (tasksToRun.length) {
      if (targetItemId) {
        await prepareSingleSectionPlan();
        await pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
        await restoreOriginalMaterialsIfNeeded(tasksToRun);
        await pauseIfRequested('正文生成已在原方案还原阶段暂停，可导出当前已完成内容，稍后继续。');
        await runItemsWithWorkerPool(tasksToRun, contentConcurrency, runOne, isPauseRequested);
        await pauseIfRequested('正文生成已在正文生成阶段暂停，可导出当前已完成内容，稍后继续。');
      } else {
        await planAll();
        await pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
        await restoreOriginalMaterialsIfNeeded(tasksToRun);
        await pauseIfRequested('正文生成已在原方案还原阶段暂停，可导出当前已完成内容，稍后继续。');
        await runEarlyContentProbeIfNeeded();
        if (tasksToRun.length) {
          await runContentTargetsWithWarmup(tasksToRun);
          await pauseIfRequested('正文生成已在正文生成阶段暂停，可导出当前已完成内容，稍后继续。');
        }
      }
    }

    if (!targetItemId) {
      if (retryContentCorrection) {
        logs = [...logs, '本次为内容矫正重试，跳过正文生成和最低字数扩写，直接进入内容矫正阶段。'];
        await updateTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, technicalPlan as unknown as boolean);
      } else {
        await runSectionWordAdjustmentsIfNeeded();
        await pauseIfRequested('正文生成已在小节字数检查后暂停，可导出当前已完成内容，稍后继续。');
        await ensureMinimumWords();
        await pauseIfRequested('正文生成已在全文最低字数检查后暂停，可导出当前已完成内容，稍后继续。');
        await ensureTotalWordBounds();
        await pauseIfRequested('正文生成已在全文字数上限检查后暂停，可导出当前已完成内容，稍后继续。');
      }
      if (originalPlanCoverageRepairMode === 'agent') {
        await runAgentOriginalCoverageRepairIfEnabled();
      } else {
        await runOriginalPlanCoverageAuditIfEnabled();
      }
      await pauseIfRequested('正文生成已在原方案覆盖审计后暂停，可导出当前已完成内容，稍后继续。');
      if (consistencyRepairMode === 'agent') {
        await runAgentConsistencyRepairIfEnabled();
      } else {
        await runConsistencyAuditIfEnabled();
      }
      await removeTablesBeforeIllustration();
      await pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
    } else {
      await runOriginalPlanCoverageAuditIfEnabled({ targetItemId });
      await pauseIfRequested('正文生成已在原方案覆盖审计后暂停，可导出当前已完成内容，稍后继续。');
      await runConsistencyAuditIfEnabled({ targetItemId });
      await removeTablesBeforeIllustration({ targetItemId });
      await pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
    }

    // finalize（Rule 8: 3-stage）
    const failedCount = leaves.filter(({ item }: any) => sections[item.id]?.status === 'error').length;
    const finalProgress = progressFor(leaves, sections);
    const finalStatus = taskStatusFor(leaves, sections);
    contentStats.phase = 'done';
    logs = [...logs, targetItemId
      ? (failedCount ? `小节重新生成结束，当前整体进度 ${finalProgress}%，${failedCount} 个小节失败。` : `小节重新生成完成，当前整体进度 ${finalProgress}%。`)
      : (failedCount ? `正文生成完成，${failedCount} 个小节失败。` : '正文生成完成。')];
    writeDeveloperLog('content.task.completed', {
      status: finalStatus,
      progress: finalProgress,
      failed_count: failedCount,
      stats: statsSnapshot(),
      touched_item_ids: [...touchedItemIds],
    });
    const finalizeTask = await updateTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false });
    await drainPersist(); // 止住后台节流写，避免事后覆盖 finalize 的 runtime:undefined
    technicalPlan = await workspaceStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: undefined,
      contentGenerationTask: finalizeTask,
    });
    await updateTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false }, technicalPlan as unknown as boolean);
  } catch (error: any) {
    if (isAiQueueScopePausedError(error)) {
      await persistPausedContentGeneration('正文生成已暂停，未发起的 AI 请求已从队列丢弃，可导出当前已完成内容，稍后继续。');
      writeDeveloperLog('content.task.paused', {
        message: error.message || 'queue paused',
        stats: statsSnapshot(),
        touched_item_ids: [...touchedItemIds],
      });
      return;
    }
    // 其余暂停 / 错误路径：先冲一次最新快照，确保崩溃恢复数据落库
    await flushPersistNow();
    if (isContentGenerationPausedError(error)) {
      writeDeveloperLog('content.task.paused', {
        message: error.message || 'paused',
        stats: statsSnapshot(),
        touched_item_ids: [...touchedItemIds],
      });
      return;
    }
    writeDeveloperLog('content.task.error', {
      error: error.message || '任务执行失败',
      stack: error.stack || '',
      stats: statsSnapshot(),
    });
    throw error;
  }
};
