// L4 runner #59：bid-section-extraction（多标段识别）。
// 移植自 client/electron/services/bidSectionExtractionTask.cjs:199-272（runBidSectionExtractionTask 编排）。
//
// 流水线：读原始招标正文 → 行号化 → 按上下文分段 → 逐段 LLM 抽 sections 候选（fan-out）
// → 多段时再过一次 LLM 合并去重（merge）→ 校验≥2 段 → 落 bidSections。
//
// 适配点（桌面→web）：
//  - workspaceStore 经 engine buildRunnerWorkspaceStore 绑定 userId，调用形如桌面单用户。
//  - log/updateTask/updateTechnicalPlan 均 async（web store 与 updateTask 均 async，桌面同步）。
//  - 失败路径持久完整 error 态后 return（不 rethrow），与 #58/#60/#62 web 约定一致，
//    避免引擎 .catch 的冗余 updateTask 覆盖（runner 自己的 error 写入更完整：含 bidSectionExtractionStatus 等）。
import type { TaskRunner } from '../types';
import {
  type BidSectionAiService,
  type SectionsResponse,
  pushLog,
  numberMarkdownLines,
  normalizeSectionsResponse,
  validateSectionsResponse,
  buildExtractMessages,
  buildMergeMessages,
  collectJson,
} from '../utils/bidSectionHelpers';
import { splitUserTextByContextLimit } from '../../document/userTextSplitter';

interface TechnicalPlanWorkspaceStore {
  readOriginalTenderMarkdown(): Promise<string>;
  readTenderMarkdown(): Promise<string>;
  prepareBidSectionExtraction(): Promise<unknown>;
  updateTechnicalPlan(partial: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export const runBidSectionExtractionTask: TaskRunner = async (ctx) => {
  const workspaceStore = ctx.workspaceStore as unknown as TechnicalPlanWorkspaceStore;
  const aiService = ctx.aiService as unknown as BidSectionAiService;
  const { updateTask } = ctx;

  const originalMarkdown = workspaceStore.readOriginalTenderMarkdown
    ? await workspaceStore.readOriginalTenderMarkdown()
    : await workspaceStore.readTenderMarkdown();
  const cleanMarkdown = String(originalMarkdown || '').trim();
  if (!cleanMarkdown) {
    throw new Error('请先上传招标文件，再进行多标段识别');
  }

  if (typeof workspaceStore.prepareBidSectionExtraction === 'function') {
    await workspaceStore.prepareBidSectionExtraction();
  }

  const logs: string[] = [];
  const log = async (message: string, progress: number): Promise<void> => {
    const nextLogs = pushLog(logs, message);
    const state = await workspaceStore.updateTechnicalPlan({
      bidSectionMode: 'multiple',
      bidSectionExtractionStatus: 'running',
      bidSectionExtractionError: undefined,
    });
    await updateTask({ status: 'running', progress, logs: nextLogs }, state as unknown as boolean);
  };

  try {
    await log('开始识别招标文件中的标段范围。', 5);
    const totalLines = cleanMarkdown.split(/\r?\n/).length;
    const numberedMarkdown = numberMarkdownLines(cleanMarkdown);
    const segments = splitUserTextByContextLimit(
      numberedMarkdown,
      typeof aiService.getConfig === 'function' ? aiService.getConfig() : {},
    );
    const sourceSegments = segments.length ? segments : [numberedMarkdown];
    await log(`招标文件已按上下文拆分为 ${sourceSegments.length} 段，正在提取标段候选。`, 12);

    const segmentResults: SectionsResponse[] = [];
    for (let index = 0; index < sourceSegments.length; index += 1) {
      const raw = await collectJson(aiService, {
        messages: buildExtractMessages(sourceSegments[index], index + 1, sourceSegments.length),
        temperature: 0.1,
        response_format: { type: 'json_object' },
        logTitle: `多标段识别-第${index + 1}段`,
        progressLabel: `多标段识别第${index + 1}段`,
      });
      segmentResults.push(normalizeSectionsResponse(raw, totalLines));
      await log(
        `已完成第 ${index + 1}/${sourceSegments.length} 段标段候选提取。`,
        Math.min(80, 12 + Math.round(((index + 1) / sourceSegments.length) * 60)),
      );
    }

    const mergedRaw =
      sourceSegments.length > 1
        ? await collectJson(aiService, {
            messages: buildMergeMessages(segmentResults),
            temperature: 0.1,
            response_format: { type: 'json_object' },
            logTitle: '多标段识别-候选合并',
            progressLabel: '多标段识别候选合并',
          })
        : segmentResults[0];
    const merged = normalizeSectionsResponse(mergedRaw, totalLines);
    validateSectionsResponse(merged);

    const finalState = await workspaceStore.updateTechnicalPlan({
      bidSectionMode: 'multiple',
      bidSections: merged.sections,
      bidSectionExtractionStatus: 'success',
      bidSectionExtractionError: undefined,
    });
    const finalLogs = pushLog(logs, `已识别 ${merged.sections.length} 个标段，请选择本次投标范围。`);
    await updateTask({ status: 'success', progress: 100, logs: finalLogs }, finalState as unknown as boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : '多标段识别失败';
    const failedState = await workspaceStore.updateTechnicalPlan({
      bidSectionMode: 'multiple',
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: message,
    });
    await updateTask(
      { status: 'error', progress: 100, error: message, logs: pushLog(logs, message) },
      failedState as unknown as boolean,
    );
  }
};
