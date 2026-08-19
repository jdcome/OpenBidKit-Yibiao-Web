// L4 runner #61：bid-analysis（招标文件解析，18 项抽取）。
// 移植自 client/electron/services/bidAnalysisTask.cjs:256-407（runBidAnalysisTask）。
//
// orchestration：normalizeBidAnalysisConfig → 读招标 markdown + 多标段守卫 → 切段 →
// 先单独跑 projectOverview（DeepSeek prompt cache 预热，等 5s）→ Promise.all 并发剩余项 →
// 检查必填项是否全部 success。每项结果落入 bidAnalysisTasks[id]；projectOverview/techRequirements
// 额外冗余写入顶层 projectOverview/techRequirements 字段（渲染器直接读顶层）。
//
// 降级（M1）：未移植 forceRerun 的下游清空分支在 web 端的语义差异（store 已支持，照搬）。
// 多段合并走 runBidAnalysisPromptTask（已在 utils 里实现 segments + mergeSegmentedAiResults）。
//
// 适配点（桌面→web）：
//  - 所有 workspaceStore.* / updateTask 均 async（桌面同步），逐处 await。
//  - readTenderMarkdown 在 web 是真读盘（P4-2 已接），不再是 P3 stub。
//  - updateBidAnalysisState 助手对齐桌面 updateTask(taskPartial, technicalPlan) 双参语义：
//    (B) updateTask(taskPartial) 内存任务； (C) workspaceStore.updateTechnicalPlan 持久域；
//    (D) updateTask(taskPartial, technicalPlan) 触发 engine 重写 bidAnalysisTask 字段 + 广播
//    {task, technicalPlanPatch} 快照（patch 从 FRESH load 装配，故 (C) 的写入可见）。
import type { TaskRunner, TaskRunnerContext } from '../types';
import { splitUserTextByContextLimit } from '../../document/userTextSplitter';
import {
  normalizeBidAnalysisConfig,
  buildBidSectionContextHint,
  runBidAnalysisPromptTask,
  PROMPT_CACHE_WARMUP_DELAY_MS,
  type BidAnalysisTaskSpec,
  type BidAnalysisItem,
} from '../utils/bidAnalysis';
import { loadBidAnalysisCatalog } from '../../prompts/store';

interface TechnicalPlanWorkspaceStore {
  loadTechnicalPlan(): Promise<Record<string, unknown>>;
  updateTechnicalPlan(partial: Record<string, unknown>): Promise<Record<string, unknown>>;
  readTenderMarkdown(): Promise<string>;
}

interface TenderFile {
  selectedSectionId?: string;
  selectedSectionTitle?: string;
}

function now(): string {
  return new Date().toISOString();
}

function waitForPromptCacheWarmup(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_CACHE_WARMUP_DELAY_MS));
}

// 单项状态条目（bidAnalysisTasks map 的值）。
function makeItem(task: BidAnalysisTaskSpec, status: BidAnalysisItem['status'], content: string, error?: string): BidAnalysisItem {
  const item: BidAnalysisItem = { id: task.id, label: task.label, status, content };
  if (error) item.error = error;
  return item;
}

// 对齐桌面 updateTask(taskPartial, technicalPlan) 三段式持久+广播（改 async）。
async function updateBidAnalysisState(
  workspaceStore: TechnicalPlanWorkspaceStore,
  updateTask: TaskRunnerContext['updateTask'],
  taskPartial: Record<string, unknown>,
  planPartial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const task = await updateTask(taskPartial);
  const technicalPlan = await workspaceStore.updateTechnicalPlan({ ...planPartial, bidAnalysisTask: task });
  await updateTask(taskPartial, technicalPlan as unknown as boolean);
  return technicalPlan;
}

export const runBidAnalysisTask: TaskRunner = async (ctx) => {
  const workspaceStore = ctx.workspaceStore as unknown as TechnicalPlanWorkspaceStore;
  const { updateTask } = ctx;
  const aiService = ctx.aiService;
  const payload = (ctx.payload as Record<string, unknown>) || {};

  // 提示词来源切换为 DB（runnerKey=bid-analysis），兜底硬编码常量。管线不变。
  const { systemPrompt, tasks: catalog } = await loadBidAnalysisCatalog(ctx.prisma);

  const config = normalizeBidAnalysisConfig(payload.mode, payload.selected_task_ids || payload.selectedTaskIds, catalog);
  const mode = config.mode;
  const selectedTaskIdSet = new Set(config.taskIds);
  const selectedTasks = catalog.filter((task) => selectedTaskIdSet.has(task.id));

  const fileContent = await workspaceStore.readTenderMarkdown();
  if (!String(fileContent || '').trim()) {
    throw new Error('请先上传招标文件，再开始解析');
  }

  const storedPlanForHint = (await workspaceStore.loadTechnicalPlan()) || {};
  if (storedPlanForHint.bidSectionMode === 'multiple') {
    if (
      storedPlanForHint.bidSectionExtractionStatus !== 'success'
      || !Array.isArray(storedPlanForHint.bidSections)
      || (storedPlanForHint.bidSections as unknown[]).length < 2
    ) {
      throw new Error('请先完成多标段识别，再开始解析招标文件');
    }
    const tenderFile = (storedPlanForHint.tenderFile as TenderFile | undefined) || {};
    if (!tenderFile.selectedSectionId || !tenderFile.selectedSectionTitle) {
      throw new Error('请先选择本次投标范围，再开始解析招标文件');
    }
    const sections = (storedPlanForHint.bidSections as Array<{ id: string }>) || [];
    const selectedExists = sections.some((section) => section.id === tenderFile.selectedSectionId);
    if (!selectedExists) {
      throw new Error('当前投标范围已失效，请重新选择标段');
    }
  }

  const tenderFile = (storedPlanForHint.tenderFile as TenderFile | undefined) || {};
  const selectedSectionId = tenderFile.selectedSectionId;
  const sections = (storedPlanForHint.bidSections as Array<Record<string, unknown>> | undefined) || [];
  const selectedSection = selectedSectionId
    ? sections.find((section) => section.id === selectedSectionId) || null
    : null;
  const sectionHint = buildBidSectionContextHint(selectedSection, {
    hasSelectedSection: storedPlanForHint.bidSectionMode === 'multiple' && Boolean(selectedSectionId),
  });

  const currentConfig = typeof aiService.getConfig === 'function' ? aiService.getConfig() : {};
  const fileSegments = splitUserTextByContextLimit(String(fileContent), currentConfig);
  const forceRerun = payload.force_rerun === true || payload.forceRerun === true;
  const requestedTaskIds = Array.isArray(payload.task_ids)
    ? new Set((payload.task_ids as unknown[]).filter((taskId): taskId is string => typeof taskId === 'string'))
    : null;
  const scopedTasks = requestedTaskIds
    ? selectedTasks.filter((task) => requestedTaskIds.has(task.id))
    : selectedTasks;
  if (requestedTaskIds && scopedTasks.length === 0) {
    throw new Error('未找到可重新解析的招标文件解析项');
  }

  function doneProgress(nextTasks: Record<string, BidAnalysisItem>): number {
    const done = selectedTasks.filter((task) => {
      const item = nextTasks[task.id];
      return item && (item.status === 'success' || item.status === 'error');
    }).length;
    return Math.round((done / selectedTasks.length) * 100);
  }

  function getMissingRequiredTasks(nextTasks: Record<string, BidAnalysisItem>): BidAnalysisTaskSpec[] {
    return catalog.filter((task) => {
      if (!task.required) return false;
      const item = nextTasks[task.id];
      return !(item?.status === 'success' && String(item.content || '').trim());
    });
  }

  const initialMessage = requestedTaskIds
    ? '开始重新解析选中的招标文件解析项。'
    : forceRerun
      ? '开始重新解析全部招标文件解析项。'
      : '开始解析招标文件。';
  const initialLogs = [initialMessage];

  const initialTask = await updateTask({ status: 'running', progress: 0, logs: initialLogs });
  let initialPartial: Record<string, unknown> = {
    bidAnalysisMode: mode,
    bidAnalysisSelectedTaskIds: config.taskIds,
    bidAnalysisTask: initialTask,
  };

  if (forceRerun && !requestedTaskIds) {
    const resetTasks: Record<string, BidAnalysisItem> = { ...((storedPlanForHint.bidAnalysisTasks as Record<string, BidAnalysisItem>) || {}) };
    for (const task of selectedTasks) {
      resetTasks[task.id] = makeItem(task, 'idle', '');
    }
    initialPartial = {
      ...initialPartial,
      projectOverview: '',
      techRequirements: '',
      bidAnalysisTasks: resetTasks,
      bidAnalysisProgress: 0,
      outlineGenerationTask: undefined,
      globalFactsTask: undefined,
      globalFacts: [],
      contentGenerationTask: undefined,
      contentGenerationOptions: undefined,
      contentGenerationSections: {},
      contentGenerationPlans: {},
      contentGenerationRuntime: undefined,
      outlineData: null,
    };
  }

  let technicalPlan = await updateBidAnalysisState(workspaceStore, updateTask, { status: 'running', progress: 0, logs: initialLogs }, initialPartial);
  const currentTasks = (technicalPlan.bidAnalysisTasks as Record<string, BidAnalysisItem>) || {};
  const tasksToRun = requestedTaskIds || forceRerun
    ? scopedTasks
    : scopedTasks.filter((task) => currentTasks[task.id]?.status !== 'success');

  async function runOne(task: BidAnalysisTaskSpec): Promise<void> {
    const runningPrev = (await workspaceStore.loadTechnicalPlan()) || {};
    const runningTasks: Record<string, BidAnalysisItem> = {
      ...((runningPrev.bidAnalysisTasks as Record<string, BidAnalysisItem>) || {}),
      [task.id]: makeItem(task, 'running', ''),
    };
    // 只落本项：并发解析时多个 runOne 同时写，传整张 map 会用各自加载的过期快照覆盖他项状态
    // （partAInfo 写 error 后被另一项的成功落库用旧快照覆盖回 running）。单行 upsert 互不干扰。
    technicalPlan = await updateBidAnalysisState(
      workspaceStore,
      updateTask,
      { status: 'running', progress: technicalPlan.bidAnalysisProgress as number || 0 },
      { bidAnalysisTasks: { [task.id]: runningTasks[task.id] }, bidAnalysisProgress: doneProgress(runningTasks) },
    );

    const content = await runBidAnalysisPromptTask({
      aiService,
      fileContent: String(fileContent),
      fileSegments,
      task,
      sectionHint,
      systemPrompt,
    });
    const trimmedContent = String(content || '').trim();
    if (!trimmedContent) {
      throw new Error(`${task.label}解析结果为空，请重新解析`);
    }

    const prev = (await workspaceStore.loadTechnicalPlan()) || {};
    const nextTasks: Record<string, BidAnalysisItem> = {
      ...((prev.bidAnalysisTasks as Record<string, BidAnalysisItem>) || {}),
      [task.id]: makeItem(task, 'success', trimmedContent),
    };
    const partial: Record<string, unknown> = {
      bidAnalysisTasks: { [task.id]: nextTasks[task.id] },
      bidAnalysisProgress: doneProgress(nextTasks),
    };
    if (task.id === 'projectOverview') partial.projectOverview = trimmedContent;
    if (task.id === 'techRequirements') partial.techRequirements = trimmedContent;
    technicalPlan = await updateBidAnalysisState(
      workspaceStore,
      updateTask,
      { status: 'running', progress: (technicalPlan.bidAnalysisProgress as number) || 0 },
      partial,
    );
  }

  async function handleTaskError(task: BidAnalysisTaskSpec, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : '解析失败';
    const prev = (await workspaceStore.loadTechnicalPlan()) || {};
    const prevItems = (prev.bidAnalysisTasks as Record<string, BidAnalysisItem>) || {};
    const prevItem = prevItems[task.id];
    const nextTasks: Record<string, BidAnalysisItem> = {
      ...prevItems,
      [task.id]: makeItem(task, 'error', prevItem?.content || '', message),
    };
    // 只落本项 error 态，避免被并发项的成功落库用旧快照覆盖（见 runOne 同类注释）。
    technicalPlan = await updateBidAnalysisState(
      workspaceStore,
      updateTask,
      { status: 'running', progress: (technicalPlan.bidAnalysisProgress as number) || 0, logs: [`${task.label}解析失败：${message}`] },
      { bidAnalysisTasks: { [task.id]: nextTasks[task.id] }, bidAnalysisProgress: doneProgress(nextTasks) },
    );
  }

  async function runOneSafely(task: BidAnalysisTaskSpec): Promise<boolean> {
    try {
      await runOne(task);
      return true;
    } catch (error) {
      await handleTaskError(task, error);
      return false;
    }
  }

  const projectOverviewTask = tasksToRun.find((task) => task.id === 'projectOverview');
  const remainingTasks = tasksToRun.filter((task) => task.id !== 'projectOverview');
  if (projectOverviewTask) {
    const warmupSucceeded = await runOneSafely(projectOverviewTask);
    if (warmupSucceeded && remainingTasks.length) {
      technicalPlan = await updateBidAnalysisState(
        workspaceStore,
        updateTask,
        { status: 'running', progress: (technicalPlan.bidAnalysisProgress as number) || 0, logs: ['提示词缓存预热完成，等待 5 秒后开始并发解析剩余项。'] },
        {},
      );
      await waitForPromptCacheWarmup();
    }
  }
  await Promise.all(remainingTasks.map(runOneSafely));

  const latestPlan = (await workspaceStore.loadTechnicalPlan()) || {};
  const missingRequiredTasks = getMissingRequiredTasks((latestPlan.bidAnalysisTasks as Record<string, BidAnalysisItem>) || {});
  if (missingRequiredTasks.length) {
    const missingLabels = missingRequiredTasks.map((task) => task.label).join('、');
    const message = `必填解析项未完成：${missingLabels}，请重新解析失败项。`;
    await updateBidAnalysisState(
      workspaceStore,
      updateTask,
      { status: 'error', progress: 100, error: message, logs: [message] },
      {},
    );
    return;
  }

  await updateBidAnalysisState(
    workspaceStore,
    updateTask,
    { status: 'success', progress: 100, error: undefined, logs: ['招标文件解析完成。'] },
    {},
  );
};
