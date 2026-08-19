// L4 runner #64：outline-generation（技术方案目录生成）编排入口。
// 移植自 client/electron/services/outlineGenerationTask.cjs:2935-3049（runOutlineGenerationTask）。
//
// 三分支（由 workflowKind/outlineExpansionMode 决定）：
//   - existing-plan-expansion + original-only：直接用旧目录，跳过 AI 补充/知识库/最终审核。
//   - existing-plan-expansion + ai-complement：expansionComplementWorkflow（基于旧目录补齐）。
//   - 其它（technical-plan）：alignedWorkflow（评分大类 → 一级目录对齐 → 并发二三级）。
// 后两者再过 enhanceOutlineWithKnowledgeAdditions + runFinalOutlineGate。
//
// Agent 掎合：isOriginalOutlineAgentModeEnabled 启用且 sidecar 在线时走 Agent 抽取原方案目录，
// 否则回退 LLM 提取；最终 gate / 一致性修复经 helpers 里的 agent 函数调用 agentService.runTask。
// sidecar 不可用时 agent 守卫降级，happy LLM 路径不受影响。
//
// 适配点（桌面→web）：
//  - log 改 async（store/updateTask 均 async），persistOutline 三段式（同 #60 persistGlobalFacts）。
//  - workspaceStore.loadTechnicalPlan/updateTechnicalPlan/readOriginalPlanMarkdown 均 async。
//  - knowledgeBaseService.getOutlineReferences 同步（KB store 内存读取）。
import type { TaskRunner } from '../types';
import type { AgentService } from '../../agent/types';
import {
  extractOriginalOutline,
  expansionComplementWorkflow,
  alignedWorkflow,
  enhanceOutlineWithKnowledgeAdditions,
  runFinalOutlineGate,
  loadOutlineKnowledgeItems,
  normalizeReferenceDocumentIds,
  normalizeOutlineExpansionMode,
  normalizeMirrorProcurement,
  getMissingRequiredBidAnalysisLabels,
  isOriginalOutlineAgentModeEnabled,
  extractOriginalOutlineWithAgent,
  formatOldOutlineForPrompt,
  type OutlineAiService,
  type OutlinePayload,
  type OutlineWorkspaceStore,
  type OutlineKnowledgeBaseService,
} from '../utils/outlineGenerationHelpers';
import { loadMirrorStructureExtractPrompt } from '../../prompts/store';
import { buildAndMergeMirrorOutline, extractProcurementListText } from '../utils/mirrorProcurement';
import {
  extractTechnicalProposalStructureRequirement,
  formatTechnicalProposalStructureForPrompt,
  type TechnicalProposalStructureRequirement,
} from '../utils/technicalProposalStructure';
import { buildProposalStructureCoverage } from '../utils/proposalStructureCoverage';
import { buildScopedTenderMarkdown } from '../../technical-plan/selectedSectionMarkdown';

interface TechnicalPlanWorkspaceStore {
  loadTechnicalPlan(): Promise<Record<string, unknown>>;
  updateTechnicalPlan(partial: Record<string, unknown>): Promise<Record<string, unknown>>;
  readOriginalPlanMarkdown?: () => Promise<string>;
  readTenderMarkdown?: () => Promise<string>;
}

// 对齐桌面 updateTask(taskPartial, technicalPlan) 三段式持久+广播（改 async，同 #60）。
async function persistOutline(
  workspaceStore: TechnicalPlanWorkspaceStore,
  updateTask: Parameters<TaskRunner>[0]['updateTask'],
  taskPartial: Record<string, unknown>,
  planPartial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const task = await updateTask(taskPartial);
  const technicalPlan = await workspaceStore.updateTechnicalPlan({ ...planPartial, outlineGenerationTask: task });
  await updateTask(taskPartial, technicalPlan as unknown as boolean);
  return technicalPlan;
}

function normalizeWordWan(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : 0;
}

function normalizeOutlineWordControlOptions(value: unknown): Record<string, unknown> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    minWordsWan: normalizeWordWan(input.minWordsWan),
    maxWordsWan: normalizeWordWan(input.maxWordsWan),
    wordsPerSectionWan: normalizeWordWan(input.wordsPerSectionWan),
    forceSectionWords: input.forceSectionWords === true,
  };
}

function buildOutlineWordControlSnapshot(options: Record<string, unknown>, outline?: OutlinePayload): Record<string, unknown> {
  const minWords = Math.round(Number(options.minWordsWan || 0) * 10000);
  const maxWords = Math.round(Number(options.maxWordsWan || 0) * 10000);
  const wordsPerSection = Math.round(Number(options.wordsPerSectionWan || 0) * 10000);
  const rootCount = Array.isArray(outline?.outline) ? outline!.outline!.length : 0;
  const estimatedMinPages = minWords > 0 ? Math.max(1, Math.round(minWords / 500)) : 0;
  const estimatedMaxPages = maxWords > 0 ? Math.max(1, Math.round(maxWords / 500)) : 0;
  const estimatedSectionCount = wordsPerSection > 0 && (minWords > 0 || maxWords > 0)
    ? Math.max(1, Math.ceil((minWords || maxWords) / wordsPerSection))
    : 0;
  return {
    ...options,
    minWords,
    maxWords,
    wordsPerSection,
    estimatedMinPages,
    estimatedMaxPages,
    estimatedSectionCount,
    rootCount,
    capturedAt: new Date().toISOString(),
  };
}

function buildOutlineWordControlInstruction(options: Record<string, unknown>): string {
  const minWords = Math.round(Number(options.minWordsWan || 0) * 10000);
  const maxWords = Math.round(Number(options.maxWordsWan || 0) * 10000);
  const wordsPerSection = Math.round(Number(options.wordsPerSectionWan || 0) * 10000);
  if (minWords <= 0 && maxWords <= 0 && wordsPerSection <= 0) {
    return '';
  }
  const sectionWords = wordsPerSection > 0 ? wordsPerSection : 3000;
  const targetLeafCount = minWords > 0 && maxWords > 0
    ? Math.ceil(((minWords + maxWords) / 2) / sectionWords)
    : maxWords > 0
      ? Math.max(1, Math.floor(maxWords / sectionWords) - 2)
      : minWords > 0
        ? Math.ceil(minWords / sectionWords) + 2
        : 0;
  const parts = [
    `最少字数：${minWords || '不限制'} 字`,
    `最多字数：${maxWords || '不限制'} 字`,
    `每小节字数：${wordsPerSection || '未设置，按 3000 字估算'} 字`,
  ];
  return [
    'STEP03 字数/页数预设用于目录规划和后续正文生成。',
    parts.join('；'),
    targetLeafCount > 0
      ? `请在满足技术评分覆盖完整性的前提下，控制最终叶子小节数量接近 ${targetLeafCount} 个；不要为了凑数量拆出空泛、重复或无法独立成文的小节。`
      : '未形成明确叶子小节数量目标，请按评分覆盖完整性自然生成目录。',
  ].join('\n');
}

function summarizeProposalStructureItems(requirement: TechnicalProposalStructureRequirement, limit = 9): string {
  return (requirement.items || [])
    .slice(0, limit)
    .map((item) => item.title)
    .filter(Boolean)
    .join('、');
}

async function confirmProposalStructureStrategy(
  agentService: AgentService | undefined,
  projectId: number,
  requirement: TechnicalProposalStructureRequirement,
  log: (message: string, progress?: number) => Promise<void>,
): Promise<void> {
  if (requirement.mode !== 'explicit_checklist' || requirement.items.length < 2) return;
  const itemSummary = summarizeProposalStructureItems(requirement);
  const title = requirement.title || '技术/响应方案';
  await log(`已识别“${title}”章节要求 ${requirement.items.length} 项。`, 8);
  if (!agentService?.requestQuestion) {
    await log('Agent 确认通道不可用，已按推荐综合方案处理：评分表作为一级目录主线，响应方案清单并入二级/三级目录。', 8);
    return;
  }
  let resolution;
  try {
    resolution = await agentService.requestQuestion({
      task_id: `step03-proposal-structure-${projectId}`,
      task_title: 'STEP03 目录策略确认',
      project_id: projectId,
      question: `已检测到招标文件存在“${title}”章节要求，共 ${requirement.items.length} 项参考内容。系统建议：技术评分表仍作为一级目录主线；“${title}”的 ${requirement.items.length} 项内容作为二级/三级目录补充并入，确保既覆盖评分点，也符合招标文件章节要求。`,
      options: [
        {
          id: 'recommended',
          label: '按推荐综合方案处理',
          description: '评分表决定一级目录，响应方案清单并入二级/三级目录。',
          recommended: true,
        },
        {
          id: 'defer',
          label: '稍后处理',
          description: '暂停本次目录生成，先不继续消耗模型额度。',
        },
      ],
      metadata: {
        kind: 'step03-proposal-structure',
        title,
        item_count: requirement.items.length,
        item_summary: itemSummary,
        items: requirement.items,
      },
    });
  } catch (error) {
    await log(`目录策略确认弹窗不可用，已按推荐综合方案继续：${error instanceof Error ? error.message : String(error)}`, 8);
    return;
  }
  if (resolution?.option_id === 'defer') {
    throw new Error('已选择稍后处理，目录生成已暂停。');
  }
  await log(`已确认按推荐综合方案处理“${title}”：评分表作为一级目录主线，${requirement.items.length} 项响应方案清单并入二级/三级目录。`, 8);
}

export const runOutlineGenerationTask: TaskRunner = async (ctx) => {
  const workspaceStore = ctx.workspaceStore as unknown as TechnicalPlanWorkspaceStore & OutlineWorkspaceStore;
  const { updateTask, payload } = ctx;
  const aiService = ctx.aiService as unknown as OutlineAiService;
  const agentService = ctx.agentService;
  const knowledgeBaseService = ctx.knowledgeBaseService as OutlineKnowledgeBaseService | null;

  let logs = ['开始生成目录。'];
  let currentProgress = 5;
  const log = async (message: string, progress = currentProgress): Promise<void> => {
    currentProgress = Math.max(currentProgress, Math.min(progress, 99));
    logs = [...logs, message];
    await persistOutline(workspaceStore, updateTask, { status: 'running', progress: currentProgress, logs }, {});
  };

  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(payload);
  const storedPlan = (await workspaceStore.loadTechnicalPlan()) || {};
  const overview = String(storedPlan.projectOverview || '');
  const requirements = String(storedPlan.techRequirements || '');
  const missingRequiredBidAnalysisLabels = getMissingRequiredBidAnalysisLabels(storedPlan);
  if (missingRequiredBidAnalysisLabels.length) {
    throw new Error(`请先完成关键招标文件解析项：${missingRequiredBidAnalysisLabels.join('、')}`);
  }
  let tenderMarkdownForOutline = '';
  let tenderMarkdownScope: ReturnType<typeof buildScopedTenderMarkdown> = { markdown: '', applied: false, ranges: [] };
  if (typeof workspaceStore.readTenderMarkdown === 'function') {
    try {
      const rawTenderMarkdown = await workspaceStore.readTenderMarkdown();
      tenderMarkdownScope = buildScopedTenderMarkdown(rawTenderMarkdown, storedPlan);
      tenderMarkdownForOutline = tenderMarkdownScope.markdown;
      if (tenderMarkdownScope.applied) {
        await log(
          `已按当前投标范围“${tenderMarkdownScope.selectedSectionTitle || '已选标段'}”裁剪招标原文，后续目录识别与镜像章节仅使用该范围。`,
          8,
        );
      }
    } catch (error) {
      await log(`读取招标 Markdown 失败，跳过技术/响应方案章节要求识别：${error instanceof Error ? error.message : String(error)}`, 8);
    }
  }
  const proposalStructureRequirement = extractTechnicalProposalStructureRequirement(tenderMarkdownForOutline);
  const proposalStructureInstruction = formatTechnicalProposalStructureForPrompt(proposalStructureRequirement);
  if (proposalStructureRequirement.mode === 'self_defined') {
    await log('已识别技术/响应方案要求：格式自拟，未发现硬性章节清单，本次按技术评分表优先生成目录。', 8);
  } else if (proposalStructureRequirement.mode === 'explicit_checklist') {
    await confirmProposalStructureStrategy(agentService, ctx.projectId, proposalStructureRequirement, log);
  }
  const isExpansionWorkflow = storedPlan.workflowKind === 'existing-plan-expansion';
  const outlineExpansionMode = isExpansionWorkflow ? normalizeOutlineExpansionMode(payload, storedPlan) : 'ai-complement';
  const mirrorProcurement = normalizeMirrorProcurement(payload, storedPlan);
  const outlineWordControlOptions = normalizeOutlineWordControlOptions(
    (payload as Record<string, unknown>).outline_word_control_options
    || (payload as Record<string, unknown>).outlineWordControlOptions
    || (storedPlan as Record<string, unknown>).outlineWordControlOptions,
  );
  const baseTaskPayload = {
    ...payload,
    project_id: ctx.projectId,
    overview,
    requirements,
    outlineExpansionMode,
    mirrorProcurement,
    outlineWordControlOptions,
    outline_word_control_options: outlineWordControlOptions,
    wordControlInstruction: buildOutlineWordControlInstruction(outlineWordControlOptions),
    proposalStructureRequirement,
    proposalStructureInstruction,
    reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
  };

  await persistOutline(workspaceStore, updateTask, { status: 'running', progress: 5, logs }, {
    outlineMode: 'aligned',
    outlineExpansionMode,
    mirrorProcurement,
    outlineWordControlOptions,
    referenceKnowledgeDocumentIds,
  });

  let oldOutline: OutlinePayload | null = null;
  if (isExpansionWorkflow) {
    if (!storedPlan.originalPlanFile) {
      throw new Error('请先上传原方案，再生成目录');
    }
    if (typeof workspaceStore.readOriginalPlanMarkdown !== 'function') {
      throw new Error('原方案读取服务尚未初始化');
    }
    const originalPlanMarkdown = await workspaceStore.readOriginalPlanMarkdown();
    if (!String(originalPlanMarkdown || '').trim()) {
      throw new Error('请先上传原方案，再生成目录');
    }
    // 原方案目录 Agent 抽取：配置启用且 sidecar 在线（agentService?.runTask）时走 Agent，
    // 否则回退 LLM 提取（与桌面无 Agent 时一致，避免 sidecar 未就绪时硬失败阻断扩写流程）。
    oldOutline = isOriginalOutlineAgentModeEnabled(aiService) && agentService?.runTask
      ? await extractOriginalOutlineWithAgent(agentService, workspaceStore, baseTaskPayload, originalPlanMarkdown, log)
      : await extractOriginalOutline(aiService, workspaceStore, originalPlanMarkdown, log);
  }

  await persistOutline(workspaceStore, updateTask, { status: 'running', progress: currentProgress, logs }, {
    outlineData: null,
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
  });

  const taskPayload = {
    ...baseTaskPayload,
    oldOutline: formatOldOutlineForPrompt(oldOutline),
  };

  let outline: OutlinePayload;
  let groups: Awaited<ReturnType<typeof alignedWorkflow>>['groups'] = [];
  if (isExpansionWorkflow) {
    if (outlineExpansionMode === 'original-only') {
      await log('已选择仅使用原方案目录，跳过AI补充和知识库补目录。', 96);
      await persistOutline(workspaceStore, updateTask, { status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] }, {
        outlineData: { ...(oldOutline as OutlinePayload), project_overview: overview },
        outlineWordControlSnapshot: buildOutlineWordControlSnapshot(outlineWordControlOptions, oldOutline as OutlinePayload),
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentGenerationRuntime: undefined,
      });
      return;
    }
    outline = await expansionComplementWorkflow(aiService, taskPayload, oldOutline as OutlinePayload, log);
  } else {
    const alignedResult = await alignedWorkflow(aiService, agentService, taskPayload, log);
    outline = alignedResult.outline;
    groups = alignedResult.groups || [];
  }

  const knowledgeItems = loadOutlineKnowledgeItems(knowledgeBaseService, referenceKnowledgeDocumentIds, log);
  outline = await enhanceOutlineWithKnowledgeAdditions(aiService, taskPayload, outline, knowledgeItems, log);
  const proposalCoverageBeforeFinal = buildProposalStructureCoverage(proposalStructureRequirement, outline);
  const finalResult = await runFinalOutlineGate({
    aiService,
    agentService,
    payload: taskPayload,
    outline,
    groups,
    originalOutline: oldOutline,
    workflowKind: isExpansionWorkflow ? 'existing-plan-expansion' : 'technical-plan',
    outlineExpansionMode,
    log,
  });
  outline = finalResult.outline;
  // 镜像采购需求章：AI 大纲落库前，若开启则提取需求章结构并作为独立顶级章「项目概述」插到最前。
  // 失败/未命中不阻塞 AI 大纲（已生成），仅记日志跳过。
  if (mirrorProcurement) {
    try {
      const tenderMarkdown = tenderMarkdownForOutline || (typeof workspaceStore.readTenderMarkdown === 'function'
        ? await workspaceStore.readTenderMarkdown()
        : '');
      if (tenderMarkdown.trim()) {
        const structureExtractPrompt = await loadMirrorStructureExtractPrompt(ctx.prisma);
        const procurementListText = tenderMarkdownScope.applied ? '' : extractProcurementListText(storedPlan);
        const merged = await buildAndMergeMirrorOutline({
          aiService,
          tenderMarkdown,
          procurementListText,
          structureExtractPrompt,
          existingOutline: outline.outline || [],
        });
        if (merged.matched) {
          outline = { ...outline, outline: merged.outline };
          await log('已识别采购需求章并生成镜像顶级章「项目概述」插入目录最前。', currentProgress);
        } else {
          await log('未识别到采购需求类章节，已跳过镜像章节。', currentProgress);
        }
      } else {
        await log('未读取到招标原文，已跳过镜像采购需求章节。', currentProgress);
      }
    } catch (err) {
      await log(`镜像采购需求章节生成失败，已跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const proposalStructureCoverage = buildProposalStructureCoverage(proposalStructureRequirement, outline, {
    baseline: proposalCoverageBeforeFinal,
  });
  if (proposalStructureCoverage) {
    await log(
      `响应方案覆盖矩阵生成完成：${proposalStructureCoverage.covered_total}/${proposalStructureCoverage.total} 项覆盖，${proposalStructureCoverage.repaired} 项由最终审核修复，${proposalStructureCoverage.missing} 项缺失。`,
      currentProgress,
    );
  }
  const finalTaskPartial: Record<string, unknown> = { status: 'success', progress: 100, logs: [...logs, '目录生成完成。'] };
  if (proposalStructureCoverage) {
    finalTaskPartial.stats = { proposalStructureCoverage };
  }
  await persistOutline(workspaceStore, updateTask, finalTaskPartial, {
    outlineData: { ...outline, project_overview: overview },
    outlineWordControlSnapshot: buildOutlineWordControlSnapshot(outlineWordControlOptions, outline),
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
  });
};
