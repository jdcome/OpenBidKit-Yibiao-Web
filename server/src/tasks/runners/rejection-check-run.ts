// L4 runner #62：rejection-check-run（废标项检查）。
// 移植自 client/electron/services/rejectionCheckTask.cjs:1600-1733（updateCheckWorkspace + runRejectionCheckTask）。
//
// 这是 rejection-check 域的第二个 runner（#58 解析无效与废标项；#62 用其结果对投标文件做检查）。
// orchestration：读投标文件 + 检查项 → 并发跑 3 个子检查（废标项/错别字/逻辑，各可开关）→
// 每个子检查通过 onProgress 回调推进度，结果落入 rejectionCheckResult/typoCheckResult/logicCheckResult。
//
// 降级（M1）：子检查仅走非分段路径（rejectionCheckRunHelpers 里 shouldUseSegmented* 命中即抛错）。
// 桌面另有 rolling 状态机处理超大投标包，未移植。
//
// 适配点（桌面→web）：
//  - updateCheckWorkspace 改 async（web store/updateTask 均 async）。
//  - onProgress 改 async，子检查 await 它，保证进度写入与最终结果写入的顺序（桌面同步无此问题）。
//  - workspaceStore 经 engine buildRunnerWorkspaceStore 绑定 userId（5 个方法门面已就绪）。
//  - developerLogger/summarizeFindingsForLog 是可观测性 no-op，整体丢弃（与 #58 一致）。
import type { TaskRunner, TaskRunnerContext } from '../types';
import {
  createRunningResult,
  runRejectionItemCheck,
  runTypoCheck,
  runLogicCheck,
  type BidDocument,
  type RejectionCheckInput,
} from '../utils/rejectionCheckRunHelpers';

interface RejectionCheckWorkspaceStore {
  loadRejectionCheck(): Promise<Record<string, unknown>>;
  updateRejectionCheck(partial: Record<string, unknown>): Promise<Record<string, unknown>>;
  readDocumentMarkdown(roleOrId?: string): Promise<string>;
  createDocumentSignature(document: unknown): string;
  createRejectionCheckInputSignature(bidDocuments: unknown, invalidBidAndRejectionItems: unknown, customCheckItems: unknown): string;
}

function now(): string {
  return new Date().toISOString();
}

// 对齐桌面 updateCheckWorkspace（rejectionCheckTask.cjs:1600-1605），改 async。
// 与 updateExtractionState（#58）同构：partial 合并 checkTask 后整域持久 + 广播。
async function updateCheckWorkspace(
  workspaceStore: RejectionCheckWorkspaceStore,
  updateTask: TaskRunnerContext['updateTask'],
  taskPartial: Record<string, unknown>,
  partial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const task = await updateTask(taskPartial);
  const rejectionCheck = await workspaceStore.updateRejectionCheck({ ...partial, checkTask: task });
  await updateTask(taskPartial, rejectionCheck as unknown as boolean);
  return rejectionCheck;
}

export const runRejectionCheckTask: TaskRunner = async (ctx) => {
  const workspaceStore = ctx.workspaceStore as unknown as RejectionCheckWorkspaceStore;
  const { updateTask } = ctx;
  const aiService = ctx.aiService;

  const state = workspaceStore.loadRejectionCheck ? await workspaceStore.loadRejectionCheck() : {};
  const options = (state.checkOptions as Record<string, boolean>) || {};
  const payload = (ctx.payload as Record<string, unknown>) || {};
  const runOptions = { ...options, ...((payload.runOptions as Record<string, boolean>) || {}) };
  const bidDocumentsRaw = Array.isArray(state.bidDocuments) ? (state.bidDocuments as Array<Record<string, unknown>>) : [];

  if (
    typeof workspaceStore.readDocumentMarkdown !== 'function'
    || typeof workspaceStore.createDocumentSignature !== 'function'
    || typeof workspaceStore.createRejectionCheckInputSignature !== 'function'
  ) {
    throw new Error('废标项检查存储接口尚未初始化');
  }

  // readDocumentMarkdown 是 async（web 异步存储；桌面同步故直接 String() 即可），
  // 必须在 map 内 await——否则 content 变成 "[object Promise]"，AI 拿到的是占位串而非正文。
  const currentBidDocuments: BidDocument[] = (await Promise.all(
    bidDocumentsRaw.map(async (document): Promise<BidDocument> => ({
      id: String(document.id || ''),
      fileName: document.fileName ? String(document.fileName) : undefined,
      content: String((await workspaceStore.readDocumentMarkdown(String(document.id))) || ''),
    })),
  )).filter((document) => document.id && document.content.trim());

  const invalidBidAndRejectionItemsState = state.invalidBidAndRejectionItems as Record<string, unknown> | undefined;
  const invalidBidAndRejectionItems = String(invalidBidAndRejectionItemsState?.content || '');
  const customCheckItems = String(state.customCheckItems ?? '');
  const rejectionInputSignature = String(
    workspaceStore.createRejectionCheckInputSignature(currentBidDocuments, invalidBidAndRejectionItems, customCheckItems) || '',
  );
  const bidSignature = currentBidDocuments
    .map((document) => workspaceStore.createDocumentSignature(document))
    .filter(Boolean)
    .join('\n---yibiao-rejection-bid-signature---\n');

  if (!currentBidDocuments.length || !bidSignature) throw new Error('缺少投标文件内容，无法开始检查');

  const enabledTasks = [
    runOptions.rejectionCheck ? 'rejection' : '',
    runOptions.typoCheck ? 'typo' : '',
    runOptions.logicCheck ? 'logic' : '',
  ].filter(Boolean);
  if (!enabledTasks.length) throw new Error('请至少启用一种检查');
  if (runOptions.rejectionCheck && (!invalidBidAndRejectionItems.trim() || !rejectionInputSignature)) {
    throw new Error('请先完成无效与废标项解析');
  }

  let completed = 0;
  const logs = ['开始检查投标文件。'];
  const initialPartial: Record<string, unknown> = { checkOptions: options };
  if (runOptions.rejectionCheck) initialPartial.rejectionCheckResult = createRunningResult(rejectionInputSignature, '第一轮：正在分析检查范围。');
  if (runOptions.typoCheck) initialPartial.typoCheckResult = createRunningResult(bidSignature, '正在识别错别字候选。');
  if (runOptions.logicCheck) initialPartial.logicCheckResult = createRunningResult(bidSignature, '正在检查逻辑谬误。');
  await updateCheckWorkspace(workspaceStore, updateTask, { status: 'running', progress: 5, logs }, initialPartial);

  const updateOverall = async (label: string, partial: Record<string, unknown>): Promise<void> => {
    const progress = Math.min(95, Math.round(5 + (completed / enabledTasks.length) * 90));
    await updateCheckWorkspace(workspaceStore, updateTask, { status: 'running', progress, logs: [...logs, label] }, partial);
  };

  interface RunOneResult {
    kind: string;
    status: 'success' | 'error';
    error?: string;
  }

  async function runOne(
    kind: string,
    label: string,
    runner: (onProgress: (message: string) => Promise<void>) => Promise<unknown[]>,
    resultKey: string,
    inputSignature: string,
  ): Promise<RunOneResult> {
    try {
      const findings = await runner(async (message) => {
        await updateOverall(`${label}：${message}`, { [resultKey]: createRunningResult(inputSignature, message) });
      });
      completed += 1;
      await updateOverall(`${label}完成。`, {
        [resultKey]: {
          status: 'success',
          findings,
          inputSignature,
          activeFindingId: Array.isArray(findings) && findings.length ? (findings[0] as Record<string, unknown>).id : undefined,
          progressMessage: Array.isArray(findings) && findings.length ? `${label}发现 ${findings.length} 项` : `${label}未发现问题`,
          updatedAt: now(),
        },
      });
      return { kind, status: 'success' };
    } catch (error) {
      completed += 1;
      const message = error instanceof Error ? error.message : `${label}失败`;
      await updateOverall(`${label}失败：${message}`, {
        [resultKey]: { status: 'error', findings: [], inputSignature, error: message, progressMessage: message, updatedAt: now() },
      });
      return { kind, status: 'error', error: message };
    }
  }

  const tasks: Array<Promise<RunOneResult>> = [];
  if (runOptions.rejectionCheck) {
    const input: RejectionCheckInput = { invalidBidAndRejectionItems, customCheckItems, bidDocuments: currentBidDocuments };
    tasks.push(runOne('rejection', '废标项检查', (onProgress) => runRejectionItemCheck(aiService, input, onProgress), 'rejectionCheckResult', rejectionInputSignature));
  }
  if (runOptions.typoCheck) {
    tasks.push(runOne('typo', '错别字检查', (onProgress) => runTypoCheck(aiService, currentBidDocuments, onProgress), 'typoCheckResult', bidSignature));
  }
  if (runOptions.logicCheck) {
    tasks.push(runOne('logic', '逻辑谬误检查', (onProgress) => runLogicCheck(aiService, currentBidDocuments, onProgress), 'logicCheckResult', bidSignature));
  }

  const results = await Promise.all(tasks);
  const failed = results.filter((item) => item.status === 'error');
  await updateCheckWorkspace(workspaceStore, updateTask, {
    status: failed.length ? 'error' : 'success',
    progress: 100,
    logs: failed.length ? [`检查完成，${failed.length} 个任务失败。`] : ['检查完成。'],
    error: failed.length ? `${failed.length} 个检查任务失败` : undefined,
  }, {});
};
