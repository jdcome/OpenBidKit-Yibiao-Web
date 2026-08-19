// 知识库命名空间的 PG-backed 状态层（公司共享，无 userId 隔离）。
// 忠实移植自 client/electron/services/knowledgeBaseStore.cjs（纯 DB 部分）+
// knowledgeBaseService.cjs 的 envelope 包装（{success,message,index} 折进各方法）。
// P4：document_dir/source_path/markdown 落共享磁盘（<dataDir>/shared/knowledge-base/...，
// 相对 kbRoot 存 DB）；readMarkdown/deleteDocument/moveDocument 接真 FS；步骤模型（copy_source/
// convert_markdown/build_blocks）+ saveBlocks/readBlocks 落地，供 prepareDocument 跑 P4 三步；
// 步骤 4-9（LLM 抽取/匹配）+ onEvent 推送留 P6。
//
// 与 technical_plan 的混合大小写不同：本域 DTO 全 snake_case，与 Prisma 列名 camelCase
// 一一对应，需要 per-method 的 toXxxDto 做大小写映射（documentFromRow/folderFromRow）。
// 渲染器 KnowledgeDocument 契约不含 FS 字段（document_dir/source_path/markdown_path/
// markdown_chars/source_extension/parser_label），DTO 安全省略；服务端内部仍读写这些列。
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createKnowledgeBasePaths } from '../document/paths';
import { getActiveExtractionIds } from './registry';
import type { Report } from './prompts';

// awaiting_extraction：Web P4 专用 parked 态——copy/convert/build_blocks 三步完成、等待 P6 LLM 抽取。
// 桌面原 vocab 无此值（桌面直接续跑 LLM），渲染器 KnowledgeDocumentStatus 联合也未含；P8 挂真页面时
// 若类型校验阻断需扩联合。P6 任务引擎接管后会把它推进到 extracting。
const documentStatuses = ['pending', 'copying', 'converting', 'extracting', 'awaiting_extraction', 'ready_for_matching', 'matching', 'recovering', 'analyzing', 'saving', 'success', 'error'];

// 桌面 knowledge_document_steps.step_key 词表。P4 仅跑前三；后六属 P6 LLM。
const stepKeys = ['copy_source', 'convert_markdown', 'build_blocks', 'extract_first_items', 'extract_supplement_items', 'merge_candidates', 'match_batches', 'recover_missing', 'save_result'];

function now(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function safeName(name: unknown): string {
  return String(name || '未命名').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim() || '未命名';
}

function normalizeStatus(value: unknown): string {
  return typeof value === 'string' && documentStatuses.includes(value) ? value : 'pending';
}

function normalizeDropPosition(value: unknown): 'before' | 'after' {
  return value === 'before' ? 'before' : 'after';
}

function getContentCharCount(text: unknown): number {
  return String(text || '').replace(/\s+/g, '').length;
}

function readJson<T>(value: unknown, fallback: T): T {
  return value === null || value === undefined ? fallback : (value as T);
}

function reorderIds(ids: string[], draggedId: string, targetId: string, position: 'before' | 'after'): string[] {
  const draggedIndex = ids.indexOf(draggedId);
  const targetIndex = ids.indexOf(targetId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedId === targetId) return ids;
  const next = [...ids];
  const [dragged] = next.splice(draggedIndex, 1);
  const adjustedTargetIndex = next.indexOf(targetId);
  next.splice(position === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1, 0, dragged);
  return next;
}

// 渲染器 KnowledgeDocument DTO（snake_case，省略 FS 字段）。
export interface DocumentDto {
  id: string;
  folder_id: string;
  file_name: string;
  status: string;
  progress: number;
  message: string;
  item_count: number;
  block_count: number;
  filtered_block_count: number;
  candidate_item_count: number;
  discarded_block_count: number;
  system_discarded_after_retry_count: number;
  last_batch_size?: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  error?: string;
}

interface FolderDto {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function documentFromRow(row: {
  documentId: string;
  folderId: string;
  fileName: string;
  status: string;
  progress: number;
  message: string;
  error: string | null;
  itemCount: number;
  blockCount: number;
  filteredBlockCount: number;
  candidateItemCount: number;
  discardedBlockCount: number;
  systemDiscardedAfterRetryCount: number;
  lastBatchSize: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}): DocumentDto {
  const dto: DocumentDto = {
    id: row.documentId,
    folder_id: row.folderId,
    file_name: row.fileName,
    status: normalizeStatus(row.status),
    progress: Math.max(0, Math.min(100, Number(row.progress || 0))),
    message: row.message || '',
    item_count: Number(row.itemCount || 0),
    block_count: Number(row.blockCount || 0),
    filtered_block_count: Number(row.filteredBlockCount || 0),
    candidate_item_count: Number(row.candidateItemCount || 0),
    discarded_block_count: Number(row.discardedBlockCount || 0),
    system_discarded_after_retry_count: Number(row.systemDiscardedAfterRetryCount || 0),
    sort_order: Number(row.sortOrder || 0),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (row.lastBatchSize !== null && row.lastBatchSize !== undefined) {
    dto.last_batch_size = Number(row.lastBatchSize);
  }
  if (row.error) dto.error = row.error;
  return dto;
}

function folderFromRow(row: { folderId: string; name: string; sortOrder: number; createdAt: string; updatedAt: string }): FolderDto {
  return {
    id: row.folderId,
    name: row.name,
    sort_order: Number(row.sortOrder || 0),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function createKnowledgeBaseStore(prisma: PrismaClient) {
  const kb = createKnowledgeBasePaths();

  // 桌面 PG 无 @relation → 无 FK 级联；删文档必须显式清掉 8 张子表。
  async function cascadeDeleteDocument(documentId: string, client: Prisma.TransactionClient): Promise<void> {
    await client.knowledgeItemBlock.deleteMany({ where: { documentId } });
    await client.knowledgeItem.deleteMany({ where: { documentId } });
    await client.knowledgeDiscardedGroup.deleteMany({ where: { documentId } });
    await client.knowledgeReport.deleteMany({ where: { documentId } });
    await client.knowledgeMatchBatch.deleteMany({ where: { documentId } });
    await client.knowledgeDocumentStep.deleteMany({ where: { documentId } });
    await client.knowledgeBlock.deleteMany({ where: { documentId } });
    await client.knowledgeCandidateItem.deleteMany({ where: { documentId } });
    await client.knowledgeDocument.deleteMany({ where: { documentId } });
  }

  async function getDocumentRaw(documentId: string): Promise<DocumentDto> {
    const row = await prisma.knowledgeDocument.findUnique({ where: { documentId } });
    if (!row) throw new Error('知识库文档不存在');
    return documentFromRow(row);
  }

  // 内部用：返回含 FS 字段（documentDir/sourcePath/markdownPath/markdownHash/...）的完整行。
  async function getDocumentRow(documentId: string) {
    const row = await prisma.knowledgeDocument.findUnique({ where: { documentId } });
    if (!row) throw new Error('知识库文档不存在');
    return row;
  }

  // 内部用：camelCase 字段直接更新（status/progress/message/error/blockCount/...）+ updatedAt。
  async function updateDocument(documentId: string, partial: Record<string, unknown>): Promise<DocumentDto> {
    const row = await prisma.knowledgeDocument.update({
      where: { documentId },
      data: { ...partial, updatedAt: now() } as never,
    });
    return documentFromRow(row);
  }

  // 桌面 createDocument：全字段 upsert（含 FS 相对路径）。auto-fill sortOrder。
  async function createDocument(document: {
    id: string;
    folder_id: string;
    file_name: string;
    document_dir: string;
    source_path: string;
    markdown_path: string;
    source_extension?: string;
    status?: string;
    progress?: number;
    message?: string;
    parser_label?: string;
  }): Promise<DocumentDto> {
    const timestamp = now();
    const max = await prisma.knowledgeDocument.aggregate({
      where: { folderId: document.folder_id },
      _max: { sortOrder: true },
    });
    const sortOrder = (max._max.sortOrder ?? -1) + 1;
    const row = await prisma.knowledgeDocument.create({
      data: {
        documentId: document.id,
        folderId: document.folder_id,
        fileName: document.file_name,
        documentDir: document.document_dir,
        sourcePath: document.source_path,
        markdownPath: document.markdown_path,
        sourceExtension: document.source_extension ?? null,
        status: normalizeStatus(document.status ?? 'pending'),
        progress: Number(document.progress ?? 0),
        message: document.message ?? '等待处理',
        parserLabel: document.parser_label ?? null,
        sortOrder,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    return documentFromRow(row);
  }

  // ---- markdown 元数据 + 读 ----

  async function updateMarkdownMetadata(documentId: string, markdown: string): Promise<void> {
    const hash = crypto.createHash('sha256').update(String(markdown || ''), 'utf8').digest('hex');
    await prisma.knowledgeDocument.update({
      where: { documentId },
      data: {
        markdownHash: hash,
        markdownChars: getContentCharCount(markdown),
        updatedAt: now(),
      },
    });
  }

  async function readMarkdownByPath(markdownPath: string): Promise<string> {
    try {
      return await fs.readFile(kb.resolve(markdownPath), 'utf-8');
    } catch {
      return '';
    }
  }

  // ---- 步骤模型（knowledge_document_steps）----

  async function getDocumentStep(documentId: string, stepKey: string) {
    const row = await prisma.knowledgeDocumentStep.findUnique({
      where: { documentId_stepKey: { documentId, stepKey } },
    });
    if (!row) return null;
    return {
      status: row.status,
      result: row.resultJson as unknown,
      error: row.error,
      updatedAt: row.updatedAt,
    };
  }

  async function saveDocumentStep(
    documentId: string,
    stepKey: string,
    patch: { status?: string; result?: unknown; error?: string },
  ): Promise<void> {
    const timestamp = now();
    const existing = await prisma.knowledgeDocumentStep.findUnique({
      where: { documentId_stepKey: { documentId, stepKey } },
    });
    const status = patch.status ?? 'idle';
    const startedAt = existing?.startedAt ?? (status === 'running' ? timestamp : existing?.startedAt ?? null);
    const completedAt = status === 'success' || status === 'error' ? timestamp : existing?.completedAt ?? null;
    await prisma.knowledgeDocumentStep.upsert({
      where: { documentId_stepKey: { documentId, stepKey } },
      create: {
        documentId,
        stepKey,
        status,
        resultJson: (patch.result ?? null) as never,
        error: patch.error ?? null,
        startedAt,
        completedAt,
        updatedAt: timestamp,
      },
      update: {
        status,
        resultJson: (patch.result ?? null) as never,
        error: patch.error ?? null,
        startedAt,
        completedAt,
        updatedAt: timestamp,
      },
    });
  }

  // 删除该步骤及之后所有步骤，并按归属分组级联清理产物表 + 重置计数器（逐字移植自桌面同名函数，
  // desktop 948-991：markdown 归 convert_markdown、blocks 归 build_blocks、candidates 归 merge_candidates、
  // match_batches 归 match_batches、items/reports/discarded 归 save_result）。错误旧实现把 markdown_chars
  // 在清 build_blocks 时一起抹掉，导致 retry 后 markdown 元数据丢失——已对齐桌面分组。
  async function clearDocumentProcessingFromStep(documentId: string, stepKey: string): Promise<void> {
    const fromIndex = stepKeys.indexOf(stepKey);
    if (fromIndex < 0) return;
    const tailKeys = stepKeys.slice(fromIndex);
    await prisma.knowledgeDocumentStep.deleteMany({
      where: { documentId, stepKey: { in: tailKeys } },
    });

    if (fromIndex <= stepKeys.indexOf('convert_markdown')) {
      await prisma.knowledgeDocument.update({
        where: { documentId },
        data: { markdownHash: null, markdownChars: 0, parserLabel: null, updatedAt: now() } as never,
      });
    }
    if (fromIndex <= stepKeys.indexOf('build_blocks')) {
      await prisma.knowledgeBlock.deleteMany({ where: { documentId } });
    }
    if (fromIndex <= stepKeys.indexOf('merge_candidates')) {
      await prisma.knowledgeCandidateItem.deleteMany({ where: { documentId } });
    }
    if (fromIndex <= stepKeys.indexOf('match_batches')) {
      await prisma.knowledgeMatchBatch.deleteMany({ where: { documentId } });
    }
    if (fromIndex <= stepKeys.indexOf('save_result')) {
      await prisma.knowledgeItemBlock.deleteMany({ where: { documentId } });
      await prisma.knowledgeItem.deleteMany({ where: { documentId } });
      await prisma.knowledgeDiscardedGroup.deleteMany({ where: { documentId } });
      await prisma.knowledgeReport.deleteMany({ where: { documentId } });
    }

    const resetFields: Record<string, unknown> = { error: null, lastBatchSize: null };
    if (fromIndex <= stepKeys.indexOf('build_blocks')) {
      resetFields.blockCount = 0;
      resetFields.filteredBlockCount = 0;
    }
    if (fromIndex <= stepKeys.indexOf('merge_candidates')) {
      resetFields.candidateItemCount = 0;
    }
    if (fromIndex <= stepKeys.indexOf('save_result')) {
      resetFields.itemCount = 0;
      resetFields.discardedBlockCount = 0;
      resetFields.systemDiscardedAfterRetryCount = 0;
    }
    await prisma.knowledgeDocument.update({
      where: { documentId },
      data: { ...resetFields, updatedAt: now() } as never,
    });
  }

  // ---- blocks ----

  async function saveBlocks(
    documentId: string,
    blocks: Array<{ id: string; type: string; heading_path?: string[]; content: string }>,
    filteredBlocks: Array<{ id: string; type: string; heading_path?: string[]; content: string; reason?: string }>,
  ): Promise<{ blockCount: number; filteredBlockCount: number }> {
    const timestamp = now();
    await prisma.knowledgeBlock.deleteMany({ where: { documentId } });
    const all = [
      ...blocks.map((b, i) => ({
        documentId,
        blockId: b.id,
        type: b.type,
        headingPathJson: (b.heading_path ?? []) as never,
        content: b.content,
        contentChars: getContentCharCount(b.content),
        isFiltered: 0,
        filterReason: null,
        sortOrder: i,
      })),
      ...filteredBlocks.map((b, i) => ({
        documentId,
        blockId: b.id,
        type: b.type,
        headingPathJson: (b.heading_path ?? []) as never,
        content: b.content,
        contentChars: getContentCharCount(b.content),
        isFiltered: 1,
        filterReason: b.reason ?? null,
        sortOrder: i,
      })),
    ];
    if (all.length) {
      await prisma.knowledgeBlock.createMany({ data: all as never });
    }
    await prisma.knowledgeDocument.update({
      where: { documentId },
      data: { blockCount: blocks.length, filteredBlockCount: filteredBlocks.length, updatedAt: timestamp },
    });
    return { blockCount: blocks.length, filteredBlockCount: filteredBlocks.length };
  }

  async function readBlocks(documentId: string) {
    return prisma.knowledgeBlock.findMany({
      where: { documentId, isFiltered: 0 },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  async function readFilteredBlocks(documentId: string) {
    return prisma.knowledgeBlock.findMany({
      where: { documentId, isFiltered: 1 },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  // 把非 success 且无活跃处理的文档标记为 error（桌面在每次 list/migrate 时跑）。
  // activeDocumentIds 默认取 registry（extraction.ts 在跑的 id），避免把正在 extracting/matching
  // 的文档误标 error。允许显式覆盖以便测试。
  async function recoverInterruptedDocuments(activeDocumentIds: string[] = getActiveExtractionIds()): Promise<DocumentDto[]> {
    const activeIds = new Set((Array.isArray(activeDocumentIds) ? activeDocumentIds : []).map((id) => String(id || '').trim()).filter(Boolean));
    const nonSuccess = await prisma.knowledgeDocument.findMany({
      where: { status: { not: 'success' } },
      select: { documentId: true, status: true },
    });
    if (!nonSuccess.length) return [];
    const ids = nonSuccess.map((d) => d.documentId);
    const stepRows = await prisma.knowledgeDocumentStep.findMany({
      where: { documentId: { in: ids } },
      select: { documentId: true },
    });
    const hasSteps = new Set(stepRows.map((s) => s.documentId));
    const interruptedStatuses = new Set(['pending', 'copying', 'converting', 'extracting', 'matching', 'recovering', 'analyzing', 'saving']);
    const legacyIds: string[] = [];
    const interruptedIds: string[] = [];
    for (const doc of nonSuccess) {
      if (activeIds.has(doc.documentId)) continue;
      if (hasSteps.has(doc.documentId)) {
        if (interruptedStatuses.has(doc.status)) interruptedIds.push(doc.documentId);
      } else {
        legacyIds.push(doc.documentId);
      }
    }
    if (!legacyIds.length && !interruptedIds.length) return [];
    const timestamp = now();
    const legacyMessage = '上次任务未完成，请点击重试重新解析';
    const interruptedMessage = '上次任务中断，请点击重试继续处理';
    if (legacyIds.length) {
      await prisma.knowledgeDocument.updateMany({
        where: { documentId: { in: legacyIds } },
        data: { status: 'error', progress: 0, message: legacyMessage, error: legacyMessage, updatedAt: timestamp },
      });
    }
    if (interruptedIds.length) {
      await prisma.knowledgeDocument.updateMany({
        where: { documentId: { in: interruptedIds } },
        data: { status: 'error', message: interruptedMessage, error: interruptedMessage, updatedAt: timestamp },
      });
    }
    const recovered = await prisma.knowledgeDocument.findMany({
      where: { documentId: { in: [...new Set([...legacyIds, ...interruptedIds])] } },
    });
    return recovered.map(documentFromRow);
  }

  async function list(): Promise<{ folders: FolderDto[]; documents: DocumentDto[] }> {
    await recoverInterruptedDocuments();
    const folderRows = await prisma.knowledgeFolder.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const folders = folderRows.map(folderFromRow);
    const folderOrder = new Map(folderRows.map((f, i) => [f.folderId, i]));
    // 桌面 ORDER BY COALESCE(f.sort_order,0), folder_id, sort_order, created_at DESC, document_id
    const docRows = await prisma.knowledgeDocument.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }, { documentId: 'asc' }],
    });
    const documents = docRows
      .map(documentFromRow)
      .sort((a, b) => {
        const fa = folderOrder.get(a.folder_id) ?? 0;
        const fb = folderOrder.get(b.folder_id) ?? 0;
        if (fa !== fb) return fa - fb;
        if (a.folder_id !== b.folder_id) return a.folder_id < b.folder_id ? -1 : 1;
        return 0;
      });
    return { folders, documents };
  }

  async function createFolder(name: unknown): Promise<FolderDto> {
    const timestamp = now();
    const max = await prisma.knowledgeFolder.aggregate({ _max: { sortOrder: true } });
    const sortOrder = (max._max.sortOrder ?? -1) + 1;
    const folderId = createId('folder');
    const row = await prisma.knowledgeFolder.create({
      data: { folderId, name: safeName(name), sortOrder, createdAt: timestamp, updatedAt: timestamp },
    });
    return folderFromRow(row);
  }

  async function renameFolder(folderId: string, name: unknown): Promise<FolderDto> {
    const existing = await prisma.knowledgeFolder.findUnique({ where: { folderId } });
    if (!existing) throw new Error('知识库文件夹不存在');
    const row = await prisma.knowledgeFolder.update({
      where: { folderId },
      data: { name: safeName(name), updatedAt: now() },
    });
    return folderFromRow(row);
  }

  async function reorderFolder(
    draggedFolderId: string,
    targetFolderId: string,
    position: unknown,
  ): Promise<{ success: true; message: string; index: { folders: FolderDto[]; documents: DocumentDto[] } }> {
    const normalizedPosition = normalizeDropPosition(position);
    const rows = await prisma.knowledgeFolder.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { folderId: true },
    });
    const folderIds = rows.map((r) => r.folderId);
    if (!folderIds.includes(draggedFolderId) || !folderIds.includes(targetFolderId)) {
      throw new Error('知识库文件夹不存在');
    }
    if (draggedFolderId === targetFolderId) {
      return { success: true, message: '文件夹排序已保存', index: await list() };
    }
    const next = reorderIds(folderIds, draggedFolderId, targetFolderId, normalizedPosition);
    const timestamp = now();
    await prisma.$transaction(
      next.map((id, order) =>
        prisma.knowledgeFolder.update({ where: { folderId: id }, data: { sortOrder: order, updatedAt: timestamp } }),
      ),
    );
    return { success: true, message: '文件夹排序已保存', index: await list() };
  }

  async function deleteFolder(folderId: string): Promise<{ success: true; message: string }> {
    const folder = await prisma.knowledgeFolder.findUnique({ where: { folderId } });
    if (!folder) throw new Error('知识库文件夹不存在');
    const childDocs = await prisma.knowledgeDocument.findMany({
      where: { folderId },
      select: { documentId: true, fileName: true },
    });
    await prisma.$transaction(async (client) => {
      for (const doc of childDocs) {
        await cascadeDeleteDocument(doc.documentId, client);
      }
      await client.knowledgeFolder.delete({ where: { folderId } });
    });
    return { success: true, message: `已删除文件夹“${folder.name}”及 ${childDocs.length} 个文档` };
  }

  async function deleteDocument(documentId: string): Promise<{ success: true; message: string }> {
    const row = await getDocumentRow(documentId);
    // FS 级联：删整个 document_dir（source<ext>/content.md/...，桌面同名行为）。
    await fs.rm(kb.resolve(row.documentDir), { recursive: true, force: true }).catch(() => undefined);
    await prisma.$transaction(async (client) => {
      await cascadeDeleteDocument(documentId, client);
    });
    return { success: true, message: `已删除文档“${row.fileName}”` };
  }

  async function moveDocument(
    documentId: string,
    targetFolderId: string,
    targetDocumentId: string | null | undefined,
    position: unknown,
  ): Promise<{ success: true; message: string; index: { folders: FolderDto[]; documents: DocumentDto[] }; document: DocumentDto }> {
    const document = await getDocumentRow(documentId);
    // 桌面 FS 期状态守卫：仅允许已完成三态被移动。
    if (!['ready_for_matching', 'success', 'error'].includes(document.status)) {
      throw new Error('该文档正在处理中，请完成后再移动');
    }
    const targetFolder = await prisma.knowledgeFolder.findUnique({ where: { folderId: targetFolderId } });
    if (!targetFolder) throw new Error('目标知识库文件夹不存在');
    const normalizedPosition = normalizeDropPosition(position);
    const targetDocId = targetDocumentId ? String(targetDocumentId) : '';
    if (targetDocId) {
      const targetDoc = await prisma.knowledgeDocument.findUnique({ where: { documentId: targetDocId } });
      if (!targetDoc) throw new Error('目标文档不存在');
      if (targetDoc.folderId !== targetFolderId) throw new Error('目标文档不在目标文件夹中');
    }
    const timestamp = now();
    const crossFolder = document.folderId !== targetFolderId;

    // FS rebase：跨文件夹时把 document_dir 整体 rename 到目标文件夹，并重算 source/markdown 相对路径
    // （移植自桌面 rebaseDocumentRelativePath）。源目录不存在（未上传）时仅改 DB 路径。
    let rebasedPaths: { documentDir: string; sourcePath: string; markdownPath: string } | null = null;
    if (crossFolder) {
      const norm = (v: string) => String(v || '').replace(/\\/g, '/');
      const newDocumentDir = norm(`folders/${targetFolderId}/documents/${documentId}`);
      const rebase = (value: string) => {
        const normalized = norm(value);
        const oldPrefix = norm(document.documentDir).replace(/\/+$/, '');
        const nextPrefix = norm(newDocumentDir).replace(/\/+$/, '');
        if (normalized === oldPrefix) return nextPrefix;
        if (normalized.startsWith(`${oldPrefix}/`)) return `${nextPrefix}${normalized.slice(oldPrefix.length)}`;
        return norm(path.join(nextPrefix, path.basename(normalized)));
      };
      rebasedPaths = {
        documentDir: newDocumentDir,
        sourcePath: rebase(document.sourcePath),
        markdownPath: rebase(document.markdownPath),
      };
      const oldAbsDir = kb.resolve(document.documentDir);
      const newAbsDir = kb.resolve(newDocumentDir);
      await fs.mkdir(path.dirname(newAbsDir), { recursive: true });
      if (oldAbsDir !== newAbsDir) {
        try {
          await fs.rename(oldAbsDir, newAbsDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }

    try {
      await prisma.$transaction(async (client) => {
        // 收集目标文件夹内（除自身外）现有顺序，计算插入位
        const targetRows = await client.knowledgeDocument.findMany({
          where: { folderId: targetFolderId, documentId: { not: documentId } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }, { documentId: 'asc' }],
          select: { documentId: true },
        });
        const targetIds = targetRows.map((r) => r.documentId);
        const insertIndex = targetDocId
          ? Math.max(0, targetIds.indexOf(targetDocId)) + (normalizedPosition === 'after' ? 1 : 0)
          : targetIds.length;
        const nextTargetIds = [...targetIds];
        nextTargetIds.splice(insertIndex, 0, documentId);

        // 跨文件夹移动：重排源文件夹剩余文档
        if (crossFolder) {
          const sourceRows = await client.knowledgeDocument.findMany({
            where: { folderId: document.folderId, documentId: { not: documentId } },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }, { documentId: 'asc' }],
            select: { documentId: true },
          });
          const sourceIds = sourceRows.map((r) => r.documentId);
          for (let i = 0; i < sourceIds.length; i++) {
            await client.knowledgeDocument.update({
              where: { documentId: sourceIds[i] },
              data: { sortOrder: i, updatedAt: timestamp },
            });
          }
        }
        // 移动文档本体（跨文件夹时同步落 rebased FS 路径）
        await client.knowledgeDocument.update({
          where: { documentId },
          data: {
            folderId: targetFolderId,
            sortOrder: insertIndex,
            ...(rebasedPaths ?? {}),
            updatedAt: timestamp,
          },
        });
        // 重排目标文件夹
        for (let i = 0; i < nextTargetIds.length; i++) {
          await client.knowledgeDocument.update({
            where: { documentId: nextTargetIds[i] },
            data: { sortOrder: i, updatedAt: timestamp },
          });
        }
      });
    } catch (error) {
      // DB 失败：尽力回滚 FS rename。
      if (rebasedPaths) {
        await fs.rename(kb.resolve(rebasedPaths.documentDir), kb.resolve(document.documentDir)).catch(() => undefined);
      }
      throw error;
    }
    return { success: true, message: '文档已移动', index: await list(), document: await getDocumentRaw(documentId) };
  }

  async function readMarkdown(documentId: string): Promise<string> {
    const row = await getDocumentRow(documentId);
    return readMarkdownByPath(row.markdownPath);
  }

  async function readItems(documentId: string): Promise<Array<{ id: string; title: string; resume: string; content: string; source_block_ids: string[]; source_file?: string }>> {
    await getDocumentRaw(documentId);
    const blockRows = await prisma.knowledgeItemBlock.findMany({
      where: { documentId },
      orderBy: [{ itemId: 'asc' }, { sortOrder: 'asc' }],
      select: { itemId: true, blockId: true },
    });
    const blocksByItem = new Map<string, string[]>();
    for (const row of blockRows) {
      const list = blocksByItem.get(row.itemId) || [];
      list.push(row.blockId);
      blocksByItem.set(row.itemId, list);
    }
    const items = await prisma.knowledgeItem.findMany({
      where: { documentId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return items.map((row) => {
      const dto: { id: string; title: string; resume: string; content: string; source_block_ids: string[]; source_file?: string } = {
        id: row.itemId,
        title: row.title,
        resume: row.resume,
        content: row.content,
        source_block_ids: blocksByItem.get(row.itemId) || [],
      };
      if (row.sourceFile) dto.source_file = row.sourceFile;
      return dto;
    });
  }

  async function readAnalysis(documentId: string): Promise<{
    document: DocumentDto;
    block_count: number;
    filtered_blocks_count: number;
    markdown_chars: number;
    kept_block_chars: number;
    covered_unique_content_chars: number;
    coverage_rate_vs_markdown: number;
    candidate_items: Array<{ id: string; title: string; summary: string }>;
    report: Record<string, number | string> | null;
    discarded: Array<{ block_ids: unknown[]; reason: string }>;
    system_discarded_after_retry: Array<{ block_ids: unknown[]; reason: string; source: string }>;
    debug_log_path: string;
  }> {
    const document = await getDocumentRaw(documentId);
    const markdown = await readMarkdown(documentId);
    const blockRows = await prisma.knowledgeBlock.findMany({ where: { documentId, isFiltered: 0 }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    const filteredRows = await prisma.knowledgeBlock.findMany({ where: { documentId, isFiltered: 1 }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    const candidateRows = await prisma.knowledgeCandidateItem.findMany({ where: { documentId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    const items = await readItems(documentId);
    const charRows = await prisma.knowledgeBlock.findMany({
      where: { documentId, isFiltered: 0 },
      select: { blockId: true, contentChars: true },
    });
    const charsByBlock = new Map(charRows.map((r) => [r.blockId, Number(r.contentChars || 0)]));
    const covered = new Set<string>();
    items.forEach((item) => (item.source_block_ids || []).forEach((id) => covered.add(id)));
    let coveredUniqueContentChars = 0;
    covered.forEach((id) => (coveredUniqueContentChars += Number(charsByBlock.get(id) || 0)));
    const reportRow = await prisma.knowledgeReport.findUnique({ where: { documentId } });
    const report = reportRow
      ? {
          total_blocks: Number(reportRow.totalBlocks || 0),
          filtered_blocks_count: Number(reportRow.filteredBlocksCount || 0),
          candidate_items_count: Number(reportRow.candidateItemsCount || 0),
          final_items_count: Number(reportRow.finalItemsCount || 0),
          matched_blocks_count: Number(reportRow.matchedBlocksCount || 0),
          discarded_blocks_count: Number(reportRow.discardedBlocksCount || 0),
          system_discarded_after_retry_count: Number(reportRow.systemDiscardedAfterRetryCount || 0),
          new_items_from_recovery_count: Number(reportRow.newItemsFromRecoveryCount || 0),
          recovery_attempt_count: Number(reportRow.recoveryAttemptCount || 0),
          batch_size: Number(reportRow.batchSize || 20),
          coverage_rate: Number(reportRow.coverageRate || 0),
          matched_rate: Number(reportRow.matchedRate || 0),
          created_at: reportRow.createdAt,
        }
      : null;
    const discardedRows = await prisma.knowledgeDiscardedGroup.findMany({ where: { documentId }, orderBy: { sortOrder: 'asc' } });
    const markdownChars = getContentCharCount(markdown);
    const keptBlockChars = charRows.reduce((sum, r) => sum + Number(r.contentChars || 0), 0);
    return {
      document,
      block_count: blockRows.length,
      filtered_blocks_count: filteredRows.length,
      markdown_chars: markdownChars,
      kept_block_chars: keptBlockChars,
      covered_unique_content_chars: coveredUniqueContentChars,
      coverage_rate_vs_markdown: markdownChars ? Number((coveredUniqueContentChars / markdownChars).toFixed(4)) : 0,
      candidate_items: candidateRows.map((r) => ({ id: r.itemId, title: r.title, summary: r.summary })),
      report,
      discarded: discardedRows
        .filter((r) => r.source === 'ai')
        .map((r) => ({ block_ids: readJson(r.blockIdsJson, []), reason: r.reason })),
      system_discarded_after_retry: discardedRows
        .filter((r) => r.source !== 'ai')
        .map((r) => ({ block_ids: readJson(r.blockIdsJson, []), reason: r.reason, source: r.source })),
      debug_log_path: '',
    };
  }

  // technical_plan 的参考文档选择消费此方法（跨域读取，不直接 IPC 暴露）。
  async function getOutlineReferences(documentIds: unknown): Promise<{ items: Array<{ id: string; title: string; resume: string }> }> {
    const ids = Array.isArray(documentIds) ? documentIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!ids.length) return { items: [] };
    const successDocs = await prisma.knowledgeDocument.findMany({
      where: { documentId: { in: ids }, status: 'success' },
      select: { documentId: true },
    });
    const seen = new Set<string>();
    const items: Array<{ id: string; title: string; resume: string }> = [];
    for (const doc of successDocs) {
      const docItems = await readItems(doc.documentId);
      for (const item of docItems) {
        const itemId = String(item?.id || '').trim();
        const title = String(item?.title || '').trim();
        const resume = String(item?.resume || '').trim();
        if (!itemId || !title || !resume) continue;
        const referenceId = `${doc.documentId}::${itemId}`;
        if (seen.has(referenceId)) continue;
        seen.add(referenceId);
        items.push({ id: referenceId, title, resume });
      }
    }
    return { items };
  }

  // Web 绿地部署无 legacy index.json，恒不需迁移。保留 meta 行查询以维持契约字段。
  async function getMigrationStatus(): Promise<{
    needsMigration: false;
    legacyFolderCount: 0;
    legacyDocumentCount: 0;
    legacyCompletedDocumentCount: 0;
    legacySkippedDocumentCount: 0;
    migrationCompleted: boolean;
    cleanupPending: false;
  }> {
    await recoverInterruptedDocuments();
    const meta = await prisma.knowledgeMigrationMeta.findUnique({ where: { id: 1 } });
    return {
      needsMigration: false,
      legacyFolderCount: 0,
      legacyDocumentCount: 0,
      legacyCompletedDocumentCount: 0,
      legacySkippedDocumentCount: 0,
      migrationCompleted: meta?.status === 'success',
      cleanupPending: false,
    };
  }

  // ---- 候选条目（knowledge_candidate_items）----

  async function saveCandidateItems(
    documentId: string,
    items: Array<{ id: string; title: string; summary: string; source?: string }>,
  ): Promise<void> {
    const timestamp = now();
    await prisma.knowledgeCandidateItem.deleteMany({ where: { documentId } });
    const rows = items.map((item, i) => ({
      documentId,
      itemId: item.id,
      title: item.title,
      summary: item.summary,
      source: item.source ?? null,
      sortOrder: i,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    if (rows.length) {
      await prisma.knowledgeCandidateItem.createMany({ data: rows as never });
    }
    await prisma.knowledgeDocument.update({
      where: { documentId },
      data: { candidateItemCount: items.length, updatedAt: timestamp },
    });
  }

  async function readCandidateItems(documentId: string): Promise<Array<{ id: string; title: string; summary: string; source?: string }>> {
    const rows = await prisma.knowledgeCandidateItem.findMany({
      where: { documentId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => {
      const item: { id: string; title: string; summary: string; source?: string } = {
        id: r.itemId,
        title: r.title,
        summary: r.summary,
      };
      if (r.source) item.source = r.source;
      return item;
    });
  }

  // ---- 匹配批次（knowledge_match_batches，复合主键 documentId+batchIndex）----

  async function saveMatchBatch(
    documentId: string,
    batchIndex: number,
    patch: { status: string; itemIds?: string[]; matches?: unknown[] | null; error?: string | null },
  ): Promise<void> {
    const timestamp = now();
    const existing = await prisma.knowledgeMatchBatch.findUnique({
      where: { documentId_batchIndex: { documentId, batchIndex } },
    });
    const status = patch.status ?? 'idle';
    const startedAt = existing?.startedAt ?? (status === 'running' ? timestamp : existing?.startedAt ?? null);
    const completedAt = status === 'success' || status === 'error' ? timestamp : existing?.completedAt ?? null;
    const itemIds = patch.itemIds !== undefined ? patch.itemIds : (Array.isArray(existing?.itemIdsJson) ? (existing?.itemIdsJson as string[]) : []);
    const matches = patch.matches !== undefined ? patch.matches : (existing?.matchesJson ?? null);
    await prisma.knowledgeMatchBatch.upsert({
      where: { documentId_batchIndex: { documentId, batchIndex } },
      create: {
        documentId,
        batchIndex,
        status,
        itemIdsJson: itemIds as never,
        matchesJson: (matches ?? null) as never,
        error: patch.error ?? null,
        startedAt,
        completedAt,
        updatedAt: timestamp,
      },
      update: {
        status,
        itemIdsJson: itemIds as never,
        matchesJson: (matches ?? null) as never,
        error: patch.error ?? null,
        startedAt,
        completedAt,
        updatedAt: timestamp,
      },
    });
  }

  async function getMatchBatch(
    documentId: string,
    batchIndex: number,
  ): Promise<{ status: string; itemIds: string[]; matches: unknown[] | null; error: string | null } | null> {
    const row = await prisma.knowledgeMatchBatch.findUnique({
      where: { documentId_batchIndex: { documentId, batchIndex } },
    });
    if (!row) return null;
    return {
      status: row.status,
      itemIds: Array.isArray(row.itemIdsJson) ? (row.itemIdsJson as string[]) : [],
      matches: Array.isArray(row.matchesJson) ? (row.matchesJson as unknown[]) : null,
      error: row.error,
    };
  }

  // ---- 最终落库（items + item_blocks + discarded_groups + reports，事务）----
  // 移植自桌面 knowledgeBaseStore.saveMatchResult。AI 决定的 discarded 标 source='ai'
  //（readAnalysis 据此归类）；system 兜底丢弃标 source='system'。
  async function saveMatchResult(
    documentId: string,
    params: {
      candidateItems: Array<{ id: string; title: string; summary: string }>;
      matchResult: {
        discarded: Array<{ block_ids: string[]; reason: string; source?: string }>;
        system_discarded_after_retry: Array<{ block_ids: string[]; reason: string; source?: string }>;
      };
      report: Report;
      finalItems: Array<{ id: string; title: string; resume: string; content: string; source_file: string; source_block_ids: string[] }>;
    },
  ): Promise<void> {
    const timestamp = now();
    await prisma.$transaction(async (client) => {
      await client.knowledgeItemBlock.deleteMany({ where: { documentId } });
      await client.knowledgeItem.deleteMany({ where: { documentId } });
      await client.knowledgeDiscardedGroup.deleteMany({ where: { documentId } });
      await client.knowledgeReport.deleteMany({ where: { documentId } });

      const itemBlockRows: Array<{ documentId: string; itemId: string; blockId: string; sortOrder: number }> = [];
      params.finalItems.forEach((item) => {
        (item.source_block_ids || []).forEach((blockId, i) => {
          itemBlockRows.push({ documentId, itemId: item.id, blockId, sortOrder: i });
        });
      });
      if (itemBlockRows.length) {
        await client.knowledgeItemBlock.createMany({ data: itemBlockRows });
      }

      const itemRows = params.finalItems.map((item, i) => ({
        documentId,
        itemId: item.id,
        title: item.title,
        resume: item.resume,
        content: item.content,
        sourceFile: item.source_file ?? null,
        contentChars: getContentCharCount(item.content),
        sortOrder: i,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      if (itemRows.length) {
        await client.knowledgeItem.createMany({ data: itemRows });
      }

      const discardedRows = [
        ...params.matchResult.discarded.map((d) => ({ ...d, source: d.source || 'ai' })),
        ...params.matchResult.system_discarded_after_retry.map((d) => ({ ...d, source: d.source || 'system' })),
      ].map((d, i) => ({
        documentId,
        source: d.source,
        reason: d.reason || '',
        blockIdsJson: (d.block_ids || []) as never,
        sortOrder: i,
      }));
      if (discardedRows.length) {
        await client.knowledgeDiscardedGroup.createMany({ data: discardedRows as never });
      }

      const r = params.report;
      const reportData = {
        totalBlocks: Number(r.total_blocks || 0),
        filteredBlocksCount: Number(r.filtered_blocks_count || 0),
        candidateItemsCount: Number(r.candidate_items_count || 0),
        finalItemsCount: Number(r.final_items_count || 0),
        matchedBlocksCount: Number(r.matched_blocks_count || 0),
        discardedBlocksCount: Number(r.discarded_blocks_count || 0),
        systemDiscardedAfterRetryCount: Number(r.system_discarded_after_retry_count || 0),
        newItemsFromRecoveryCount: Number(r.new_items_from_recovery_count || 0),
        recoveryAttemptCount: Number(r.recovery_attempt_count || 0),
        batchSize: Number(r.batch_size || 20),
        coverageRate: Number(r.coverage_rate || 0),
        matchedRate: Number(r.matched_rate || 0),
        createdAt: timestamp,
      };
      await client.knowledgeReport.upsert({
        where: { documentId },
        create: { documentId, ...reportData },
        update: reportData,
      });
    });
  }

  return {
    list,
    createFolder,
    renameFolder,
    reorderFolder,
    deleteFolder,
    deleteDocument,
    moveDocument,
    getDocument: getDocumentRaw,
    getDocumentRow,
    updateDocument,
    createDocument,
    updateMarkdownMetadata,
    readMarkdown,
    readMarkdownByPath,
    getDocumentStep,
    saveDocumentStep,
    clearDocumentProcessingFromStep,
    saveBlocks,
    readBlocks,
    readFilteredBlocks,
    saveCandidateItems,
    readCandidateItems,
    saveMatchBatch,
    getMatchBatch,
    saveMatchResult,
    readItems,
    readAnalysis,
    getOutlineReferences,
    getMigrationStatus,
    recoverInterruptedDocuments,
  };
}

export type KnowledgeBaseStore = ReturnType<typeof createKnowledgeBaseStore>;

// Prisma.JsonValue 在 report 等处用不到（report 是标量拼装）；blockIdsJson 已用 readJson 兜底。
// 保留 Prisma 命名空间引用以便 $transaction 类型推断。
void Prisma;
