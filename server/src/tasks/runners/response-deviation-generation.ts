import type { TaskRunner } from '../types';
import { parseTenderBlocks } from '../../response-deviation/structure';
import { detectResponseDeviationAvailability } from '../../response-deviation/detector';
import { extractRequirements } from '../../response-deviation/extractor';
import { classifyAmbiguities } from '../../response-deviation/agentClassifier';
import type { ProjectTenderSourceSnapshot } from '../../response-deviation/types';
import { extractProjectFields, extractTemplateSchema } from '../../response-deviation/metadata';

interface ResponseDeviationRunnerStore {
  getTenderSourceSnapshot(): Promise<ProjectTenderSourceSnapshot | null>;
  saveGeneratedRows(args: Record<string, unknown>): Promise<unknown>;
}

const reasonMessage: Record<string, string> = {
  'package-required': '当前招标文件包含多个标段，请先在 STEP 02 选择标段。',
  'no-template': '未识别到技术响应与偏离表模板。',
  'business-only': '当前只识别到独立商务条款偏离表，首期暂不处理商务表。',
  'no-technical-source': '未识别到当前标段的采购需求、服务需求或技术要求章节。',
};

export const runResponseDeviationGenerationTask: TaskRunner = async (ctx) => {
  const store = ctx.workspaceStore as ResponseDeviationRunnerStore;
  const logs: string[] = [];
  const report = async (progress: number, message: string, extra: Record<string, unknown> = {}) => {
    logs.push(message);
    await ctx.updateTask({ status: 'running', progress, logs: [...logs], ...extra }, true);
  };

  await report(10, '正在复用当前项目已解析的招标文件。');
  const source = await store.getTenderSourceSnapshot();
  if (!source) throw new Error('请先在生成技术方案中上传招标文件。');

  const blocks = parseTenderBlocks(source.markdown);
  const sourceBlocks = source.selectedSectionMarkdown?.trim()
    ? parseTenderBlocks(source.selectedSectionMarkdown)
    : blocks;
  const availability = detectResponseDeviationAvailability(blocks, source);
  if (!availability.available) throw new Error(reasonMessage[availability.reason] || '当前招标文件暂不具备技术响应与偏离表生成条件。');
  await report(25, `已识别“${availability.templateTitle}”和“${availability.sourceChapterTitle}”。`);

  const extraction = extractRequirements(sourceBlocks, {
    blockIds: availability.sourceBlockIds,
    sourceChapterTitle: availability.sourceChapterTitle,
    templateTitle: availability.templateTitle,
  });
  await report(50, `已按招标原文生成 ${extraction.rows.length} 条技术要求。`);

  const ambiguousCandidates = extraction.rows
    .filter((row) => row.confidence === 'review')
    .map((row) => ({
      id: row.sourceFingerprint,
      title: row.requirementTitle,
      text: row.requirementPlainText,
      allowed: ['technical-source', 'exclude'] as const,
    }));
  const classification = await classifyAmbiguities({
    projectId: ctx.projectId,
    candidates: ambiguousCandidates,
    agentService: ctx.agentService,
  });
  if (classification.degraded && ctx.diagnosticTraceId) {
    await ctx.aiDiagnostics?.markFallback(ctx.diagnosticTraceId, 'response-deviation-ambiguity', classification.warnings);
  }
  await report(70, ambiguousCandidates.length
    ? `Pi Agent 已完成 ${classification.decisions.length}/${ambiguousCandidates.length} 个歧义项判断。`
    : '当前来源边界明确，无需调用 Pi Agent。');

  if (extraction.duplicateBlockIds.length) throw new Error('招标原文存在重复引用，请检查拆分规则。');
  const needsReview = extraction.uncoveredBlockIds.length > 0 || classification.degraded;
  await report(85, needsReview ? '完整性校验完成，存在需要人工复核的项目。' : '完整性校验通过，招标原文已全部覆盖。');

  await store.saveGeneratedRows({
    projectId: ctx.projectId,
    userId: Number(ctx.payload.userId || 0) || undefined,
    source,
    availability,
    extraction,
    templateSchema: extractTemplateSchema(blocks, availability.templateTitle),
    projectFields: extractProjectFields(source),
  });
  await report(95, '偏离表草稿已保存。');

  logs.push('技术响应与偏离表已生成，请人工确认招标侧内容。');
  await ctx.updateTask({
    status: 'success',
    progress: 100,
    logs,
    degraded: classification.degraded,
    stats: {
      rowCount: extraction.rows.length,
      coveredCount: extraction.coveredBlockIds.length,
      uncoveredCount: extraction.uncoveredBlockIds.length,
      ambiguityCount: ambiguousCandidates.length,
      piDecisionCount: classification.decisions.length,
      warnings: classification.warnings,
    },
  }, true, { responseDeviation: { refresh: true } });
};
