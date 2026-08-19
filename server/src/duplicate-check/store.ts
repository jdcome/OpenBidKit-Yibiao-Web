// 标书查重命名空间 store：移植自 client/electron/services/duplicateCheckStore.cjs。
// 全纯 DB 状态读写（better-sqlite3 同步 → Prisma 异步），按 projectId 隔离。
// 关键纠正：本域无 embedding/BGE-M3/向量代码（早前标记错误）——查重算法全确定性 CPU-only
// （bigram Dice / LCS / SHA-256 哈希），都在 duplicateCheckService.cjs 的 runAnalysisTask 里，
// 属 P6 任务引擎范畴，不在本 store。
//
// FS 纠缠（P3 全 no-op）：clearDuplicateContentArtifacts/ensureDirectories/hashFileIfReadable
// 依赖本地文件系统，web 版无对应文件；content_hash 列留 null（读路径已容忍）。
//
// DTO 是混合大小写：顶层 workspace 标量 camelCase（tenderFile/bidFiles/step/activeAnalysisTab/
// analysisTask/metadataAnalysis...），分析子状态 envelope 混合（status/progress/message/signature/
// started_at/updated_at 为 snake_case，contentExtraction/tenderSentenceCount 等为 camelCase），
// item/row/file 详情字段全 snake_case（file_id/file_name/content_path...）。详见 bid.ts:63-233。
import crypto from 'node:crypto';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';

type Tx = Prisma.TransactionClient;

const initialState = {
  tenderFile: null,
  tenderFiles: [],
  bidFiles: [],
  step: 'upload',
  activeAnalysisTab: 'metadata',
  analysisTask: undefined,
  metadataAnalysis: undefined,
  outlineAnalysis: undefined,
  contentAnalysis: undefined,
  imageAnalysis: undefined,
};

const sectionFields: Record<string, string> = {
  metadata: 'metadataAnalysis',
  outline: 'outlineAnalysis',
  content: 'contentAnalysis',
  image: 'imageAnalysis',
};

const fieldSections: Record<string, string> = Object.fromEntries(
  Object.entries(sectionFields).map(([section, field]) => [field, section]),
);

function now(): string {
  return new Date().toISOString();
}

function hasOwn(value: unknown, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function toDbBool(value: unknown): number {
  return value ? 1 : 0;
}

function fromDbBool(value: unknown): boolean {
  return Number(value) === 1;
}

function normalizeStatus(value: unknown, allowed: string[], fallback: string): string {
  return allowed.includes(value as string) ? (value as string) : fallback;
}

function normalizeStep(value: unknown): string {
  return value === 'analysis' ? 'analysis' : 'upload';
}

function normalizeTab(value: unknown): string {
  return ['metadata', 'outline', 'content', 'image'].includes(value as string) ? (value as string) : 'metadata';
}

function stableFileId(file: { id?: string; file_path?: string; file_name?: string } | null): string {
  return (
    file?.id ||
    crypto
      .createHash('sha1')
      .update(String(file?.file_path || file?.file_name || ''))
      .digest('hex')
  );
}

function normalizeFile(file: unknown): { id: string; file_name: string; file_path: string; extension: string; size: number; modified_at: string } | null {
  if (!file || typeof file !== 'object') return null;
  const f = file as Record<string, unknown>;
  const fileId = stableFileId(f as never);
  const fileName = String(f.file_name || '').trim();
  const filePath = String(f.file_path || '').trim();
  if (!fileId || !fileName || !filePath) return null;
  return {
    id: fileId,
    file_name: fileName,
    file_path: filePath,
    extension: String(f.extension || path.extname(fileName) || '').toLowerCase(),
    size: Number(f.size || 0),
    modified_at: String(f.modified_at || ''),
  };
}

function normalizeTenderFiles(
  tenderFiles: unknown,
  tenderFile: unknown,
): { id: string; file_name: string; file_path: string; extension: string; size: number; modified_at: string }[] {
  const files = Array.isArray(tenderFiles) ? tenderFiles : [tenderFile].filter(Boolean);
  return files.map(normalizeFile).filter(Boolean) as never[];
}

function createSignature({ tenderFile, tenderFiles, bidFiles }: { tenderFile?: unknown; tenderFiles?: unknown; bidFiles?: unknown } = {}): string {
  const files = [...normalizeTenderFiles(tenderFiles, tenderFile), ...(Array.isArray(bidFiles) ? bidFiles : [])]
    .filter(Boolean)
    .map((file) => `${(file as { file_path: string }).file_path}|${(file as { size: number }).size}|${(file as { modified_at: string }).modified_at}`);
  return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
}

function scopedOutlineItemId(fileId: string, itemId: string): string {
  return `${fileId}::${itemId}`;
}

function unscopedOutlineItemId(itemId: unknown): string {
  const s = String(itemId || '');
  return s.includes('::') ? s.split('::').slice(1).join('::') : s;
}

function fileFromRow(row: {
  fileId: string;
  fileName: string;
  filePath: string;
  extension: string;
  size: number;
  modifiedAt: string | null;
}): { id: string; file_name: string; file_path: string; extension: string; size: number; modified_at: string } {
  return {
    id: row.fileId,
    file_name: row.fileName,
    file_path: row.filePath,
    extension: row.extension,
    size: Number(row.size || 0),
    modified_at: row.modifiedAt || '',
  };
}

function taskFromRow(row: {
  taskId: string;
  type: string;
  status: string;
  progress: number;
  logsJson: unknown;
  startedAt: string;
  updatedAt: string;
  error: string | null;
  statsJson: unknown;
  payloadSignature: string | null;
} | null): Record<string, unknown> | undefined {
  if (!row) return undefined;
  return {
    task_id: row.taskId,
    type: row.type,
    status: normalizeStatus(row.status, ['running', 'success', 'error'], 'running'),
    progress: Number(row.progress || 0),
    logs: Array.isArray(row.logsJson) ? row.logsJson : [],
    started_at: row.startedAt,
    updated_at: row.updatedAt,
    error: row.error || undefined,
    stats: row.statsJson ?? undefined,
    payload_signature: row.payloadSignature || undefined,
  };
}

function createEmptyProgress(status = 'pending', total = 0): { status: string; completed: number; total: number } {
  return { status, completed: 0, total };
}

// Prisma Json 列写入辅助：null/undefined → DbNull（SQL NULL），其余强转为 InputJsonValue。
function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

interface MetadataFile {
  file_id: string;
  file_name: string;
  status: string;
  metadata: MetadataItem[];
  error?: string;
}

interface MetadataItem {
  key: string;
  label: string;
  value: string;
  normalized?: string;
  date_day?: string;
  comparable: boolean;
  date_comparable: boolean;
}

// 纯函数：从内存中的 files（含 metadata）构造对比行（duplicate_file_ids / same_day_file_ids）。
function buildRows(files: MetadataFile[]): Record<string, unknown>[] {
  const keyOrder: string[] = [];
  const rowsByKey = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    for (const item of file.metadata || []) {
      if (!rowsByKey.has(item.key)) {
        keyOrder.push(item.key);
        rowsByKey.set(item.key, { key: item.key, label: item.label, values: {}, duplicate_file_ids: [], same_day_file_ids: [] });
      }
      (rowsByKey.get(item.key)!.values as Record<string, string>)[file.file_id] = item.value;
    }
  }

  for (const key of keyOrder) {
    const row = rowsByKey.get(key)!;
    const normalizedToFiles = new Map<string, string[]>();
    const dayToFiles = new Map<string, string[]>();
    for (const file of files) {
      const item = (file.metadata || []).find((entry) => entry.key === key);
      if (!item?.comparable || !item.normalized) continue;
      if (item.date_comparable) {
        if (!item.date_day) continue;
        const list = dayToFiles.get(item.date_day) || [];
        list.push(file.file_id);
        dayToFiles.set(item.date_day, list);
        continue;
      }
      const list = normalizedToFiles.get(item.normalized) || [];
      list.push(file.file_id);
      normalizedToFiles.set(item.normalized, list);
    }
    row.duplicate_file_ids = Array.from(new Set(Array.from(normalizedToFiles.values()).filter((ids) => ids.length > 1).flat()));
    row.same_day_file_ids = Array.from(new Set(Array.from(dayToFiles.values()).filter((ids) => ids.length > 1).flat()));
  }

  return keyOrder.map((key) => rowsByKey.get(key)!);
}

// 从 analysis 子状态抽取要存进 stats_json 的精简快照（对应桌面 createSectionStats）。
function createSectionStats(section: string, analysis: Record<string, unknown>): Record<string, unknown> | undefined {
  if (section === 'metadata') {
    const files = Array.isArray(analysis.files) ? analysis.files : [];
    return {
      contentExtraction: analysis.contentExtraction,
      metadataExtraction: analysis.metadataExtraction,
      logs: analysis.logs,
      files: files.map((file) => {
        const f = file as { file_id: string; file_name: string; status: string; error?: string };
        return { file_id: f.file_id, file_name: f.file_name, status: f.status, error: f.error };
      }),
    };
  }
  if (section === 'outline') {
    const files = Array.isArray(analysis.files) ? analysis.files : [];
    return {
      tenderSentenceCount: analysis.tenderSentenceCount,
      tenderMatchedItemCount: analysis.tenderMatchedItemCount,
      extraction: analysis.extraction,
      files: files.map((file) => {
        const f = file as Record<string, unknown>;
        return {
          file_id: f.file_id,
          file_name: f.file_name,
          status: f.status,
          source: f.source,
          confidence: f.confidence,
          item_count: f.item_count,
          tender_matched_count: f.tender_matched_count,
          error: f.error,
        };
      }),
    };
  }
  if (section === 'content') {
    return {
      tenderSentenceCount: analysis.tenderSentenceCount,
      tenderMatchedSentenceCount: analysis.tenderMatchedSentenceCount,
      totalSentenceCount: analysis.totalSentenceCount,
      extraction: analysis.extraction,
    };
  }
  if (section === 'image') {
    return {
      extraction: analysis.extraction,
      totalImageCount: analysis.totalImageCount,
    };
  }
  return undefined;
}

export function createDuplicateCheckStore(prisma: PrismaClient) {
  // ---- meta ----
  async function ensureMetaRow(projectId: number, client: Tx | PrismaClient) {
    const existing = await client.duplicateCheckMeta.findUnique({ where: { projectId } });
    if (existing) return existing;
    const timestamp = now();
    return client.duplicateCheckMeta.create({
      data: { projectId, step: 'upload', activeAnalysisTab: 'metadata', createdAt: timestamp, updatedAt: timestamp },
    });
  }

  async function updateMeta(projectId: number, client: Tx | PrismaClient, fields: Record<string, unknown>) {
    await ensureMetaRow(projectId, client);
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const data: Record<string, unknown> = {};
    for (const [key, value] of entries) data[key] = value;
    data.updatedAt = now();
    await client.duplicateCheckMeta.update({ where: { projectId }, data });
  }

  // ---- files ----
  async function loadFiles(projectId: number, client: Tx | PrismaClient) {
    const rows = await client.duplicateCheckFile.findMany({
      where: { projectId },
      orderBy: [{ role: 'asc' }, { sortOrder: 'asc' }],
    });
    const tenderRows = rows.filter((row) => row.role === 'tender').sort((a, b) => a.sortOrder - b.sortOrder);
    const bidRows = rows.filter((row) => row.role === 'bid').sort((a, b) => a.sortOrder - b.sortOrder);
    const tenderFiles = tenderRows.map(fileFromRow);
    return {
      tenderFile: tenderFiles[0] || null,
      tenderFiles,
      bidFiles: bidRows.map(fileFromRow),
    };
  }

  async function loadFileNameMap(projectId: number, client: Tx | PrismaClient): Promise<Map<string, string>> {
    const rows = await client.duplicateCheckFile.findMany({ where: { projectId }, select: { fileId: true, fileName: true } });
    return new Map(rows.map((r) => [r.fileId, r.fileName]));
  }

  async function replaceFiles(
    projectId: number,
    client: Tx | PrismaClient,
    tenderFiles: unknown,
    bidFiles: unknown,
    legacyTenderFile: unknown,
  ) {
    await client.duplicateCheckFile.deleteMany({ where: { projectId } });
    const timestamp = now();
    const normalizedTenderFiles = normalizeTenderFiles(tenderFiles, legacyTenderFile);
    const rows: Record<string, unknown>[] = [];
    normalizedTenderFiles.forEach((nt, index) => {
      rows.push({
        projectId,
        fileId: nt.id,
        role: 'tender',
        fileName: nt.file_name,
        filePath: nt.file_path,
        extension: nt.extension,
        size: nt.size,
        modifiedAt: nt.modified_at,
        sortOrder: index,
        contentHash: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    });
    (Array.isArray(bidFiles) ? bidFiles : [])
      .map(normalizeFile)
      .filter(Boolean)
      .forEach((file, index) => {
        rows.push({
          projectId,
          fileId: file!.id,
          role: 'bid',
          fileName: file!.file_name,
          filePath: file!.file_path,
          extension: file!.extension,
          size: file!.size,
          modifiedAt: file!.modified_at,
          sortOrder: index,
          contentHash: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      });
    if (rows.length) await client.duplicateCheckFile.createMany({ data: rows as never[] });
    await updateMeta(projectId, client, { currentSignature: createSignature({ tenderFiles: normalizedTenderFiles, bidFiles }) });
  }

  // ---- task ----
  async function saveTask(projectId: number, client: Tx | PrismaClient, type: string, task: Record<string, unknown> | undefined | null) {
    if (!task) {
      await client.duplicateCheckTask.deleteMany({ where: { projectId, type } });
      return;
    }
    const timestamp = now();
    const data = {
      taskId: String((task as { task_id?: string }).task_id || ''),
      status: String((task as { status?: string }).status || 'running'),
      progress: Math.max(0, Math.min(100, Math.round(Number((task as { progress?: number }).progress || 0)))),
      logsJson: jsonOrNull(Array.isArray((task as { logs?: unknown[] }).logs) ? (task as { logs: unknown[] }).logs : []),
      statsJson: jsonOrNull((task as { stats?: unknown }).stats),
      error: (task as { error?: string }).error ? String((task as { error: string }).error) : null,
      payloadSignature: (task as { payload_signature?: string }).payload_signature ? String((task as { payload_signature: string }).payload_signature) : null,
      startedAt: (task as { started_at?: string }).started_at || timestamp,
      updatedAt: (task as { updated_at?: string }).updated_at || timestamp,
    };
    await client.duplicateCheckTask.upsert({
      where: { projectId_type: { projectId, type } },
      create: { projectId, type, ...data },
      update: data,
    });
  }

  async function loadTask(projectId: number, client: Tx | PrismaClient, type: string) {
    const row = await client.duplicateCheckTask.findUnique({ where: { projectId_type: { projectId, type } } });
    return taskFromRow(row);
  }

  // ---- section (analysis sub-state envelope) ----
  async function saveSection(projectId: number, client: Tx | PrismaClient, section: string, analysis: Record<string, unknown> | undefined) {
    if (!analysis) {
      await clearSection(projectId, client, section);
      return;
    }
    const timestamp = now();
    const stats = createSectionStats(section, analysis);
    const data = {
      status: String((analysis as { status?: string }).status || 'pending'),
      progress: Math.max(0, Math.min(100, Math.round(Number((analysis as { progress?: number }).progress || 0)))),
      message: String((analysis as { message?: string }).message || ''),
      signature: (analysis as { signature?: string }).signature ? String((analysis as { signature: string }).signature) : null,
      statsJson: jsonOrNull(stats),
      startedAt: (analysis as { started_at?: string }).started_at || timestamp,
      updatedAt: (analysis as { updated_at?: string }).updated_at || timestamp,
    };
    await client.duplicateCheckAnalysisSection.upsert({
      where: { projectId_section: { projectId, section } },
      create: { projectId, section, ...data },
      update: data,
    });

    if (section === 'metadata') await saveMetadataAnalysisDetails(projectId, client, analysis);
    if (section === 'outline') await saveOutlineAnalysisDetails(projectId, client, analysis);
    if (section === 'content') await saveContentAnalysisDetails(projectId, client, analysis);
    if (section === 'image') await saveImageAnalysisDetails(projectId, client, analysis);
  }

  async function clearSection(projectId: number, client: Tx | PrismaClient, section: string) {
    await client.duplicateCheckAnalysisSection.deleteMany({ where: { projectId, section } });
    if (section === 'metadata') {
      await client.duplicateCheckContentFile.deleteMany({ where: { projectId } });
      await client.duplicateCheckMetadataItem.deleteMany({ where: { projectId } });
      await client.duplicateCheckFile.updateMany({ where: { projectId }, data: { contentHash: null, updatedAt: now() } });
    }
    if (section === 'outline') {
      await client.duplicateCheckOutlineItem.deleteMany({ where: { projectId } });
      await client.duplicateCheckOutlineGroup.deleteMany({ where: { projectId } });
      await client.duplicateCheckOutlinePairwise.deleteMany({ where: { projectId } });
    }
    if (section === 'content') {
      await client.duplicateCheckContentOccurrence.deleteMany({ where: { projectId } });
      await client.duplicateCheckContentDuplicate.deleteMany({ where: { projectId } });
    }
    if (section === 'image') {
      await client.duplicateCheckImageOccurrence.deleteMany({ where: { projectId } });
      await client.duplicateCheckDuplicateImage.deleteMany({ where: { projectId } });
      await client.duplicateCheckImageFile.deleteMany({ where: { projectId } });
    }
  }

  async function clearAnalysisState(projectId: number, client: Tx | PrismaClient) {
    for (const section of Object.keys(sectionFields)) await clearSection(projectId, client, section);
    await client.duplicateCheckTask.deleteMany({ where: { projectId } });
  }

  // ---- analysis detail writers（由 runAnalysisTask 任务引擎经 updateState 触发，P3 移植写路径，FS hash 部分 stub→null） ----
  async function saveMetadataAnalysisDetails(projectId: number, client: Tx | PrismaClient, analysis: Record<string, unknown>) {
    await client.duplicateCheckContentFile.deleteMany({ where: { projectId } });
    await client.duplicateCheckMetadataItem.deleteMany({ where: { projectId } });
    const timestamp = now();
    await client.duplicateCheckFile.updateMany({ where: { projectId }, data: { contentHash: null, updatedAt: timestamp } });

    const contentFiles = (Array.isArray(analysis.contentFiles) ? analysis.contentFiles : []).filter(
      (item) => (item as { file_id?: string })?.file_id,
    ) as { file_id: string; status?: string; content_path?: string; content_length?: number; parser_label?: string; error?: string; content_hash?: string; updated_at?: string }[];
    if (contentFiles.length) {
      await client.duplicateCheckContentFile.createMany({
        data: contentFiles.map((item) => ({
          projectId,
          fileId: String(item.file_id),
          status: String(item.status || 'pending'),
          contentPath: item.content_path ? String(item.content_path) : null,
          contentLength: Number(item.content_length || 0),
          parserLabel: item.parser_label ? String(item.parser_label) : null,
          error: item.error ? String(item.error) : null,
          updatedAt: item.updated_at || timestamp,
        })),
      });
      // content_hash：桌面读 FS 算 sha256；web 无文件，仅当上游显式传 content_hash 时用，否则 null。
      for (const item of contentFiles) {
        await client.duplicateCheckFile.update({
          where: { fileId: String(item.file_id) },
          data: { contentHash: item.content_hash ? String(item.content_hash) : null, updatedAt: item.updated_at || timestamp },
        });
      }
    }

    const metadataRows: Record<string, unknown>[] = [];
    const filesRaw = (Array.isArray(analysis.files) ? analysis.files : []) as { file_id?: string; metadata?: MetadataItem[] }[];
    for (const file of filesRaw) {
      if (!file?.file_id) continue;
      (Array.isArray(file.metadata) ? file.metadata : []).forEach((item, index) => {
        if (!item?.key) return;
        metadataRows.push({
          projectId,
          fileId: String(file.file_id),
          key: String(item.key),
          label: String(item.label || item.key),
          value: String(item.value || ''),
          normalized: item.normalized ? String(item.normalized) : null,
          dateDay: item.date_day ? String(item.date_day) : null,
          comparable: toDbBool(item.comparable),
          dateComparable: toDbBool(item.date_comparable),
          sortOrder: index,
        });
      });
    }
    if (metadataRows.length) await client.duplicateCheckMetadataItem.createMany({ data: metadataRows as never[] });
  }

  async function saveOutlineAnalysisDetails(projectId: number, client: Tx | PrismaClient, analysis: Record<string, unknown>) {
    await client.duplicateCheckOutlineItem.deleteMany({ where: { projectId } });
    await client.duplicateCheckOutlineGroup.deleteMany({ where: { projectId } });
    await client.duplicateCheckOutlinePairwise.deleteMany({ where: { projectId } });

    const itemRows: Record<string, unknown>[] = [];
    const filesRaw = (Array.isArray(analysis.files) ? analysis.files : []) as {
      file_id?: string;
      source?: string;
      confidence?: number;
      items?: Record<string, unknown>[];
    }[];
    for (const file of filesRaw) {
      for (const item of Array.isArray(file.items) ? file.items : []) {
        if (!(item as { id?: string })?.id || !file?.file_id) continue;
        const itemId = String((item as { id: string }).id);
        const parentId = (item as { parent_id?: string }).parent_id;
        itemRows.push({
          projectId,
          itemId: scopedOutlineItemId(String(file.file_id), itemId),
          fileId: String(file.file_id),
          parentItemId: parentId ? scopedOutlineItemId(String(file.file_id), String(parentId)) : null,
          level: Number((item as { level?: number }).level || 1),
          number: (item as { number?: string }).number ? String((item as { number: string }).number) : null,
          title: String((item as { title?: string }).title || ''),
          normalizedTitle: String((item as { normalized_title?: string }).normalized_title || ''),
          pathTitlesJson: Array.isArray((item as { path_titles?: unknown[] }).path_titles) ? (item as { path_titles: unknown[] }).path_titles : [],
          normalizedPath: String((item as { normalized_path?: string }).normalized_path || ''),
          source: String((item as { source?: string }).source || file.source || 'semantic'),
          confidence: Number((item as { confidence?: number }).confidence ?? file.confidence ?? 0),
          sortOrder: Number((item as { order?: number }).order || 0),
          fromTender: toDbBool((item as { from_tender?: unknown }).from_tender),
          matchedTenderSentence: (item as { matched_tender_sentence?: string }).matched_tender_sentence
            ? String((item as { matched_tender_sentence: string }).matched_tender_sentence)
            : null,
        });
      }
    }
    if (itemRows.length) await client.duplicateCheckOutlineItem.createMany({ data: itemRows as never[] });

    const groupRows: Record<string, unknown>[] = [];
    (Array.isArray(analysis.duplicateGroups) ? analysis.duplicateGroups : []).forEach((group, index) => {
      const g = group as { id?: string; type?: string; title?: string; score?: number; file_ids?: string[]; item_ids?: Record<string, unknown>; paths?: Record<string, unknown> };
      if (!g?.id) return;
      groupRows.push({
        projectId,
        groupId: String(g.id),
        type: String(g.type || 'duplicate'),
        title: String(g.title || ''),
        score: Number(g.score || 0),
        fileIdsJson: Array.isArray(g.file_ids) ? g.file_ids : [],
        itemIdsJson: g.item_ids || {},
        pathsJson: g.paths || {},
        sortOrder: index,
      });
    });
    if (groupRows.length) await client.duplicateCheckOutlineGroup.createMany({ data: groupRows as never[] });

    const pairwiseRows: Record<string, unknown>[] = [];
    const pairs = (Array.isArray(analysis.pairwiseSimilarities) ? analysis.pairwiseSimilarities : []) as {
      file_a_id?: string;
      file_b_id?: string;
      score?: number;
      title_overlap?: number;
      path_overlap?: number;
      order_similarity?: number;
      shared_count?: number;
      risk?: string;
    }[];
    for (const item of pairs) {
      if (!item?.file_a_id || !item?.file_b_id) continue;
      pairwiseRows.push({
        projectId,
        fileAId: String(item.file_a_id),
        fileBId: String(item.file_b_id),
        score: Number(item.score || 0),
        titleOverlap: Number(item.title_overlap || 0),
        pathOverlap: Number(item.path_overlap || 0),
        orderSimilarity: Number(item.order_similarity || 0),
        sharedCount: Number(item.shared_count || 0),
        risk: String(item.risk || 'none'),
      });
    }
    if (pairwiseRows.length) await client.duplicateCheckOutlinePairwise.createMany({ data: pairwiseRows as never[] });
  }

  async function saveContentAnalysisDetails(projectId: number, client: Tx | PrismaClient, analysis: Record<string, unknown>) {
    await client.duplicateCheckContentOccurrence.deleteMany({ where: { projectId } });
    await client.duplicateCheckContentDuplicate.deleteMany({ where: { projectId } });

    const dupRows: Record<string, unknown>[] = [];
    const occRows: Record<string, unknown>[] = [];
    (Array.isArray(analysis.duplicateSentences) ? analysis.duplicateSentences : []).forEach((item, index) => {
      const it = item as { id?: string; sentence?: string; normalized?: string; file_ids?: string[]; occurrences?: Record<string, number>; first_order?: number };
      const duplicateId = it?.id || `C${String(index + 1).padStart(6, '0')}`;
      dupRows.push({
        projectId,
        duplicateId,
        sentence: String(it?.sentence || ''),
        normalized: String(it?.normalized || ''),
        fileIdsJson: Array.isArray(it?.file_ids) ? it.file_ids : [],
        firstOrder: Number(it?.first_order ?? index),
      });
      for (const [fileId, count] of Object.entries(it?.occurrences || {})) {
        occRows.push({ projectId, duplicateId, fileId, occurrenceCount: Number(count || 0) });
      }
    });
    if (dupRows.length) await client.duplicateCheckContentDuplicate.createMany({ data: dupRows as never[] });
    if (occRows.length) await client.duplicateCheckContentOccurrence.createMany({ data: occRows as never[] });
  }

  async function saveImageAnalysisDetails(projectId: number, client: Tx | PrismaClient, analysis: Record<string, unknown>) {
    await client.duplicateCheckImageOccurrence.deleteMany({ where: { projectId } });
    await client.duplicateCheckDuplicateImage.deleteMany({ where: { projectId } });
    await client.duplicateCheckImageFile.deleteMany({ where: { projectId } });
    const timestamp = now();

    const filesRaw = (Array.isArray(analysis.files) ? analysis.files : []) as {
      file_id?: string;
      status?: string;
      image_count?: number;
      unique_image_count?: number;
      error?: string;
      updated_at?: string;
    }[];
    const fileRows = filesRaw.filter((file) => file?.file_id).map((file) => ({
      projectId,
      fileId: String(file.file_id),
      status: String(file.status || 'pending'),
      imageCount: Number(file.image_count || 0),
      uniqueImageCount: Number(file.unique_image_count || 0),
      error: file.error ? String(file.error) : null,
      updatedAt: file.updated_at || timestamp,
    }));
    if (fileRows.length) await client.duplicateCheckImageFile.createMany({ data: fileRows });

    const imgRows: Record<string, unknown>[] = [];
    const occRows: Record<string, unknown>[] = [];
    const images = (Array.isArray(analysis.duplicateImages) ? analysis.duplicateImages : []) as {
      id?: string;
      hash?: string;
      preview_url?: string;
      file_ids?: string[];
      occurrences?: Record<string, number>;
      locations?: Record<string, unknown>;
    }[];
    images.forEach((item, index) => {
      const imageId = item?.id || `I${String(index + 1).padStart(6, '0')}`;
      imgRows.push({
        projectId,
        imageId,
        hash: String(item?.hash || ''),
        previewUrl: String(item?.preview_url || ''),
        fileIdsJson: Array.isArray(item?.file_ids) ? item.file_ids : [],
        sortOrder: index,
      });
      for (const [fileId, count] of Object.entries(item?.occurrences || {})) {
        const loc = item?.locations?.[fileId];
        occRows.push({
          projectId,
          imageId,
          fileId,
          occurrenceCount: Number(count || 0),
          locationsJson: loc === undefined ? Prisma.DbNull : loc,
        });
      }
    });
    if (imgRows.length) await client.duplicateCheckDuplicateImage.createMany({ data: imgRows as never[] });
    if (occRows.length) await client.duplicateCheckImageOccurrence.createMany({ data: occRows as never[] });
  }

  // ---- analysis section readers（纯 SELECT + JSON，无模型调用） ----
  async function loadMetadataAnalysis(
    projectId: number,
    client: Tx | PrismaClient,
    row: { status: string; progress: number; message: string; signature: string | null; startedAt: string | null; updatedAt: string | null; statsJson: unknown } | null,
  ) {
    if (!row) return undefined;
    const stats = ((row.statsJson ?? {}) as Record<string, unknown>) || {};
    const nameMap = await loadFileNameMap(projectId, client);
    const resolveName = (fileId: string) => nameMap.get(fileId) || fileId;
    const { bidFiles } = await loadFiles(projectId, client);

    const contentFiles = (
      await client.duplicateCheckContentFile.findMany({ where: { projectId }, orderBy: { fileId: 'asc' } })
    ).map((item) => ({
      file_id: item.fileId,
      file_name: resolveName(item.fileId),
      status: normalizeStatus(item.status, ['pending', 'running', 'success', 'error'], 'pending'),
      content_path: item.contentPath || undefined,
      content_length: Number(item.contentLength || 0),
      parser_label: item.parserLabel || undefined,
      error: item.error || undefined,
    }));

    const metadataRows = await client.duplicateCheckMetadataItem.findMany({
      where: { projectId },
      orderBy: [{ fileId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
    const statusByFile = new Map<string, Record<string, unknown>>(
      (Array.isArray(stats.files) ? stats.files : []).map((file) => [
        (file as { file_id: string }).file_id,
        file as Record<string, unknown>,
      ]),
    );
    const filesById = new Map<string, MetadataFile>();
    for (const file of bidFiles) {
      const summary = statusByFile.get(file.id) || {};
      filesById.set(file.id, {
        file_id: file.id,
        file_name: file.file_name,
        status: (summary.status as string) || 'pending',
        metadata: [],
        error: summary.error as string | undefined,
      });
    }
    for (const item of metadataRows) {
      if (!filesById.has(item.fileId)) {
        const summary = statusByFile.get(item.fileId) || {};
        filesById.set(item.fileId, {
          file_id: item.fileId,
          file_name: resolveName(item.fileId),
          status: (summary.status as string) || 'success',
          metadata: [],
          error: summary.error as string | undefined,
        });
      }
      filesById.get(item.fileId)!.metadata.push({
        key: item.key,
        label: item.label,
        value: item.value || '',
        normalized: item.normalized || undefined,
        date_day: item.dateDay || undefined,
        comparable: fromDbBool(item.comparable),
        date_comparable: fromDbBool(item.dateComparable),
      });
    }
    const files = Array.from(filesById.values());
    return {
      status: normalizeStatus(row.status, ['pending', 'running', 'success', 'error'], 'pending'),
      progress: Number(row.progress || 0),
      message: row.message || '',
      signature: row.signature || undefined,
      started_at: row.startedAt || undefined,
      updated_at: row.updatedAt || undefined,
      contentExtraction: (stats.contentExtraction as Record<string, unknown>) || createEmptyProgress('pending', contentFiles.length),
      metadataExtraction: (stats.metadataExtraction as Record<string, unknown>) || createEmptyProgress('pending', files.length),
      files,
      rows: buildRows(files),
      contentFiles,
      logs: Array.isArray(stats.logs) ? stats.logs : [],
    };
  }

  async function loadOutlineAnalysis(
    projectId: number,
    client: Tx | PrismaClient,
    row: { status: string; progress: number; message: string; signature: string | null; startedAt: string | null; updatedAt: string | null; statsJson: unknown } | null,
  ) {
    if (!row) return undefined;
    const stats = ((row.statsJson ?? {}) as Record<string, unknown>) || {};
    const { bidFiles } = await loadFiles(projectId, client);

    const itemsByFile = new Map<string, Record<string, unknown>[]>();
    const itemRows = await client.duplicateCheckOutlineItem.findMany({
      where: { projectId },
      orderBy: [{ fileId: 'asc' }, { sortOrder: 'asc' }],
    });
    for (const item of itemRows) {
      const list = itemsByFile.get(item.fileId) || [];
      list.push({
        id: unscopedOutlineItemId(item.itemId),
        level: Number(item.level || 1),
        number: item.number || undefined,
        title: item.title,
        normalized_title: item.normalizedTitle,
        path_titles: Array.isArray(item.pathTitlesJson) ? item.pathTitlesJson : [],
        normalized_path: item.normalizedPath,
        source: item.source,
        confidence: Number(item.confidence || 0),
        order: Number(item.sortOrder || 0),
        parent_id: item.parentItemId ? unscopedOutlineItemId(item.parentItemId) : undefined,
        from_tender: fromDbBool(item.fromTender),
        matched_tender_sentence: item.matchedTenderSentence || undefined,
        duplicate_group_ids: [],
        similar_group_ids: [],
      });
      itemsByFile.set(item.fileId, list);
    }

    const groupRows = await client.duplicateCheckOutlineGroup.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });
    const duplicateGroups = groupRows.map((group) => ({
      id: group.groupId,
      type: group.type,
      title: group.title,
      score: Number(group.score || 0),
      file_ids: Array.isArray(group.fileIdsJson) ? group.fileIdsJson : [],
      item_ids: (group.itemIdsJson as Record<string, string[]>) || {},
      paths: (group.pathsJson as Record<string, string[]>) || {},
    }));
    for (const group of duplicateGroups) {
      for (const [fileId, itemIds] of Object.entries(group.item_ids || {})) {
        const items = itemsByFile.get(fileId) || [];
        for (const itemId of Array.isArray(itemIds) ? itemIds : []) {
          const item = items.find((entry) => entry.id === itemId);
          if (item) {
            const field = group.type === 'similar' ? 'similar_group_ids' : 'duplicate_group_ids';
            const bucket = item[field] as string[];
            if (!bucket.includes(group.id)) bucket.push(group.id);
          }
        }
      }
    }

    const summaryByFile = new Map<string, Record<string, unknown>>(
      (Array.isArray(stats.files) ? stats.files : []).map((file) => [
        (file as { file_id: string }).file_id,
        file as Record<string, unknown>,
      ]),
    );
    const files = bidFiles.map((file) => {
      const summary = summaryByFile.get(file.id) || {};
      const items = itemsByFile.get(file.id) || [];
      const firstItem = items[0] as Record<string, unknown> | undefined;
      return {
        file_id: file.id,
        file_name: file.file_name,
        status: (summary.status as string) || (items.length ? 'success' : 'pending'),
        source: (summary.source as string) || firstItem?.source,
        confidence: Number(summary.confidence ?? firstItem?.confidence ?? 0),
        item_count: Number(summary.item_count ?? items.length),
        tender_matched_count: Number(summary.tender_matched_count ?? items.filter((item) => item.from_tender).length),
        items,
        error: summary.error as string | undefined,
      };
    });

    const pairwiseRows = await client.duplicateCheckOutlinePairwise.findMany({
      where: { projectId },
      orderBy: [{ score: 'desc' }, { id: 'asc' }],
    });
    const pairwiseSimilarities = pairwiseRows.map((item) => ({
      file_a_id: item.fileAId,
      file_b_id: item.fileBId,
      score: Number(item.score || 0),
      title_overlap: Number(item.titleOverlap || 0),
      path_overlap: Number(item.pathOverlap || 0),
      order_similarity: Number(item.orderSimilarity || 0),
      shared_count: Number(item.sharedCount || 0),
      risk: item.risk || 'none',
    }));

    return {
      status: normalizeStatus(row.status, ['pending', 'running', 'success', 'error'], 'pending'),
      progress: Number(row.progress || 0),
      message: row.message || '',
      signature: row.signature || undefined,
      started_at: row.startedAt || undefined,
      updated_at: row.updatedAt || undefined,
      tenderSentenceCount: Number(stats.tenderSentenceCount || 0),
      tenderMatchedItemCount: Number(stats.tenderMatchedItemCount || 0),
      extraction: (stats.extraction as Record<string, unknown>) || createEmptyProgress('pending', files.length),
      files,
      duplicateGroups,
      pairwiseSimilarities,
    };
  }

  async function loadContentAnalysis(
    projectId: number,
    client: Tx | PrismaClient,
    row: { status: string; progress: number; message: string; signature: string | null; startedAt: string | null; updatedAt: string | null; statsJson: unknown } | null,
  ) {
    if (!row) return undefined;
    const stats = ((row.statsJson ?? {}) as Record<string, unknown>) || {};
    const { bidFiles } = await loadFiles(projectId, client);

    const occurrenceRows = await client.duplicateCheckContentOccurrence.findMany({ where: { projectId } });
    const occurrenceMap = new Map<string, Record<string, number>>();
    for (const r of occurrenceRows) {
      const occurrences = occurrenceMap.get(r.duplicateId) || {};
      occurrences[r.fileId] = Number(r.occurrenceCount || 0);
      occurrenceMap.set(r.duplicateId, occurrences);
    }
    const dupRows = await client.duplicateCheckContentDuplicate.findMany({ where: { projectId }, orderBy: { firstOrder: 'asc' } });
    const duplicateSentences = dupRows.map((item) => ({
      id: item.duplicateId,
      sentence: item.sentence,
      normalized: item.normalized,
      file_ids: Array.isArray(item.fileIdsJson) ? item.fileIdsJson : [],
      occurrences: occurrenceMap.get(item.duplicateId) || {},
      first_order: Number(item.firstOrder || 0),
    }));

    return {
      status: normalizeStatus(row.status, ['pending', 'running', 'success', 'error'], 'pending'),
      progress: Number(row.progress || 0),
      message: row.message || '',
      signature: row.signature || undefined,
      started_at: row.startedAt || undefined,
      updated_at: row.updatedAt || undefined,
      tenderSentenceCount: Number(stats.tenderSentenceCount || 0),
      tenderMatchedSentenceCount: Number(stats.tenderMatchedSentenceCount || 0),
      totalSentenceCount: Number(stats.totalSentenceCount || 0),
      extraction: (stats.extraction as Record<string, unknown>) || createEmptyProgress('pending', bidFiles.length),
      duplicateSentences,
    };
  }

  async function loadImageAnalysis(
    projectId: number,
    client: Tx | PrismaClient,
    row: { status: string; progress: number; message: string; signature: string | null; startedAt: string | null; updatedAt: string | null; statsJson: unknown } | null,
  ) {
    if (!row) return undefined;
    const stats = ((row.statsJson ?? {}) as Record<string, unknown>) || {};
    const { bidFiles } = await loadFiles(projectId, client);
    const nameMap = await loadFileNameMap(projectId, client);
    const resolveName = (fileId: string) => nameMap.get(fileId) || fileId;

    const files = (
      await client.duplicateCheckImageFile.findMany({ where: { projectId }, orderBy: { fileId: 'asc' } })
    ).map((item) => ({
      file_id: item.fileId,
      file_name: resolveName(item.fileId),
      status: normalizeStatus(item.status, ['pending', 'running', 'success', 'error'], 'pending'),
      image_count: Number(item.imageCount || 0),
      unique_image_count: Number(item.uniqueImageCount || 0),
      error: item.error || undefined,
    }));

    const occurrenceRows = await client.duplicateCheckImageOccurrence.findMany({ where: { projectId } });
    const occurrenceMap = new Map<string, Record<string, number>>();
    const locationMap = new Map<string, Record<string, unknown>>();
    for (const item of occurrenceRows) {
      const occurrences = occurrenceMap.get(item.imageId) || {};
      occurrences[item.fileId] = Number(item.occurrenceCount || 0);
      occurrenceMap.set(item.imageId, occurrences);
      const locations = locationMap.get(item.imageId) || {};
      locations[item.fileId] = Array.isArray(item.locationsJson) ? item.locationsJson : [];
      locationMap.set(item.imageId, locations);
    }
    const imgRows = await client.duplicateCheckDuplicateImage.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });
    const duplicateImages = imgRows.map((item) => ({
      id: item.imageId,
      hash: item.hash,
      preview_url: item.previewUrl,
      file_ids: Array.isArray(item.fileIdsJson) ? item.fileIdsJson : [],
      occurrences: occurrenceMap.get(item.imageId) || {},
      locations: locationMap.get(item.imageId) || {},
    }));

    return {
      status: normalizeStatus(row.status, ['pending', 'running', 'success', 'error'], 'pending'),
      progress: Number(row.progress || 0),
      message: row.message || '',
      signature: row.signature || undefined,
      started_at: row.startedAt || undefined,
      updated_at: row.updatedAt || undefined,
      extraction: (stats.extraction as Record<string, unknown>) || createEmptyProgress('pending', bidFiles.length),
      totalImageCount: Number(stats.totalImageCount || 0),
      files,
      duplicateImages,
    };
  }

  async function loadAnalysisSections(projectId: number, client: Tx | PrismaClient) {
    const rows = await client.duplicateCheckAnalysisSection.findMany({ where: { projectId } });
    const bySection = new Map(rows.map((r) => [r.section, r]));
    return {
      metadataAnalysis: await loadMetadataAnalysis(projectId, client, bySection.get('metadata') ?? null),
      outlineAnalysis: await loadOutlineAnalysis(projectId, client, bySection.get('outline') ?? null),
      contentAnalysis: await loadContentAnalysis(projectId, client, bySection.get('content') ?? null),
      imageAnalysis: await loadImageAnalysis(projectId, client, bySection.get('image') ?? null),
    };
  }

  // ---- public API ----
  async function loadDuplicateCheck(projectId: number): Promise<Record<string, unknown>> {
    const meta = await ensureMetaRow(projectId, prisma);
    const files = await loadFiles(projectId, prisma);
    const analysisTask = await loadTask(projectId, prisma, 'duplicate-analysis');
    const sections = await loadAnalysisSections(projectId, prisma);
    return {
      ...initialState,
      ...files,
      step: normalizeStep(meta.step),
      activeAnalysisTab: normalizeTab(meta.activeAnalysisTab),
      analysisTask,
      ...sections,
    };
  }

  async function updateDuplicateCheck(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>> {
    await prisma.$transaction(async (tx) => {
      await ensureMetaRow(projectId, tx);
      const metaUpdates: Record<string, unknown> = {};
      if (hasOwn(partial, 'step')) metaUpdates.step = normalizeStep(partial.step);
      if (hasOwn(partial, 'activeAnalysisTab')) metaUpdates.activeAnalysisTab = normalizeTab(partial.activeAnalysisTab);
      if (Object.keys(metaUpdates).length) await updateMeta(projectId, tx, metaUpdates);

      if (hasOwn(partial, 'tenderFile') || hasOwn(partial, 'tenderFiles') || hasOwn(partial, 'bidFiles')) {
        const currentFiles = await loadFiles(projectId, tx);
        await replaceFiles(
          projectId,
          tx,
          hasOwn(partial, 'tenderFiles') ? partial.tenderFiles : currentFiles.tenderFiles,
          hasOwn(partial, 'bidFiles') ? partial.bidFiles : currentFiles.bidFiles,
          hasOwn(partial, 'tenderFile') ? partial.tenderFile : currentFiles.tenderFile,
        );
      }

      if (hasOwn(partial, 'analysisTask')) await saveTask(projectId, tx, 'duplicate-analysis', partial.analysisTask as Record<string, unknown> | undefined);
      for (const [field, section] of Object.entries(fieldSections)) {
        if (hasOwn(partial, field)) await saveSection(projectId, tx, section, partial[field] as Record<string, unknown> | undefined);
      }
    });
    return loadDuplicateCheck(projectId);
  }

  async function saveFiles(
    projectId: number,
    payload: { tenderFile?: unknown; tenderFiles?: unknown; bidFiles?: unknown; step?: unknown; activeAnalysisTab?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    await prisma.$transaction(async (tx) => {
      await ensureMetaRow(projectId, tx);
      await replaceFiles(
        projectId,
        tx,
        Array.isArray(payload.tenderFiles) ? payload.tenderFiles : [payload.tenderFile].filter(Boolean),
        Array.isArray(payload.bidFiles) ? payload.bidFiles : [],
        payload.tenderFile || null,
      );
      await clearAnalysisState(projectId, tx);
      await updateMeta(projectId, tx, { step: normalizeStep(payload.step), activeAnalysisTab: normalizeTab(payload.activeAnalysisTab) });
    });
    // clearDuplicateContentArtifacts()（FS rm + mkdir）web 版 no-op。
    return loadDuplicateCheck(projectId);
  }

  async function saveUiState(
    projectId: number,
    payload: { step?: unknown; activeAnalysisTab?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    return updateDuplicateCheck(projectId, { step: payload.step, activeAnalysisTab: payload.activeAnalysisTab });
  }

  async function clearDuplicateCheck(projectId: number): Promise<{ success: boolean; message: string; state: Record<string, unknown> }> {
    await prisma.$transaction(async (tx) => {
      await tx.duplicateCheckTask.deleteMany({ where: { projectId } });
      await tx.duplicateCheckAnalysisSection.deleteMany({ where: { projectId } });
      await tx.duplicateCheckImageOccurrence.deleteMany({ where: { projectId } });
      await tx.duplicateCheckDuplicateImage.deleteMany({ where: { projectId } });
      await tx.duplicateCheckImageFile.deleteMany({ where: { projectId } });
      await tx.duplicateCheckContentOccurrence.deleteMany({ where: { projectId } });
      await tx.duplicateCheckContentDuplicate.deleteMany({ where: { projectId } });
      await tx.duplicateCheckOutlinePairwise.deleteMany({ where: { projectId } });
      await tx.duplicateCheckOutlineGroup.deleteMany({ where: { projectId } });
      await tx.duplicateCheckOutlineItem.deleteMany({ where: { projectId } });
      await tx.duplicateCheckMetadataItem.deleteMany({ where: { projectId } });
      await tx.duplicateCheckContentFile.deleteMany({ where: { projectId } });
      await tx.duplicateCheckFile.deleteMany({ where: { projectId } });
      await tx.duplicateCheckMeta.deleteMany({ where: { projectId } });
      await ensureMetaRow(projectId, tx);
    });
    // FS rmSync(contentDir) + deleteImportedImageBatches + ensureDirectories —— web 版 no-op。
    return { success: true, message: '标书查重缓存已清空', state: await loadDuplicateCheck(projectId) };
  }

  return {
    loadDuplicateCheck,
    updateDuplicateCheck,
    saveFiles,
    saveUiState,
    clearDuplicateCheck,
  };
}

export type DuplicateCheckStore = ReturnType<typeof createDuplicateCheckStore>;
