// L4 runner #58：rejection-items-extraction（无效与废标项解析）。
// 移植自 client/electron/services/rejectionCheckTask.cjs:1518-1594（runRejectionItemsExtractionTask）
// + 1507-1516（updateExtractionState 助手）。
//
// 这是最简的 AI runner：单次 chat 调用（buildInvalidBidAndRejectionItemsPrompt 产 4 段 Markdown），
// 无 pause/resume、无状态机。用作 L4 harness 契约的端到端验证（config 线程 + aiService 桌面签名
// 包装 + workspaceStore 用户绑定门面 + updateTask 双参持久/广播）。
//
// 适配点（桌面→web）：
//  - updateExtractionState 改 async：web store 与 updateTask 均 async（桌面同步）。
//  - developerLogger/textMetrics/compactLogError 是可观测性 no-op，整体丢弃（与 L2 KB 抽取一致）。
//  - workspaceStore 经 engine buildRunnerWorkspaceStore 绑定 userId，runner 调用形如桌面单用户。
import type { TaskRunner, TaskRunnerContext } from '../types';
import { runBidAnalysisPromptTask, type BidAnalysisTaskSpec } from '../utils/bidAnalysis';
import { loadRejectionInvalidBidPrompt } from '../../prompts/store';
import { stripTripleQuoteWrapper } from '../../rejection-check/store';

interface RejectionCheckWorkspaceStore {
  loadRejectionCheck(): Promise<Record<string, unknown>>;
  updateRejectionCheck(partial: Record<string, unknown>): Promise<Record<string, unknown>>;
  readDocumentMarkdown(roleOrId?: string): Promise<string>;
  createDocumentSignature(document: unknown): string;
}

function now(): string {
  return new Date().toISOString();
}

// 对齐桌面 updateExtractionState（rejectionCheckTask.cjs:1507-1516），改 async。
// (B) updateTask(taskPartial) 只更新内存任务； (C) workspaceStore.updateRejectionCheck 持久化域数据
// （invalidBidAndRejectionItems 合并 + extractionTask）； (D) updateTask(taskPartial, rejectionCheck)
// 触发 engine 持久化任务字段 + 广播 {task, rejectionCheck} 快照。
// 注：web updateTask 第 2 参为 shouldPersist，rejectionCheck 对象 truthy 即走持久+广播分支；
// engine 重写 extractionTask 是无害冗余（同值），emit 用最新 load 的全量 state（含 (C) 的写入）。
async function updateExtractionState(
  workspaceStore: RejectionCheckWorkspaceStore,
  updateTask: TaskRunnerContext['updateTask'],
  taskPartial: Record<string, unknown>,
  extractionPartial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prev = (await workspaceStore.loadRejectionCheck()) || {};
  const task = await updateTask(taskPartial);
  const rejectionCheck = await workspaceStore.updateRejectionCheck({
    invalidBidAndRejectionItems: {
      ...(prev.invalidBidAndRejectionItems || {}),
      ...extractionPartial,
    },
    extractionTask: task,
  });
  await updateTask(taskPartial, rejectionCheck as unknown as boolean);
  return rejectionCheck;
}

export const runRejectionItemsExtractionTask: TaskRunner = async (ctx) => {
  const workspaceStore = ctx.workspaceStore as unknown as RejectionCheckWorkspaceStore;
  const { updateTask } = ctx;

  const state = workspaceStore.loadRejectionCheck ? await workspaceStore.loadRejectionCheck() : {};
  const tenderDocument = (state.tenderDocument as Record<string, unknown> | null) || null;
  if (typeof workspaceStore.readDocumentMarkdown !== 'function' || typeof workspaceStore.createDocumentSignature !== 'function') {
    throw new Error('废标项检查存储接口尚未初始化');
  }
  const tenderContent = String(await workspaceStore.readDocumentMarkdown('tender') || '');
  const tenderSignature = String(workspaceStore.createDocumentSignature({ ...tenderDocument, content: tenderContent }) || '');
  if (!tenderContent.trim() || !tenderSignature) throw new Error('缺少招标文件内容，无法解析无效与废标项');

  const logs = ['开始解析无效与废标项。'];
  await updateExtractionState(workspaceStore, updateTask, { status: 'running', progress: 5, logs }, {
    status: 'running',
    content: '',
    source: 'ai',
    tenderSignature,
    error: undefined,
    updatedAt: now(),
  });

  let content = '';
  try {
    // 提示词来源切换为 DB（itemKey=invalid_bid, runnerKey=rejection-check），兜底硬编码常量。
    const { promptText, output } = await loadRejectionInvalidBidPrompt(ctx.prisma);
    const invalidBidTask: BidAnalysisTaskSpec = {
      id: 'invalid_bid',
      label: '废标条款抽取',
      required: false,
      output,
      description: '无效投标/废标项抽取。',
      prompt: () => promptText,
    };
    content = await runBidAnalysisPromptTask({
      aiService: ctx.aiService,
      fileContent: tenderContent,
      task: invalidBidTask,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '无效与废标项解析失败';
    await updateExtractionState(workspaceStore, updateTask, {
      status: 'error',
      progress: 100,
      logs: [`无效与废标项解析失败：${message}`],
      error: message,
    }, {
      status: 'error',
      content: '',
      source: 'ai',
      tenderSignature,
      error: message,
      updatedAt: now(),
    });
    return;
  }

  const finalContent = stripTripleQuoteWrapper(content);
  const success = Boolean(finalContent.trim());
  await updateExtractionState(workspaceStore, updateTask, {
    status: success ? 'success' : 'error',
    progress: 100,
    logs: success ? ['无效与废标项解析完成。'] : ['无效与废标项解析失败：模型未返回解析内容。'],
    error: success ? undefined : '模型未返回解析内容',
  }, {
    status: success ? 'success' : 'error',
    content: finalContent,
    source: 'ai',
    tenderSignature,
    error: success ? undefined : '模型未返回解析内容',
    updatedAt: now(),
  });
};
