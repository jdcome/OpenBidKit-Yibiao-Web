// L4 runner #63：duplicate-analysis（标书查重分析）。
// 移植自 client/electron/services/duplicateCheckService.cjs:2100-2816（工厂编排）。
//
// 4 个并行子分析（全部确定性 CPU/FS，无 AI）：
//   - metadataAnalysis：指纹（DOCX adm-zip / OLE CFB / PDF pdf-parse + 原始结构）
//   - outlineAnalysis：目录相似度（精确 + bigram Dice + LCS 顺序）
//   - contentAnalysis：句子级去重（招标句白名单 5 层匹配 + 跨文件聚合）
//   - imageAnalysis：图片 SHA-256 去重（data: URL 内嵌，readImageTargetBuffer 解码）
//
// run 流水线（对齐桌面 run()，line 2681）：
//   1) contentPromise = runContentExtraction(allFiles) 并发先启（解析每文件→markdown，含图片，落 contents/<fileId>.md）
//   2) await runMetadataExtraction(bidFiles)            // 与 1 并发
//   3) await contentPromise
//   4) Promise.all([outline, content, image])           // 三路并发
//   5) 聚合失败状态
//
// 适配点（桌面→web，详见 utils/duplicateAnalysisHelpers.ts 头注）：
//  - workspaceStore.loadDuplicateCheck/updateDuplicateCheck 均 async → 全部 await。
//  - emit(target,state)：target = async notify（不再是 webContents 同步函数）。
//  - updateTask(partial, truthy)：truthy 触发 analysisTask 落库 + 读回整域快照广播。
//  - file.file_path（相对 workspaceDir）→ paths.resolve() 还原绝对路径后再交 extractMetadata / convertPathToMarkdown。
//  - parseDocumentWithConfig(preserveImages:true) → convertPathToMarkdown(includeImages:true, imageResolver)，
//    imageResolver 返回 data:<mime>;base64,<...>（readImageTargetBuffer 的 data: 分支已支持，无需落盘图片）。
//  - getDuplicateCheckContentDir(app) → paths.duplicateCheckContentDir。
//  - readImageTargetBuffer(app, target) → readImageTargetBuffer(target)（去 app 参数；data:/file: 两分支已够）。
//  - createDeveloperLogger → no-op stub（web 不写桌面开发日志）。
//  - 桌面用工厂闭包持有 workspaceStore；web 多用户并发会串号，故 workspaceStore 显式逐函数透传。
import type { TaskRunner, TaskRunnerContext } from '../types';
import { createWorkspacePaths } from '../../document/paths';
import {
  now,
  stableFileId,
  createSignature,
  getTenderFilesFromPayload,
  extractMetadata,
  buildRows,
  splitTenderSentences,
  buildOutlineItems,
  buildOutlineComparison,
  splitContentSentences,
  buildTenderSourceMatcher,
  buildDuplicateSentences,
  extractImageOccurrences,
  readImageTargetBuffer,
  buildDuplicateImages,
  type DuplicateFile,
  type MetadataFile,
  type OutlineFile,
} from '../utils/duplicateAnalysisHelpers';

interface DuplicateCheckWorkspaceStore {
  loadDuplicateCheck(): Promise<Record<string, any>>;
  updateDuplicateCheck(partial: Record<string, any>): Promise<Record<string, any>>;
}

const developerLogger = { write() {} };

type SectionKey = 'metadataAnalysis' | 'outlineAnalysis' | 'contentAnalysis' | 'imageAnalysis';
type Notify = (state: Record<string, any>) => Promise<void>;
type IsCurrent = () => Promise<boolean>;

function createInitialAnalysis(signature: string, bidFiles: DuplicateFile[]) {
  const total = bidFiles.length;
  return {
    status: 'running',
    progress: 0,
    message: '正在启动元数据分析',
    signature,
    started_at: now(),
    updated_at: now(),
    contentExtraction: { status: 'running', completed: 0, total: 0 },
    metadataExtraction: { status: total ? 'running' : 'success', completed: 0, total },
    files: [] as MetadataFile[],
    rows: [] as Record<string, unknown>[],
    contentFiles: [] as Record<string, unknown>[],
    logs: [] as string[],
  };
}

function createInitialOutlineAnalysis(signature: string, bidFiles: DuplicateFile[]) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待元数据提取完成后开始目录分析',
    signature,
    started_at: now(),
    updated_at: now(),
    tenderSentenceCount: 0,
    tenderMatchedItemCount: 0,
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    files: [] as OutlineFile[],
    duplicateGroups: [] as Record<string, unknown>[],
    pairwiseSimilarities: [] as Record<string, unknown>[],
  };
}

function createInitialContentAnalysis(signature: string, bidFiles: DuplicateFile[]) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待正文内容提取完成后开始正文比对',
    signature,
    started_at: now(),
    updated_at: now(),
    tenderSentenceCount: 0,
    tenderMatchedSentenceCount: 0,
    totalSentenceCount: 0,
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    duplicateSentences: [] as Record<string, unknown>[],
  };
}

function createInitialImageAnalysis(signature: string, bidFiles: DuplicateFile[]) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待正文内容提取完成后开始图片比对',
    signature,
    started_at: now(),
    updated_at: now(),
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    totalImageCount: 0,
    files: [] as Record<string, unknown>[],
    duplicateImages: [] as Record<string, unknown>[],
  };
}

function summarizeDuplicateFileForLog(file: DuplicateFile | null, role: string) {
  if (!file) return null;
  return { role, file_id: stableFileId(file), file_name: file.file_name, extension: file.extension, size: file.size ?? null, modified_at: file.modified_at || '' };
}

function summarizeResultStatus(results: { status?: string }[] = []) {
  const total = results.length;
  const errorCount = results.filter((item) => item.status === 'error').length;
  return { total, success_count: total - errorCount, error_count: errorCount };
}

function summarizeContentExtractionResults(results: { status?: string; content_length?: number }[] = []) {
  const base = summarizeResultStatus(results);
  const lengths = results.map((item) => Number(item.content_length) || 0);
  return { ...base, total_content_chars: lengths.reduce((sum, value) => sum + value, 0), max_content_chars: Math.max(0, ...lengths) };
}

function analysisProgress(value: { status?: string; progress?: number } | undefined): number {
  if (!value) return 0;
  if (value.status === 'success' || value.status === 'error') return 100;
  return Math.max(0, Math.min(Number(value.progress) || 0, 99));
}

function overallProgress(state: Record<string, any> | undefined | null): number {
  if (!state) return 0;
  const values = [analysisProgress(state.metadataAnalysis), analysisProgress(state.outlineAnalysis), analysisProgress(state.contentAnalysis), analysisProgress(state.imageAnalysis)];
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function latestAnalysisMessage(state: Record<string, any> | undefined | null): string {
  if (!state) return '标书查重分析运行中。';
  return state.imageAnalysis?.message || state.contentAnalysis?.message || state.outlineAnalysis?.message || state.metadataAnalysis?.message || '标书查重分析运行中。';
}

// 写某个分析小节（metadataAnalysis/outlineAnalysis/...）到 store，再触发 notify（广播整域快照）。
// 对齐桌面 updateAnalysis/updateOutlineAnalysis/updateContentAnalysis/updateImageAnalysis 四胞胎。
async function updateAnalysisSection(
  workspaceStore: DuplicateCheckWorkspaceStore,
  sectionKey: SectionKey,
  partial: Record<string, unknown>,
  notify: Notify,
  isCurrent: IsCurrent,
): Promise<Record<string, any> | null> {
  if (!(await isCurrent())) return null;
  const prev = (await workspaceStore.loadDuplicateCheck()) || {};
  const prevAnalysis = prev[sectionKey] || {};
  const nextSection = { ...prevAnalysis, ...partial, updated_at: now() };
  const next = await workspaceStore.updateDuplicateCheck({ [sectionKey]: nextSection });
  await notify(next);
  return next;
}

async function readContentMarkdown(contentFiles: Record<string, unknown>[], file: DuplicateFile): Promise<string> {
  const fileId = stableFileId(file);
  const item = contentFiles.find((entry) => entry.file_id === fileId && entry.status === 'success' && entry.content_path);
  if (!item) throw new Error('正文内容尚未成功提取，无法进行分析');
  const nodeFs = await import('node:fs/promises');
  return nodeFs.readFile(item.content_path as string, 'utf-8');
}

async function readCombinedTenderMarkdown(contentFiles: Record<string, unknown>[], tenderFiles: DuplicateFile[]): Promise<string> {
  const parts: string[] = [];
  for (const file of tenderFiles) {
    const markdown = await readContentMarkdown(contentFiles, file);
    if (String(markdown || '').trim()) parts.push(String(markdown).trim());
  }
  return parts.join('\n\n');
}

async function runContentExtraction(
  workspaceStore: DuplicateCheckWorkspaceStore,
  contentDir: string,
  resolve: (rel: string) => string,
  allFiles: DuplicateFile[],
  tenderFiles: DuplicateFile[],
  notify: Notify,
  isCurrent: IsCurrent,
): Promise<Record<string, unknown>[]> {
  const nodeFs = await import('node:fs/promises');
  const nodePath = await import('node:path');
  await nodeFs.mkdir(contentDir, { recursive: true });
  const results: Record<string, unknown>[] = [];
  const tenderFileIds = new Set((Array.isArray(tenderFiles) ? tenderFiles : []).map(stableFileId));
  developerLogger.write('duplicate.content_extraction.started', { file_count: allFiles.length, files: allFiles.map((file) => summarizeDuplicateFileForLog(file, tenderFileIds.has(stableFileId(file)) ? 'tender' : 'bid')) });
  await updateAnalysisSection(workspaceStore, 'metadataAnalysis', { contentExtraction: { status: 'running', completed: 0, total: allFiles.length }, message: '正在提取正文内容' }, notify, isCurrent);

  const { convertPathToMarkdown } = await import('../../document/doc2markdown/convert.mjs');

  for (const file of allFiles) {
    const fileId = stableFileId(file);
    try {
      const absolutePath = resolve(file.file_path);
      const markdown = (await convertPathToMarkdown(absolutePath, {
        includeImages: true,
        imageResolver: async (image: { buffer: Buffer; mime: string; sourceName: string }) => `data:${image.mime};base64,${image.buffer.toString('base64')}`,
      })).trim();
      const contentPath = nodePath.join(contentDir, `${fileId}.md`);
      await nodeFs.writeFile(contentPath, markdown, 'utf-8');
      results.push({ file_id: fileId, file_name: file.file_name, status: 'success', content_path: contentPath, content_length: markdown.length });
    } catch (error) {
      results.push({ file_id: fileId, file_name: file.file_name, status: 'error', error: error instanceof Error ? error.message : '正文提取失败' });
    }
    await updateAnalysisSection(workspaceStore, 'metadataAnalysis', { contentExtraction: { status: 'running', completed: results.length, total: allFiles.length }, contentFiles: results, message: `正文内容提取 ${results.length}/${allFiles.length}` }, notify, isCurrent);
  }

  const status = results.some((item) => item.status === 'error') ? 'error' : 'success';
  await updateAnalysisSection(workspaceStore, 'metadataAnalysis', { contentExtraction: { status, completed: results.length, total: allFiles.length }, contentFiles: results }, notify, isCurrent);
  developerLogger.write('duplicate.content_extraction.completed', { status, result: summarizeContentExtractionResults(results) });
  return results;
}

async function runMetadataExtraction(
  workspaceStore: DuplicateCheckWorkspaceStore,
  resolve: (rel: string) => string,
  bidFiles: DuplicateFile[],
  notify: Notify,
  isCurrent: IsCurrent,
): Promise<MetadataFile[]> {
  const results: MetadataFile[] = [];
  developerLogger.write('duplicate.metadata_extraction.started', { bid_file_count: bidFiles.length });
  await updateAnalysisSection(workspaceStore, 'metadataAnalysis', { metadataExtraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在提取投标文件元数据' }, notify, isCurrent);

  for (const file of bidFiles) {
    const fileId = stableFileId(file);
    try {
      const absFile: DuplicateFile = { ...file, file_path: resolve(file.file_path) };
      results.push({ file_id: fileId, file_name: file.file_name, status: 'success', metadata: await extractMetadata(absFile) });
    } catch (error) {
      results.push({ file_id: fileId, file_name: file.file_name, status: 'error', error: error instanceof Error ? error.message : '元数据提取失败', metadata: [] });
    }
    const rows = buildRows(results);
    await updateAnalysisSection(workspaceStore, 'metadataAnalysis', { metadataExtraction: { status: 'running', completed: results.length, total: bidFiles.length }, files: results, rows, message: `元数据提取 ${results.length}/${bidFiles.length}` }, notify, isCurrent);
  }

  const rows = buildRows(results);
  const status = results.some((item) => item.status === 'error') ? 'error' : 'success';
  await updateAnalysisSection(workspaceStore, 'metadataAnalysis', { metadataExtraction: { status, completed: results.length, total: bidFiles.length }, files: results, rows }, notify, isCurrent);
  developerLogger.write('duplicate.metadata_extraction.completed', { status, result: summarizeResultStatus(results), row_count: rows.length });
  return results;
}

async function runOutlineAnalysis(
  workspaceStore: DuplicateCheckWorkspaceStore,
  tenderFiles: DuplicateFile[],
  bidFiles: DuplicateFile[],
  contentFiles: Record<string, unknown>[],
  notify: Notify,
  isCurrent: IsCurrent,
): Promise<OutlineFile[]> {
  await updateAnalysisSection(workspaceStore, 'outlineAnalysis', { status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备目录分析' }, notify, isCurrent);
  const results: OutlineFile[] = [];
  let tenderSentences: { text: string; normalized: string }[] = [];
  if (Array.isArray(tenderFiles) && tenderFiles.length) {
    try {
      const tenderMarkdown = await readCombinedTenderMarkdown(contentFiles, tenderFiles);
      tenderSentences = splitTenderSentences(tenderMarkdown);
    } catch (error) {
      await updateAnalysisSection(workspaceStore, 'outlineAnalysis', { message: `招标文件句子白名单生成失败，继续对比投标文件目录：${error instanceof Error ? error.message : String(error)}` }, notify, isCurrent);
    }
  }

  await updateAnalysisSection(workspaceStore, 'outlineAnalysis', { tenderSentenceCount: tenderSentences.length, message: '正在提取投标文件目录' }, notify, isCurrent);
  for (const file of bidFiles) {
    const fileId = stableFileId(file);
    try {
      const markdown = await readContentMarkdown(contentFiles, file);
      const extracted = buildOutlineItems(markdown, tenderSentences);
      const tenderMatchedCount = extracted.items.filter((item) => item.from_tender).length;
      results.push({ file_id: fileId, file_name: file.file_name, status: 'success', source: extracted.source, confidence: extracted.confidence, item_count: extracted.items.length, tender_matched_count: tenderMatchedCount, items: extracted.items });
    } catch (error) {
      results.push({ file_id: fileId, file_name: file.file_name, status: 'error', item_count: 0, tender_matched_count: 0, items: [], error: error instanceof Error ? error.message : '目录提取失败' });
    }
    await updateAnalysisSection(workspaceStore, 'outlineAnalysis', {
      status: 'running',
      progress: bidFiles.length ? Math.round((results.length / bidFiles.length) * 80) : 80,
      extraction: { status: 'running', completed: results.length, total: bidFiles.length },
      files: results,
      tenderSentenceCount: tenderSentences.length,
      tenderMatchedItemCount: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
      message: `目录提取 ${results.length}/${bidFiles.length}`,
    }, notify, isCurrent);
  }

  const comparison = buildOutlineComparison(results);
  const failed = results.some((item) => item.status === 'error');
  await updateAnalysisSection(workspaceStore, 'outlineAnalysis', {
    status: failed ? 'error' : 'success',
    progress: 100,
    message: failed ? '部分文件目录分析失败' : '目录分析完成',
    extraction: { status: failed ? 'error' : 'success', completed: results.length, total: bidFiles.length },
    files: results,
    tenderSentenceCount: tenderSentences.length,
    tenderMatchedItemCount: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
    duplicateGroups: comparison.duplicateGroups,
    pairwiseSimilarities: comparison.pairwiseSimilarities,
  }, notify, isCurrent);
  developerLogger.write('duplicate.outline_analysis.completed', { status: failed ? 'error' : 'success', duplicate_group_count: comparison.duplicateGroups.length, pairwise_similarity_count: comparison.pairwiseSimilarities.length });
  return results;
}

async function runContentDuplicateAnalysis(
  workspaceStore: DuplicateCheckWorkspaceStore,
  tenderFiles: DuplicateFile[],
  bidFiles: DuplicateFile[],
  contentFiles: Record<string, unknown>[],
  notify: Notify,
  isCurrent: IsCurrent,
): Promise<{ status: string; duplicateSentences: Record<string, unknown>[] }> {
  await updateAnalysisSection(workspaceStore, 'contentAnalysis', { status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备正文比对' }, notify, isCurrent);
  let tenderMatcher = buildTenderSourceMatcher([]);
  if (Array.isArray(tenderFiles) && tenderFiles.length) {
    try {
      const tenderMarkdown = await readCombinedTenderMarkdown(contentFiles, tenderFiles);
      tenderMatcher = buildTenderSourceMatcher(splitContentSentences(tenderMarkdown));
    } catch (error) {
      await updateAnalysisSection(workspaceStore, 'contentAnalysis', { message: `招标文件句子白名单生成失败，继续比对投标正文：${error instanceof Error ? error.message : String(error)}` }, notify, isCurrent);
    }
  }

  const globalSentences = new Map<string, { sentence: string; normalized: string; file_ids: string[]; occurrences: Record<string, number>; first_order: number }>();
  let totalSentenceCount = 0;
  let tenderMatchedSentenceCount = 0;
  let firstOrder = 0;

  for (let i = 0; i < bidFiles.length; i += 1) {
    const file = bidFiles[i];
    const fileId = stableFileId(file);
    try {
      const markdown = await readContentMarkdown(contentFiles, file);
      const sentences = splitContentSentences(markdown);
      totalSentenceCount += sentences.length;
      const local = new Map<string, { sentence: string; count: number; order: number }>();
      for (const sentence of sentences) {
        const tenderMatch = tenderMatcher.match(sentence);
        if (tenderMatch) {
          tenderMatchedSentenceCount += 1;
          continue;
        }
        const current = local.get(sentence.normalized) || { sentence: sentence.sentence, count: 0, order: firstOrder++ };
        current.count += 1;
        local.set(sentence.normalized, current);
      }

      for (const [normalized, item] of local.entries()) {
        const global = globalSentences.get(normalized) || { sentence: item.sentence, normalized, file_ids: [] as string[], occurrences: {} as Record<string, number>, first_order: item.order };
        if (!global.file_ids.includes(fileId)) global.file_ids.push(fileId);
        global.occurrences[fileId] = item.count;
        globalSentences.set(normalized, global);
      }
    } catch (error) {
      await updateAnalysisSection(workspaceStore, 'contentAnalysis', { message: `${file.file_name} 正文比对失败：${error instanceof Error ? error.message : String(error)}` }, notify, isCurrent);
    }

    await updateAnalysisSection(workspaceStore, 'contentAnalysis', {
      status: 'running',
      progress: bidFiles.length ? Math.round((globalSentences.size ? 10 : 5) + ((i + 1) / bidFiles.length) * 80) : 85,
      tenderSentenceCount: tenderMatcher.tenderSentenceCount,
      tenderMatchedSentenceCount,
      totalSentenceCount,
      extraction: { status: 'running', completed: i + 1, total: bidFiles.length },
      message: `正文比对 ${i + 1}/${bidFiles.length}`,
    }, notify, isCurrent);
  }

  const duplicateSentences = buildDuplicateSentences(globalSentences);
  await updateAnalysisSection(workspaceStore, 'contentAnalysis', {
    status: 'success',
    progress: 100,
    message: '正文比对完成',
    tenderSentenceCount: tenderMatcher.tenderSentenceCount,
    tenderMatchedSentenceCount,
    totalSentenceCount,
    extraction: { status: 'success', completed: bidFiles.length, total: bidFiles.length },
    duplicateSentences,
  }, notify, isCurrent);
  developerLogger.write('duplicate.content_analysis.completed', { status: 'success', tender_sentence_count: tenderMatcher.tenderSentenceCount, tender_matched_sentence_count: tenderMatchedSentenceCount, total_sentence_count: totalSentenceCount, duplicate_sentence_count: duplicateSentences.length });
  return { status: 'success', duplicateSentences: duplicateSentences as unknown as Record<string, unknown>[] };
}

async function runImageDuplicateAnalysis(
  workspaceStore: DuplicateCheckWorkspaceStore,
  bidFiles: DuplicateFile[],
  contentFiles: Record<string, unknown>[],
  notify: Notify,
  isCurrent: IsCurrent,
): Promise<{ status: string; duplicateImages: Record<string, unknown>[] }> {
  await updateAnalysisSection(workspaceStore, 'imageAnalysis', { status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备图片比对' }, notify, isCurrent);
  const results: Record<string, unknown>[] = [];
  const globalImages = new Map<string, { hash: string; preview_url: string; file_ids: string[]; occurrences: Record<string, number>; locations: Record<string, unknown> }>();
  let totalImageCount = 0;

  for (const file of bidFiles) {
    const fileId = stableFileId(file);
    try {
      const markdown = await readContentMarkdown(contentFiles, file);
      const imageOccurrences = extractImageOccurrences(markdown);
      totalImageCount += imageOccurrences.length;
      const local = new Map<string, { count: number; preview_url: string; locations: unknown[] }>();
      for (const occurrence of imageOccurrences) {
        try {
          const buffer = await readImageTargetBuffer(occurrence.target);
          if (!buffer?.length) continue;
          const { createHash } = await import('node:crypto');
          const hash = createHash('sha256').update(buffer).digest('hex');
          const current = local.get(hash) || { count: 0, preview_url: occurrence.target, locations: [] as unknown[] };
          current.count += 1;
          current.locations.push({ image_index: occurrence.index, directory: occurrence.directory, previous_sentence: occurrence.previous_sentence });
          local.set(hash, current);
        } catch {
          // 单张图片读不出时跳过，不影响同文件其他图片比对。
        }
      }

      for (const [hash, item] of local.entries()) {
        const global = globalImages.get(hash) || { hash, preview_url: item.preview_url, file_ids: [] as string[], occurrences: {} as Record<string, number>, locations: {} as Record<string, unknown> };
        if (!global.file_ids.includes(fileId)) global.file_ids.push(fileId);
        global.occurrences[fileId] = item.count;
        global.locations[fileId] = item.locations;
        globalImages.set(hash, global);
      }
      results.push({ file_id: fileId, file_name: file.file_name, status: 'success', image_count: imageOccurrences.length, unique_image_count: local.size });
    } catch (error) {
      results.push({ file_id: fileId, file_name: file.file_name, status: 'error', image_count: 0, unique_image_count: 0, error: error instanceof Error ? error.message : '图片比对失败' });
    }

    await updateAnalysisSection(workspaceStore, 'imageAnalysis', {
      status: 'running',
      progress: bidFiles.length ? Math.round((results.length / bidFiles.length) * 85) : 85,
      extraction: { status: 'running', completed: results.length, total: bidFiles.length },
      files: results,
      totalImageCount,
      message: `图片比对 ${results.length}/${bidFiles.length}`,
    }, notify, isCurrent);
  }

  const duplicateImages = buildDuplicateImages(globalImages);
  const failed = results.some((item) => item.status === 'error');
  await updateAnalysisSection(workspaceStore, 'imageAnalysis', {
    status: failed ? 'error' : 'success',
    progress: 100,
    message: failed ? '部分文件图片比对失败' : '图片比对完成',
    extraction: { status: failed ? 'error' : 'success', completed: results.length, total: bidFiles.length },
    files: results,
    totalImageCount,
    duplicateImages,
  }, notify, isCurrent);
  developerLogger.write('duplicate.image_analysis.completed', { status: failed ? 'error' : 'success', total_image_count: totalImageCount, duplicate_image_count: duplicateImages.length });
  return { status: failed ? 'error' : 'success', duplicateImages };
}

async function runPipeline(
  workspaceStore: DuplicateCheckWorkspaceStore,
  contentDir: string,
  resolve: (rel: string) => string,
  signature: string,
  tenderFiles: DuplicateFile[],
  bidFiles: DuplicateFile[],
  notify: Notify,
  isCurrent: IsCurrent,
): Promise<string> {
  const allFiles = [...tenderFiles, ...bidFiles].filter(Boolean);
  developerLogger.write('duplicate.pipeline.started', { signature, tender_files: tenderFiles.map((file) => summarizeDuplicateFileForLog(file, 'tender')), bid_file_count: bidFiles.length, file_count: allFiles.length });

  try {
    const contentPromise = runContentExtraction(workspaceStore, contentDir, resolve, allFiles, tenderFiles, notify, isCurrent);
    const metadataFiles = await runMetadataExtraction(workspaceStore, resolve, bidFiles, notify, isCurrent);
    await updateAnalysisSection(workspaceStore, 'outlineAnalysis', { status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于目录分析', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, notify, isCurrent);
    await updateAnalysisSection(workspaceStore, 'contentAnalysis', { status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于正文比对', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, notify, isCurrent);
    await updateAnalysisSection(workspaceStore, 'imageAnalysis', { status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于图片比对', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, notify, isCurrent);
    const contentFiles = await contentPromise;
    const [outlineFiles, contentResult, imageResult] = await Promise.all([
      runOutlineAnalysis(workspaceStore, tenderFiles, bidFiles, contentFiles, notify, isCurrent),
      runContentDuplicateAnalysis(workspaceStore, tenderFiles, bidFiles, contentFiles, notify, isCurrent),
      runImageDuplicateAnalysis(workspaceStore, bidFiles, contentFiles, notify, isCurrent),
    ]);
    const failed = contentFiles.some((item) => item.status === 'error')
      || metadataFiles.some((item) => item.status === 'error')
      || outlineFiles.some((item) => item.status === 'error')
      || contentResult.status === 'error'
      || imageResult.status === 'error';
    await updateAnalysisSection(workspaceStore, 'metadataAnalysis', { status: failed ? 'error' : 'success', progress: 100, message: failed ? '部分文件分析失败' : '元数据分析完成' }, notify, isCurrent);
    developerLogger.write('duplicate.pipeline.completed', { signature, status: failed ? 'error' : 'success', content_extraction: summarizeResultStatus(contentFiles as { status?: string }[]), metadata_extraction: summarizeResultStatus(metadataFiles), outline_analysis: summarizeResultStatus(outlineFiles), content_duplicate_status: contentResult.status, image_duplicate_status: imageResult.status });
    return failed ? 'error' : 'success';
  } catch (error) {
    await updateAnalysisSection(workspaceStore, 'metadataAnalysis', { status: 'error', progress: 100, message: error instanceof Error ? error.message : '元数据分析失败' }, notify, isCurrent);
    developerLogger.write('duplicate.pipeline.error', { signature, error: error instanceof Error ? error.message : String(error) });
    return 'error';
  }
}

export const runDuplicateAnalysisTask: TaskRunner = async (ctx: TaskRunnerContext) => {
  const workspaceStore = ctx.workspaceStore as unknown as DuplicateCheckWorkspaceStore;
  const { updateTask, projectId } = ctx;
  const payload = ctx.payload || {};
  const paths = createWorkspacePaths(projectId);

  const signature = createSignature(payload);
  const force = payload.force === true;
  const bidFiles = (Array.isArray(payload.bidFiles) ? payload.bidFiles : []) as DuplicateFile[];
  const tenderFiles = getTenderFilesFromPayload(payload) as DuplicateFile[];

  developerLogger.write('duplicate.task.started', { signature, force, tender_files: tenderFiles.map((file) => summarizeDuplicateFileForLog(file, 'tender')), bid_files: bidFiles.map((file) => summarizeDuplicateFileForLog(file, 'bid')) });

  const isCurrent = async (): Promise<boolean> => {
    if (!signature) return true;
    const current = (await workspaceStore.loadDuplicateCheck()) || {};
    const currentSignature = createSignature({ tenderFile: current.tenderFile || null, tenderFiles: Array.isArray(current.tenderFiles) ? current.tenderFiles : [], bidFiles: Array.isArray(current.bidFiles) ? current.bidFiles : [] });
    return currentSignature === signature;
  };

  // 跳过：4 个小节均已 success 且签名一致（非 force 重跑）。
  const current = (await workspaceStore.loadDuplicateCheck()) || {};
  if (!force
    && current.metadataAnalysis?.signature === signature && current.metadataAnalysis?.status === 'success'
    && current.outlineAnalysis?.signature === signature && current.outlineAnalysis?.status === 'success'
    && current.contentAnalysis?.signature === signature && current.contentAnalysis?.status === 'success'
    && current.imageAnalysis?.signature === signature && current.imageAnalysis?.status === 'success') {
    const skippedTask = await updateTask({ status: 'success', progress: 100, logs: ['标书查重分析已完成，无需重复分析。'] });
    const nextState = await workspaceStore.updateDuplicateCheck({ analysisTask: skippedTask });
    await updateTask({ status: 'success', progress: 100, logs: ['标书查重分析已完成，无需重复分析。'] }, nextState as unknown as boolean);
    developerLogger.write('duplicate.task.skipped', { signature, reason: 'already_success' });
    return;
  }

  const metadataAnalysis = createInitialAnalysis(signature, bidFiles);
  const outlineAnalysis = createInitialOutlineAnalysis(signature, bidFiles);
  const contentAnalysis = createInitialContentAnalysis(signature, bidFiles);
  const imageAnalysis = createInitialImageAnalysis(signature, bidFiles);
  const initialLogs = [force ? '开始重新执行标书查重分析。' : '开始执行标书查重分析。'];
  let latestLog = initialLogs[0];

  const initialTask = await updateTask({ status: 'running', progress: 0, logs: initialLogs });
  const initialState = await workspaceStore.updateDuplicateCheck({
    tenderFile: tenderFiles[0] || null,
    tenderFiles,
    bidFiles,
    metadataAnalysis,
    outlineAnalysis,
    contentAnalysis,
    imageAnalysis,
    analysisTask: initialTask,
  });
  await updateTask({ status: 'running', progress: 0, logs: initialLogs }, initialState as unknown as boolean);

  const notify = async (nextState: Record<string, any>): Promise<void> => {
    const message = latestAnalysisMessage(nextState);
    const partial: Record<string, unknown> = { status: 'running', progress: overallProgress(nextState) };
    if (message && message !== latestLog) {
      latestLog = message;
      partial.logs = [message];
    }
    await updateTask(partial as Parameters<typeof updateTask>[0], nextState as unknown as boolean);
  };

  const finalStatus = await runPipeline(workspaceStore, paths.duplicateCheckContentDir, paths.resolve.bind(paths), signature, tenderFiles, bidFiles, notify, isCurrent);

  const doneLog = finalStatus === 'success' ? '标书查重分析完成。' : '标书查重分析完成，部分结果失败。';
  const finalTask = await updateTask({ status: finalStatus, progress: 100, logs: [doneLog] });
  if (!(await isCurrent())) {
    developerLogger.write('duplicate.task.stale_signature', { signature });
    return;
  }
  const finalState = await workspaceStore.updateDuplicateCheck({ analysisTask: finalTask });
  await updateTask({ status: finalStatus, progress: 100, logs: [doneLog] }, finalState as unknown as boolean);
  developerLogger.write('duplicate.task.completed', { signature, status: finalStatus, progress: 100 });
};
