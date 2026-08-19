// L4 runner #60：global-facts-generation（全局事实变量生成）。
// 移植自 client/electron/services/globalFactsTask.cjs:778-883（runGlobalFactsTask orchestration）。
//
// 4 步流水线（详细见 utils/globalFactsHelpers.ts 头注）：
//   1) 招标文件分段抽取 → groups（22→48%）
//   2) 知识库分段补充 → patches → 应用到 groups（48→66%）
//   3) 原方案分段补充（仅 existing-plan-expansion 工作流，66→86%）
//   4) 最终整理 → 最终 groups（86→100%）
//
// 适配点（桌面→web）：
//  - log 改 async（web store/updateTask 均 async）；helper 内全部 await log(...)（见 utils）。
//  - workspaceStore.loadTechnicalPlan/updateTechnicalPlan/readTenderMarkdown/readOriginalPlanMarkdown 均 async。
//  - updateBidAnalysisState 助手对齐桌面 updateTask(taskPartial, technicalPlan) 双参语义（同 #61）。
//  - knowledgeBaseService.readItems 在 utils.loadKnowledgeItems 内 await（公司共享无 userId）。
import type { TaskRunner, TaskRunnerContext } from '../types';
import {
  runTenderGlobalFactsExtraction,
  runKnowledgeGlobalFactPatches,
  runOriginalPlanGlobalFactPatches,
  finalizeGlobalFacts,
  mergeGlobalFactPatches,
  loadKnowledgeItems,
  normalizeReferenceDocumentIds,
  formatBidAnalysisFactsForPrompt,
  validateGlobalFactsMinimumQuality,
  sourceRequiresDurationFact,
  buildGlobalFactsFromAnalysisContext,
  type GlobalFactGroup,
  type BaseContext,
  type KnowledgeItem,
} from '../utils/globalFactsHelpers';
import { buildBidSectionContextHint } from '../utils/bidAnalysis';

interface TechnicalPlanWorkspaceStore {
  loadTechnicalPlan(): Promise<Record<string, unknown>>;
  updateTechnicalPlan(partial: Record<string, unknown>): Promise<Record<string, unknown>>;
  readTenderMarkdown(): Promise<string>;
  readOriginalPlanMarkdown?: () => Promise<string>;
}

// 对齐桌面 updateTask(taskPartial, technicalPlan) 三段式持久+广播（改 async，同 #61）。
async function persistGlobalFacts(
  workspaceStore: TechnicalPlanWorkspaceStore,
  updateTask: TaskRunnerContext['updateTask'],
  taskPartial: Record<string, unknown>,
  planPartial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const task = await updateTask(taskPartial);
  const technicalPlan = await workspaceStore.updateTechnicalPlan({ ...planPartial, globalFactsTask: task });
  await updateTask(taskPartial, technicalPlan as unknown as boolean);
  return technicalPlan;
}

export const runGlobalFactsGenerationTask: TaskRunner = async (ctx) => {
  const workspaceStore = ctx.workspaceStore as unknown as TechnicalPlanWorkspaceStore;
  const { updateTask, diagnosticTraceId, aiDiagnostics } = ctx;
  const aiService = ctx.aiService;
  const knowledgeBaseService = ctx.knowledgeBaseService as { readItems?: (documentId: string) => Promise<Array<Record<string, unknown>>> } | null;

  let logs = ['开始生成全局事实变量。'];
  let currentProgress = 5;
  const log = async (message: string, progress = currentProgress): Promise<void> => {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    await persistGlobalFacts(workspaceStore, updateTask, { status: 'running', progress: currentProgress, logs }, {});
  };

  const storedPlan = (await workspaceStore.loadTechnicalPlan()) || {};
  const tenderMarkdown = await workspaceStore.readTenderMarkdown();
  if (!String(tenderMarkdown || '').trim()) {
    throw new Error('请先上传招标文件，再生成全局事实');
  }
  const isExpansionWorkflow = storedPlan.workflowKind === 'existing-plan-expansion';
  let originalPlanMarkdown = '';
  if (isExpansionWorkflow) {
    if (!storedPlan.originalPlanFile) {
      throw new Error('请先上传原方案，再生成全局事实');
    }
    if (typeof workspaceStore.readOriginalPlanMarkdown !== 'function') {
      throw new Error('原方案读取服务尚未初始化');
    }
    originalPlanMarkdown = await workspaceStore.readOriginalPlanMarkdown();
    if (!String(originalPlanMarkdown || '').trim()) {
      throw new Error('请先上传原方案，再生成全局事实');
    }
  }
  const outlineData = storedPlan.outlineData as { outline?: unknown[] } | null;
  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成全局事实');
  }

  await persistGlobalFacts(workspaceStore, updateTask, { status: 'running', progress: 5, logs }, {
    globalFacts: [],
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
  });

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const bidAnalysisFactsText = formatBidAnalysisFactsForPrompt(storedPlan);
  await log('正在读取招标文件、Step02 解析结果、目录和参考知识库。', 10);
  if (isExpansionWorkflow) {
    await log('已读取原方案，本次将优先从原方案抽取全局事实变量。', 18);
  }
  const knowledgeItems: KnowledgeItem[] = await loadKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, log);

  const tenderFile = (storedPlan.tenderFile as { selectedSectionId?: string } | undefined) || {};
  const sections = (storedPlan.bidSections as Array<Record<string, unknown>> | undefined) || [];
  const selectedSectionId = tenderFile.selectedSectionId;
  const selectedSection = selectedSectionId
    ? sections.find((section) => section.id === selectedSectionId) || null
    : null;
  const sectionHint = buildBidSectionContextHint(selectedSection, {
    hasSelectedSection: storedPlan.bidSectionMode === 'multiple' && Boolean(selectedSectionId),
  });

  const baseContext: BaseContext = {
    projectOverview: String(storedPlan.projectOverview || ''),
    outlineData,
    bidAnalysisFactsText,
    knowledgeItems,
    sectionHint,
    isExpansionWorkflow,
  };
  const requireDuration = sourceRequiresDurationFact(`${tenderMarkdown}\n${baseContext.projectOverview}`);

  await log('第一步：正在按招标文件分段提取全局事实变量。', 22);
  let tenderFacts;
  try {
    tenderFacts = await runTenderGlobalFactsExtraction(aiService, baseContext, tenderMarkdown, log);
  } catch (error) {
    const fallback = buildGlobalFactsFromAnalysisContext(baseContext);
    tenderFacts = { groups: fallback.groups, degraded: true, diagnostics: { fallbackStage: 'tender-segment', warnings: fallback.warnings } };
    await log('招标文件分段抽取失败，已采用 STEP 02 的有效项目事实继续处理。', 44);
  }
  let groups: GlobalFactGroup[] = tenderFacts.groups;
  let degraded = Boolean(tenderFacts.degraded);
  let fallbackStage = tenderFacts.diagnostics?.fallbackStage || '';
  let warnings = [...(tenderFacts.diagnostics?.warnings || [])];
  await persistGlobalFacts(workspaceStore, updateTask, { status: 'running', progress: 48, logs }, { globalFacts: groups });

  const knowledgePatch = await runKnowledgeGlobalFactPatches(aiService, { ...baseContext, groups }, knowledgeItems, log);
  if (knowledgePatch.patches?.length) {
    groups = mergeGlobalFactPatches(groups, knowledgePatch.patches);
    await persistGlobalFacts(workspaceStore, updateTask, { status: 'running', progress: 66, logs }, { globalFacts: groups });
    await log(`知识库全局事实补充已应用：${knowledgePatch.patches.length} 条。`, 66);
  } else if (knowledgeItems.length) {
    await log('知识库未返回需要补充的全局事实变量。', 66);
  }

  if (isExpansionWorkflow) {
    const originalPatch = await runOriginalPlanGlobalFactPatches(aiService, { ...baseContext, groups }, originalPlanMarkdown, log);
    if (originalPatch.patches?.length) {
      groups = mergeGlobalFactPatches(groups, originalPatch.patches);
      await persistGlobalFacts(workspaceStore, updateTask, { status: 'running', progress: 86, logs }, { globalFacts: groups });
      await log(`原方案全局事实补充已应用：${originalPatch.patches.length} 条。`, 86);
    } else {
      await log('原方案未返回需要补充的全局事实变量。', 86);
    }
  }

  try {
    const finalFacts = await finalizeGlobalFacts(aiService, { ...baseContext, groups }, log);
    validateGlobalFactsMinimumQuality(finalFacts.groups, { requireDuration });
    groups = finalFacts.groups;
  } catch (error) {
    validateGlobalFactsMinimumQuality(groups, { requireDuration });
    degraded = true;
    fallbackStage = 'final-review';
    warnings.push('最终整理失败，已保留通过最低质量校验的上一阶段结果。');
    if (!requireDuration && !warnings.some((warning) => warning.includes('未补造期限值'))) {
      warnings.push('来源未识别到整体期限字段，未补造期限值。');
    }
    await log('最终整理失败，已安全保留上一阶段的有效全局事实。', 92);
  }
  if (degraded && diagnosticTraceId && aiDiagnostics) {
    await aiDiagnostics.markFallback(diagnosticTraceId, fallbackStage, warnings);
  }
  await log(`全局事实变量合并完成：${groups.length} 个大项。`, 92);
  const diagnostics = { trace_id: diagnosticTraceId, degraded, fallback_stage: fallbackStage || undefined, warnings };
  await persistGlobalFacts(workspaceStore, updateTask, {
    status: 'success', progress: 100, degraded, stats: { diagnostics },
    logs: [...logs, degraded ? '全局事实变量生成完成（已使用安全降级结果）。' : '全局事实变量生成完成。'],
  }, { globalFacts: groups });
};
