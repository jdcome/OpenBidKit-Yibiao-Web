// M1-P6 Layer 2：知识库 LLM 抽取/匹配异步流水线（步骤 4-9）。
// 忠实移植自 client/electron/services/knowledgeBaseService.cjs 的 prepareDocument(步骤 4-6) +
// matchDocument(步骤 7-9)，合并成一条后台任务。P4 已在请求内同步跑完 1-3 停在 awaiting_extraction；
// 本模块接管后续：extract_first_items → extract_supplement_items → merge_candidates
// →（ready_for_matching）→ match_batches(逐批 checkpoint) → recover_missing → save_result → success。
//
// 触发：upload/retry 路由在 prepareDocument 成功后 fire-and-forget；/match 路由显式重跑（force）。
// 进度：每次 status 变更经 eventBus 推 {document} 到 'kb-document' 通道（按 projectId 隔离）。
// 幂等：stepCanReuse 跳过已完成步骤；match_batches 逐批 saveMatchBatch checkpoint，断点续跑。
// 崩溃恢复：进程重启后 list() 的 recoverInterruptedDocuments 把残留 extracting/matching 标 error，
// 用户点重试（stepCanReuse 跳过已成功步骤，从断点继续）。
import type { AiService } from '../ai/service';
import type { KnowledgeBaseStore } from './store';
import type { DocumentDto } from './store';
import { eventBus } from '../events/bus';
import { registerActiveExtraction, unregisterActiveExtraction } from './registry';
import {
  buildInitialItemMessages,
  buildSupplementItemMessages,
  buildMatchMessages,
  buildRecoveryMessages,
  createFinalItems,
  createReport,
  getBlockOrder,
  getMissingBlocks,
  isRecoveryStepResult,
  isSameStringList,
  mergeCandidateItems,
  nextKnowledgeItemId,
  normalizeCandidateItems,
  normalizeMatchResult,
  normalizeRecoveryResult,
  renderBlocksForPrompt,
  validateCandidateItems,
  validateMatchResult,
  validateRecoveryResult,
  type Block,
  type CandidateItem,
  type CandidateItemRow,
  type DiscardedResult,
  type MatchResult,
  type NewItemResult,
  type RecoveryStepResult,
} from './prompts';

const RECOVERY_MAX_ATTEMPTS = 2;
const DEFAULT_BATCH_SIZE = 20;

interface KnowledgeBlockRow {
  blockId: string;
  type: string;
  headingPathJson: unknown;
  content: string;
}

function toBlock(row: KnowledgeBlockRow): Block {
  return {
    id: row.blockId,
    type: row.type,
    heading_path: Array.isArray(row.headingPathJson) ? (row.headingPathJson as string[]) : [],
    content: row.content,
  };
}

function stepCanReuse(step: { status: string } | null, hasArtifact: boolean): boolean {
  return Boolean(hasArtifact && (!step || step.status === 'success'));
}

function getStepItems(step: { result: unknown } | null): CandidateItem[] | null {
  const result = step?.result as { items?: unknown } | undefined;
  return Array.isArray(result?.items) ? (result.items as CandidateItem[]) : null;
}

export interface RunKnowledgeExtractionParams {
  store: KnowledgeBaseStore;
  aiService: AiService;
  config: Record<string, unknown>;
  projectId: string;
  documentId: string;
  batchSize?: number;
  force?: boolean;
}

// 推进度事件：写 DB + 经 EventBus 发 {document} 给该用户的 'kb-document' 订阅者。
export async function emitProgress(
  store: KnowledgeBaseStore,
  projectId: string,
  documentId: string,
  partial: Record<string, unknown>,
): Promise<DocumentDto> {
  const document = await store.updateDocument(documentId, partial);
  eventBus.emit(projectId, 'kb-document', { document });
  return document;
}

// 单步运行器：标 running → 跑 worker → 标 success/error（移植自桌面 runDocumentStep）。
async function runStep<T>(
  store: KnowledgeBaseStore,
  documentId: string,
  stepKey: string,
  worker: () => Promise<T>,
): Promise<T> {
  await store.saveDocumentStep(documentId, stepKey, { status: 'running' });
  try {
    const result = await worker();
    await store.saveDocumentStep(documentId, stepKey, { status: 'success', result: result as unknown });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.saveDocumentStep(documentId, stepKey, { status: 'error', error: message });
    throw error;
  }
}

export async function runKnowledgeExtraction(params: RunKnowledgeExtractionParams): Promise<void> {
  const { store, aiService, config, projectId, documentId } = params;
  const force = Boolean(params.force);
  const batchSize = Math.max(1, Math.min(100, Math.floor(Number(params.batchSize ?? DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE)));

  registerActiveExtraction(documentId);
  try {
    const document = await store.getDocument(documentId);
    if (force) {
      // 重跑匹配：清 match_batches 及之后（recover_missing/save_result）的步骤与产物。
      await store.clearDocumentProcessingFromStep(documentId, 'match_batches');
    }

    const blockRows = await store.readBlocks(documentId);
    const blocks = blockRows.map(toBlock);
    if (!blocks.length) throw new Error('缺少正文 block，请重新上传文档');
    const blockText = renderBlocksForPrompt(blocks);

    // ---- 步骤 4: extract_first_items ----
    let firstItems = getStepItems(await store.getDocumentStep(documentId, 'extract_first_items'));
    const firstStep = await store.getDocumentStep(documentId, 'extract_first_items');
    if (stepCanReuse(firstStep, Array.isArray(firstItems))) {
      if (!firstStep) {
        await store.saveDocumentStep(documentId, 'extract_first_items', { status: 'success', result: { items: firstItems } });
      }
    } else {
      await store.clearDocumentProcessingFromStep(documentId, 'extract_first_items');
      await emitProgress(store, projectId, documentId, {
        status: 'extracting',
        progress: 35,
        message: 'AI 正在首次提取知识条目',
        error: null,
      });
      const result = await runStep(store, documentId, 'extract_first_items', async () => {
        const first = await aiService.collectJsonResponse({ ...config, __sseProjectId: projectId }, {
          messages: buildInitialItemMessages(document.file_name, blockText),
          temperature: 0.2,
          response_format: { type: 'json_object' },
          normalizer: (value: unknown) => ({ items: normalizeCandidateItems(value) }),
          validator: validateCandidateItems,
          failureMessage: '知识库条目提取失败，AI 未返回有效 JSON',
          progressLabel: '知识库条目提取',
          logTitle: `知识库条目提取-${document.file_name}`,
        });
        return { items: Array.isArray(first?.items) ? first.items : [] };
      });
      firstItems = result.items;
    }

    // ---- 步骤 5: extract_supplement_items ----
    let supplementItems = getStepItems(await store.getDocumentStep(documentId, 'extract_supplement_items'));
    const supplementStep = await store.getDocumentStep(documentId, 'extract_supplement_items');
    if (stepCanReuse(supplementStep, Array.isArray(supplementItems))) {
      if (!supplementStep) {
        await store.saveDocumentStep(documentId, 'extract_supplement_items', { status: 'success', result: { items: supplementItems } });
      }
    } else {
      await store.clearDocumentProcessingFromStep(documentId, 'extract_supplement_items');
      await emitProgress(store, projectId, documentId, {
        status: 'extracting',
        progress: 55,
        message: 'AI 正在补充遗漏知识条目',
        error: null,
      });
      const result = await runStep(store, documentId, 'extract_supplement_items', async () => {
        const supplement = await aiService.collectJsonResponse({ ...config, __sseProjectId: projectId }, {
          messages: buildSupplementItemMessages(document.file_name, blockText, firstItems as CandidateItem[]),
          temperature: 0.2,
          response_format: { type: 'json_object' },
          normalizer: (value: unknown) => ({ items: normalizeCandidateItems(value) }),
          validator: validateCandidateItems,
          failureMessage: '知识库条目补充失败，AI 未返回有效 JSON',
          progressLabel: '知识库条目补充',
          logTitle: `知识库条目补充-${document.file_name}`,
        });
        return { items: Array.isArray(supplement?.items) ? supplement.items : [] };
      });
      supplementItems = result.items;
    }

    // ---- 步骤 6: merge_candidates ----
    let candidateItems = await store.readCandidateItems(documentId);
    const mergeStep = await store.getDocumentStep(documentId, 'merge_candidates');
    if (stepCanReuse(mergeStep, candidateItems.length > 0)) {
      if (!mergeStep) {
        await store.saveDocumentStep(documentId, 'merge_candidates', { status: 'success', result: { candidate_item_count: candidateItems.length } });
      }
    } else {
      await store.clearDocumentProcessingFromStep(documentId, 'merge_candidates');
      const mergedItems = mergeCandidateItems(firstItems as CandidateItem[], supplementItems as CandidateItem[]);
      if (!mergedItems.length) throw new Error('AI 未提取出可用知识条目');
      await runStep(store, documentId, 'merge_candidates', async () => {
        await store.saveCandidateItems(documentId, mergedItems);
        return { candidate_item_count: mergedItems.length };
      });
      candidateItems = await store.readCandidateItems(documentId);
      if (!candidateItems.length) throw new Error('AI 未提取出可用知识条目');
    }

    await emitProgress(store, projectId, documentId, {
      status: 'ready_for_matching',
      progress: 65,
      message: `已提取 ${candidateItems.length} 条候选知识，开始段落匹配`,
      candidateItemCount: candidateItems.length,
      itemCount: 0,
      lastBatchSize: batchSize,
    });

    // ---- 步骤 7: match_batches（逐批 checkpoint）----
    const blockOrder = getBlockOrder(blocks);
    const candidateItemIds = new Set(candidateItems.map((item) => item.id));
    const batches: CandidateItemRow[][] = [];
    for (let i = 0; i < candidateItems.length; i += batchSize) {
      batches.push(candidateItems.slice(i, i + batchSize) as CandidateItemRow[]);
    }

    const matches: MatchResult[] = [];
    const matchBatches: Array<{ batch_index: number; item_ids: string[]; matches: MatchResult[] }> = [];
    await store.saveDocumentStep(documentId, 'match_batches', { status: 'running' });
    await emitProgress(store, projectId, documentId, {
      status: 'matching',
      progress: 66,
      message: `开始匹配段落，共 ${batches.length} 批`,
    });

    for (let index = 0; index < batches.length; index += 1) {
      const batchIndex = index + 1;
      const batchItemIds = batches[index].map((item) => item.id);
      const savedBatch = await store.getMatchBatch(documentId, batchIndex);
      if (
        !force
        && savedBatch?.status === 'success'
        && isSameStringList(savedBatch.itemIds, batchItemIds)
        && Array.isArray(savedBatch.matches)
      ) {
        matchBatches.push({ batch_index: batchIndex, item_ids: batchItemIds, matches: savedBatch.matches as MatchResult[] });
        matches.push(...(savedBatch.matches as MatchResult[]));
        continue;
      }

      const progress = Math.min(88, 66 + Math.round(((index + 1) / batches.length) * 22));
      await emitProgress(store, projectId, documentId, {
        status: 'matching',
        progress,
        message: `AI 正在匹配段落 ${batchIndex}/${batches.length}`,
      });
      await store.saveMatchBatch(documentId, batchIndex, { status: 'running', itemIds: batchItemIds, matches: [] });
      try {
        const parsed = await aiService.collectJsonResponse({ ...config, __sseProjectId: projectId }, {
          messages: buildMatchMessages(document.file_name, blockText, batches[index]),
          temperature: 0.1,
          response_format: { type: 'json_object' },
          normalizer: (value: unknown) => normalizeMatchResult(value, candidateItemIds, blocks, blockOrder),
          validator: validateMatchResult,
          failureMessage: '知识库段落匹配失败，AI 未返回有效 JSON',
          progressLabel: '知识库段落匹配',
          logTitle: `知识库段落匹配-${document.file_name}-第${batchIndex}批`,
        });
        await store.saveMatchBatch(documentId, batchIndex, { status: 'success', itemIds: batchItemIds, matches: parsed.matches });
        matchBatches.push({ batch_index: batchIndex, item_ids: batchItemIds, matches: parsed.matches });
        matches.push(...parsed.matches);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await store.saveMatchBatch(documentId, batchIndex, { status: 'error', itemIds: batchItemIds, error: message });
        await store.saveDocumentStep(documentId, 'match_batches', { status: 'error', error: message });
        throw error;
      }
    }
    await store.saveDocumentStep(documentId, 'match_batches', { status: 'success', result: { batch_size: batchSize, batch_count: batches.length } });

    // ---- 步骤 8: recover_missing（最多 2 轮，覆盖剩余 block）----
    const recoveryStep = await store.getDocumentStep(documentId, 'recover_missing');
    let recoveryResult = recoveryStep?.result as RecoveryStepResult | undefined;
    if (!force && recoveryStep?.status === 'success' && isRecoveryStepResult(recoveryResult)) {
      // 复用已有 recovery 结果
    } else {
      await store.clearDocumentProcessingFromStep(documentId, 'recover_missing');
      recoveryResult = await runStep(store, documentId, 'recover_missing', async () => {
        const items: CandidateItemRow[] = [...candidateItems];
        const recoveredMatches: MatchResult[] = [...matches];
        const discarded: DiscardedResult[] = [];
        const systemDiscarded: DiscardedResult[] = [];
        const recoveryAttempts: RecoveryStepResult['recovery_attempts'] = [];

        for (let attempt = 0; attempt < RECOVERY_MAX_ATTEMPTS; attempt += 1) {
          const missingBlocks = getMissingBlocks(blocks, recoveredMatches, discarded, systemDiscarded);
          if (!missingBlocks.length) break;
          await emitProgress(store, projectId, documentId, {
            status: 'recovering',
            progress: Math.min(96, 90 + attempt * 3),
            message: `AI 正在补漏遗漏段落 ${attempt + 1}/${RECOVERY_MAX_ATTEMPTS}，剩余 ${missingBlocks.length} 个 block`,
          });
          const currentItemIds = new Set(items.map((item) => item.id));
          const parsed = await aiService.collectJsonResponse({ ...config, __sseProjectId: projectId }, {
            messages: buildRecoveryMessages(document.file_name, items, missingBlocks),
            temperature: 0.1,
            response_format: { type: 'json_object' },
            normalizer: (value: unknown) => normalizeRecoveryResult(value, currentItemIds, blocks, blockOrder),
            validator: validateRecoveryResult,
            failureMessage: '知识库遗漏段落补漏失败，AI 未返回有效 JSON',
            progressLabel: '知识库遗漏补漏',
            logTitle: `知识库遗漏补漏-${document.file_name}-第${attempt + 1}轮`,
          });

          const newItemsWithIds = parsed.new_items.map((item: NewItemResult) => {
            const id = nextKnowledgeItemId(items);
            const next: CandidateItemRow = { id, title: item.title, summary: item.summary };
            items.push(next);
            recoveredMatches.push({ id, ranges: item.ranges, block_ids: item.block_ids });
            return { ...next, ranges: item.ranges, block_ids: item.block_ids };
          });
          recoveredMatches.push(...parsed.matches);
          discarded.push(...parsed.discarded.map((item: DiscardedResult) => ({ ...item, source: 'ai' })));
          recoveryAttempts.push({
            attempt: attempt + 1,
            missing_before_count: missingBlocks.length,
            matches: parsed.matches,
            new_items: newItemsWithIds,
            discarded: parsed.discarded,
          });
        }

        const remaining = getMissingBlocks(blocks, recoveredMatches, discarded, systemDiscarded);
        if (remaining.length) {
          systemDiscarded.push({
            block_ids: remaining.map((block) => block.id),
            reason: 'system_discarded_after_retry',
          });
        }

        return {
          items,
          matches: recoveredMatches,
          discarded,
          system_discarded: systemDiscarded,
          recovery_attempts: recoveryAttempts,
        } as RecoveryStepResult;
      });
    }

    // ---- 步骤 9: save_result ----
    const recovery = recoveryResult as RecoveryStepResult;
    const savedItems = await store.readItems(documentId);
    const saveStep = await store.getDocumentStep(documentId, 'save_result');
    if (!force && saveStep?.status === 'success' && savedItems.length) {
      await emitProgress(store, projectId, documentId, {
        status: 'success',
        progress: 100,
        message: `整理完成，共 ${savedItems.length} 条`,
        itemCount: savedItems.length,
      });
      return;
    }

    await emitProgress(store, projectId, documentId, {
      status: 'saving',
      progress: 98,
      message: '正在回填正文并保存知识条目',
    });
    const saveResult = await runStep(store, documentId, 'save_result', async () => {
      const finalItems = createFinalItems(recovery.items, recovery.matches, blocks, document.file_name);
      const filteredBlocks = (await store.readFilteredBlocks(documentId)).map(toBlock);
      const report = createReport({
        blocks,
        filteredBlocks,
        candidateItems: recovery.items,
        finalItems,
        matches: recovery.matches,
        discarded: recovery.discarded,
        systemDiscarded: recovery.system_discarded,
        recoveryAttempts: recovery.recovery_attempts,
        batchSize,
      });
      await store.saveMatchResult(documentId, {
        candidateItems: recovery.items,
        matchResult: {
          discarded: recovery.discarded,
          system_discarded_after_retry: recovery.system_discarded,
        },
        report,
        finalItems,
      });
      return { final_item_count: finalItems.length, report };
    });
    await emitProgress(store, projectId, documentId, {
      status: 'success',
      progress: 100,
      message: `整理完成，共 ${saveResult.final_item_count} 条，覆盖率 ${Math.round(saveResult.report.coverage_rate * 100)}%`,
      itemCount: saveResult.final_item_count,
      candidateItemCount: recovery.items.length,
      discardedBlockCount: saveResult.report.discarded_blocks_count,
      systemDiscardedAfterRetryCount: saveResult.report.system_discarded_after_retry_count,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitProgress(store, projectId, documentId, {
      status: 'error',
      progress: 100,
      message: message || '处理失败',
      error: message || '处理失败',
    });
  } finally {
    unregisterActiveExtraction(documentId);
  }
}
