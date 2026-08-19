// 废标项检查命名空间 store：移植自 client/electron/services/rejectionCheckStore.cjs（914 行）。
// 全纯 DB 状态读写（better-sqlite3 同步 → Prisma 异步），按 projectId 隔离。
// 任务运行器（rejectionCheckTask.cjs 的 runRejectionItemsExtractionTask/runRejectionCheckTask，
// 含 LLM 抽取 + rejection/typo/logic 三路检查流水线）属 P6 任务引擎，不在本 store。
//
// DTO 混合大小写：顶层 workspace + 嵌套域对象全 camelCase（tenderDocument/bidDocuments/
// invalidBidAndRejectionItems/rejectionCheckResult.../findings），唯一例外是 background-task
// 子对象全 snake_case（task_id/type/status/progress/logs/started_at/updated_at/error/stats）。
// 详见 client/src/features/rejection-check/types.ts:48-64。
//
// 多用户隔离要点：原桌面 8 表里 4 张用自然键做 PK（documentId / findingId），跨用户必然碰撞
// （每用户的招标文档 documentId 都是 'tender'）。已改为复合 PK @@id([projectId, 自然键])，
// 迁移 rejection_check_composite_pks；clearFindingRows/clearCheckResults 等桌面无条件 DELETE
// 全部改成 deleteMany({where:{projectId}})。
//
// FS 纠缠（P4-2 已接真）：writeDocumentMarkdown/readDocumentMarkdown/removeMarkdownForRow
// 走按用户工作区磁盘（rejection-check/{tender.md,tenders/,bids/}）。markdownPath 列存相对
// workspace 的路径串，读时 paths.resolve(rel) 还原绝对路径。documentFromRow 同步读 FS 填 content
// （对齐桌面 line 302：渲染器期望文档 content 内联在 state 里，无独立 read-markdown 通道）。
// importDocument/importTenderFromTechnicalPlan 见下方（multipart + 跨域读 technical_plan）。
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createWorkspacePaths, type WorkspacePaths } from '../document/paths';
import type { ParsedImport } from '../document/parser';
import { createTechnicalPlanStore } from '../technical-plan/store';

type Tx = Prisma.TransactionClient;

const initialState = {
  tenderDocument: null,
  tenderDocuments: [],
  bidDocuments: [],
  activeDocumentTab: 'tender',
  step: 'documents',
  activeResultTab: 'analysis',
  activeCheckResultTab: 'rejection',
  invalidBidAndRejectionItems: { status: 'idle', content: '' },
  customCheckItems: '',
  checkOptions: { rejectionCheck: true, typoCheck: true, logicCheck: true },
  rejectionCheckResult: { status: 'idle', findings: [] },
  typoCheckResult: { status: 'idle', findings: [] },
  logicCheckResult: { status: 'idle', findings: [] },
  extractionTask: undefined,
  checkTask: undefined,
};

const taskFieldTypes: Record<string, string> = {
  extractionTask: 'rejection-items-extraction',
  checkTask: 'rejection-check-run',
};

const taskTypeFields: Record<string, string> = Object.fromEntries(
  Object.entries(taskFieldTypes).map(([field, type]) => [type, field]),
);

const resultFieldTypes: Record<string, string> = {
  rejectionCheckResult: 'rejection',
  typoCheckResult: 'typo',
  logicCheckResult: 'logic',
};

const tenderDocumentId = 'tender';

function now(): string {
  return new Date().toISOString();
}

function hasOwn(value: unknown, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function stableHash(content: unknown): string {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function normalizeStatus(value: unknown, allowed: string[], fallback: string): string {
  return allowed.includes(value as string) ? (value as string) : fallback;
}

function normalizeStep(value: unknown): string {
  return value === 'items' || value === 'results' ? (value as string) : 'documents';
}

function normalizeDocumentRole(value: unknown): 'tender' | 'bid' {
  return value === 'bid' ? 'bid' : 'tender';
}

function normalizeDocumentTab(value: unknown): string {
  const tab = String(value || '').trim();
  return tab || 'tender';
}

function normalizeResultTab(value: unknown): string {
  return value === 'custom' ? 'custom' : 'analysis';
}

function normalizeCheckResultTab(value: unknown): string {
  return ['rejection', 'typo', 'logic'].includes(value as string) ? (value as string) : 'rejection';
}

function normalizeCheckOptions(options: unknown): { rejectionCheck: boolean; typoCheck: boolean; logicCheck: boolean } {
  const o = (options || {}) as Record<string, unknown>;
  return {
    rejectionCheck: true,
    typoCheck: o.typoCheck !== false,
    logicCheck: o.logicCheck !== false,
  };
}

export function stripTripleQuoteWrapper(content: unknown): string {
  const trimmed = String(content || '').trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return String(content || '');
}

function createBidDocumentId(fileName: unknown, markdown: unknown): string {
  const hash = stableHash(`${String(fileName || '')}\n${String(markdown || '')}`).slice(0, 16);
  return `bid-${hash}`;
}

function createTenderSourceDocumentId(fileName: unknown, markdown: unknown, index: number): string {
  const hash = stableHash(`${String(fileName || '')}\n${String(markdown || '')}`).slice(0, 12);
  return `tender-${String(index + 1).padStart(2, '0')}-${hash}`;
}

function combineTenderMarkdown(documents: unknown): string {
  return (Array.isArray(documents) ? documents : [])
    .map((document) => {
      const d = document as { file_content?: string; content?: string; markdown?: string };
      return String(d?.file_content || d?.content || d?.markdown || '').trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

function getDocumentMarkdownRelativePath(role: string, documentId: string): string {
  if (role === 'bid') {
    const safeDocumentId = String(documentId || 'bid').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `rejection-check/bids/${safeDocumentId}.md`;
  }
  if (String(documentId || '') && String(documentId) !== tenderDocumentId) {
    const safeDocumentId = String(documentId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `rejection-check/tenders/${safeDocumentId}.md`;
  }
  return 'rejection-check/tender.md';
}

// 原子写 markdown（temp + rename，对齐桌面 writeDocumentMarkdown 的 244-252）。
async function writeMarkdownFile(absPath: string, markdown: string): Promise<void> {
  const content = `${String(markdown || '').trim()}\n`;
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, absPath);
}

async function readMarkdownFileSafe(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, 'utf-8');
  } catch {
    return '';
  }
}

// 从技术方案 state 取「放弃的投标段落」抽取内容（pre-populate extraction，对齐桌面 139-142）。
function getTechnicalPlanDiscardedBids(technicalPlan: unknown): string {
  const task = (technicalPlan as { bidAnalysisTasks?: { discardedBids?: { status?: string; content?: string } } })?.bidAnalysisTasks
    ?.discardedBids;
  return task?.status === 'success' && task.content?.trim() ? stripTripleQuoteWrapper(task.content) : '';
}

// 纯函数：供 P6 任务引擎构造文档/输入签名（判断是否需重跑）。P3 路由不调用，保留 parity。
export function createDocumentSignature(document: unknown): string {
  if (!document) return '';
  const d = document as { content?: string; role?: string; id?: string; source?: unknown; fileName?: unknown };
  const content = String(d.content || '').trim();
  const signatureId = d.role === 'bid' && d.id === 'bid-1' ? 'bid' : d.id || d.role;
  return [
    signatureId,
    d.source,
    d.fileName,
    content.length,
    content.slice(0, 800),
    content.slice(-800),
  ].join('\n---yibiao-rejection-signature---\n');
}

export function createRejectionCheckInputSignature(
  bidDocuments: unknown,
  invalidBidAndRejectionItems: unknown,
  customCheckItems: unknown,
): string {
  const documents = Array.isArray(bidDocuments) ? bidDocuments : [bidDocuments].filter(Boolean);
  const bidSignature = documents.map(createDocumentSignature).filter(Boolean).join('\n---yibiao-rejection-bid-document---\n');
  const analysis = String(invalidBidAndRejectionItems || '').trim();
  if (!bidSignature || !analysis) return '';
  const custom = String(customCheckItems || '').trim();
  return [
    bidSignature,
    analysis.length,
    analysis.slice(0, 800),
    analysis.slice(-800),
    custom.length,
    custom.slice(0, 800),
    custom.slice(-800),
  ].join('\n---yibiao-rejection-check-input---\n');
}

// snake_case background-task DTO（extractionTask/checkTask 的值对象，全 snake_case）。
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
  };
}

// camelCase 文档 DTO。content 从工作区 FS 读（markdownPath 列存相对路径，paths.resolve 还原）。
async function documentFromRow(
  paths: WorkspacePaths,
  row: {
    documentId: string;
    role: string;
    fileName: string;
    source: string;
    markdownPath: string;
    parserLabel: string | null;
    importedAt: string;
  },
): Promise<{ id: string; role: 'tender' | 'bid'; fileName: string; content: string; source: string; parserLabel?: string; importedAt: string }> {
  const content = await readMarkdownFileSafe(paths.resolve(row.markdownPath));
  return {
    id: row.documentId || row.role,
    role: normalizeDocumentRole(row.role),
    fileName: row.fileName,
    content,
    source: row.source === 'technical-plan' ? 'technical-plan' : 'upload',
    parserLabel: row.parserLabel || undefined,
    importedAt: row.importedAt,
  };
}

// Prisma Json 列写入辅助：null/undefined → DbNull（SQL NULL），其余强转为 InputJsonValue。
function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

export function createRejectionCheckStore(prisma: PrismaClient) {
  // ---- meta ----
  async function ensureMetaRow(projectId: number, client: Tx | PrismaClient) {
    const existing = await client.rejectionCheckMeta.findUnique({ where: { projectId } });
    if (existing) return existing;
    const timestamp = now();
    return client.rejectionCheckMeta.create({
      data: {
        projectId,
        step: 'documents',
        activeDocumentTab: 'tender',
        activeResultTab: 'analysis',
        activeCheckResultTab: 'rejection',
        customCheckItems: '',
        checkOptionsJson: jsonOrNull(initialState.checkOptions),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  async function updateMeta(projectId: number, client: Tx | PrismaClient, data: Record<string, unknown>) {
    await ensureMetaRow(projectId, client);
    const entries = Object.entries(data || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const payload: Record<string, unknown> = {};
    for (const [key, value] of entries) payload[key] = value;
    payload.updatedAt = now();
    await client.rejectionCheckMeta.update({ where: { projectId }, data: payload });
  }

  // ---- documents ----
  // FS 写（writeDocumentMarkdown）no-op；content body 不持久化（P4 加 content 列补）。
  // 行仍写 DB（contentHash/contentChars 从 content 算，markdownPath 存相对路径串）。
  async function saveDocument(
    projectId: number,
    client: Tx | PrismaClient,
    paths: WorkspacePaths,
    document: Record<string, unknown> | null | undefined,
    sortOrder = 0,
  ): Promise<string | undefined> {
    if (!document?.role) return undefined;
    const role = normalizeDocumentRole(document.role);
    const markdown = String(document.content || '').trim();
    if (!markdown) return undefined;
    const documentId =
      role === 'tender'
        ? String(document.id || tenderDocumentId)
        : String(document.id || createBidDocumentId(document.fileName, markdown));
    const timestamp = now();
    const markdownPath = getDocumentMarkdownRelativePath(role, documentId);
    await writeMarkdownFile(paths.resolve(markdownPath), markdown);
    const data = {
      projectId,
      documentId,
      role,
      source: document.source === 'technical-plan' ? 'technical-plan' : 'upload',
      fileName: String(document.fileName || (role === 'bid' ? '投标文件' : '招标文件')),
      markdownPath,
      contentHash: stableHash(markdown),
      contentChars: markdown.length,
      parserLabel: document.parserLabel ? String(document.parserLabel) : null,
      sortOrder: Number(sortOrder || 0),
      importedAt: String(document.importedAt || timestamp),
      updatedAt: timestamp,
    };
    await client.rejectionCheckDocument.upsert({
      where: { projectId_documentId: { projectId, documentId } },
      create: data,
      update: data,
    });
    return documentId;
  }

  async function loadTenderDocument(projectId: number, client: Tx | PrismaClient, paths: WorkspacePaths) {
    const row = await client.rejectionCheckDocument.findFirst({
      where: { projectId, role: 'tender' },
      orderBy: [{ sortOrder: 'asc' }, { importedAt: 'asc' }],
    });
    return row ? documentFromRow(paths, row) : null;
  }

  async function loadTenderDocuments(projectId: number, client: Tx | PrismaClient, paths: WorkspacePaths) {
    const rows = await client.rejectionCheckDocument.findMany({
      where: { projectId, role: 'tender', NOT: { documentId: tenderDocumentId } },
      orderBy: [{ sortOrder: 'asc' }, { importedAt: 'asc' }],
    });
    return Promise.all(rows.map((row) => documentFromRow(paths, row)));
  }

  async function loadBidDocuments(projectId: number, client: Tx | PrismaClient, paths: WorkspacePaths) {
    const rows = await client.rejectionCheckDocument.findMany({
      where: { projectId, role: 'bid' },
      orderBy: [{ sortOrder: 'asc' }, { importedAt: 'asc' }],
    });
    return Promise.all(rows.map((row) => documentFromRow(paths, row)));
  }

  async function resequenceBidDocuments(projectId: number, client: Tx | PrismaClient) {
    const rows = await client.rejectionCheckDocument.findMany({
      where: { projectId, role: 'bid' },
      orderBy: [{ sortOrder: 'asc' }, { importedAt: 'asc' }],
      select: { documentId: true },
    });
    const timestamp = now();
    for (const [index, row] of rows.entries()) {
      await client.rejectionCheckDocument.update({
        where: { projectId_documentId: { projectId, documentId: row.documentId } },
        data: { sortOrder: index, updatedAt: timestamp },
      });
    }
  }

  // ---- tasks ----
  async function saveTask(
    projectId: number,
    client: Tx | PrismaClient,
    type: string,
    task: Record<string, unknown> | null | undefined,
  ) {
    if (!task) {
      await client.rejectionCheckTask.deleteMany({ where: { projectId, type } });
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
      startedAt: (task as { started_at?: string }).started_at || timestamp,
      updatedAt: (task as { updated_at?: string }).updated_at || timestamp,
    };
    await client.rejectionCheckTask.upsert({
      where: { projectId_type: { projectId, type } },
      create: { projectId, type, ...data },
      update: data,
    });
  }

  async function loadTasks(projectId: number, client: Tx | PrismaClient): Promise<Record<string, unknown>> {
    const rows = await client.rejectionCheckTask.findMany({ where: { projectId } });
    const tasks: Record<string, unknown> = {};
    for (const row of rows) {
      const field = taskTypeFields[row.type];
      if (field) tasks[field] = taskFromRow(row);
    }
    return tasks;
  }

  // ---- extraction ----
  async function saveExtraction(
    projectId: number,
    client: Tx | PrismaClient,
    extraction: Record<string, unknown> | null | undefined,
  ) {
    if (!extraction) {
      await client.rejectionCheckExtraction.deleteMany({ where: { projectId } });
      return;
    }
    const data = {
      status: normalizeStatus(extraction.status, ['idle', 'running', 'success', 'error'], 'idle'),
      content: stripTripleQuoteWrapper(extraction.content || ''),
      source: extraction.source ? String(extraction.source) : null,
      tenderSignature: extraction.tenderSignature ? String(extraction.tenderSignature) : null,
      error: extraction.error ? String(extraction.error) : null,
      updatedAt: extraction.updatedAt ? String(extraction.updatedAt) : now(),
    };
    await client.rejectionCheckExtraction.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
  }

  async function loadExtraction(projectId: number, client: Tx | PrismaClient): Promise<Record<string, unknown>> {
    const row = await client.rejectionCheckExtraction.findUnique({ where: { projectId } });
    if (!row) return { status: 'idle', content: '' };
    return {
      status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
      content: stripTripleQuoteWrapper(row.content || ''),
      source: row.source || undefined,
      tenderSignature: row.tenderSignature || undefined,
      error: row.error || undefined,
      updatedAt: row.updatedAt || undefined,
    };
  }

  // ---- results + findings ----
  async function clearFindingRows(projectId: number, client: Tx | PrismaClient, resultType: string) {
    if (resultType === 'rejection') await client.rejectionCheckRiskFinding.deleteMany({ where: { projectId } });
    if (resultType === 'typo') await client.rejectionCheckTypoFinding.deleteMany({ where: { projectId } });
    if (resultType === 'logic') await client.rejectionCheckLogicFinding.deleteMany({ where: { projectId } });
  }

  async function saveFindingRows(projectId: number, client: Tx | PrismaClient, resultType: string, findings: unknown[]) {
    const timestamp = now();
    if (resultType === 'rejection') {
      const rows = (findings as Record<string, unknown>[]).map((item, index) => ({
        projectId,
        findingId: String(item.id || `rejection-finding-${index + 1}`),
        bidDocumentId: item.bidDocumentId ? String(item.bidDocumentId) : null,
        type: item.type === 'invalidBid' ? 'invalidBid' : 'rejectionItem',
        severity: ['high', 'medium', 'low'].includes(item.severity as string) ? (item.severity as string) : 'medium',
        title: String(item.title || ''),
        summary: String(item.summary || item.title || ''),
        requirement: String(item.requirement || ''),
        bidEvidence: String(item.bidEvidence || ''),
        riskReason: String(item.riskReason || ''),
        suggestion: String(item.suggestion || ''),
        sortOrder: index,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      if (rows.length) await client.rejectionCheckRiskFinding.createMany({ data: rows as never[] });
    }
    if (resultType === 'typo') {
      const rows = (findings as Record<string, unknown>[]).map((item, index) => ({
        projectId,
        findingId: String(item.id || `typo-finding-${index + 1}`),
        bidDocumentId: item.bidDocumentId ? String(item.bidDocumentId) : null,
        wrongText: String(item.wrongText || ''),
        correctText: String(item.correctText || ''),
        originalExcerpt: String(item.originalExcerpt || ''),
        reason: String(item.reason || ''),
        locationHint: item.locationHint ? String(item.locationHint) : null,
        sortOrder: index,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      if (rows.length) await client.rejectionCheckTypoFinding.createMany({ data: rows as never[] });
    }
    if (resultType === 'logic') {
      const rows = (findings as Record<string, unknown>[]).map((item, index) => ({
        projectId,
        findingId: String(item.id || `logic-finding-${index + 1}`),
        bidDocumentId: item.bidDocumentId ? String(item.bidDocumentId) : null,
        title: String(item.title || ''),
        originalText: String(item.originalText || ''),
        locationHint: String(item.locationHint || ''),
        fallacyReason: String(item.fallacyReason || ''),
        suggestion: String(item.suggestion || ''),
        sortOrder: index,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      if (rows.length) await client.rejectionCheckLogicFinding.createMany({ data: rows as never[] });
    }
  }

  async function saveResult(
    projectId: number,
    client: Tx | PrismaClient,
    resultType: string,
    result: Record<string, unknown> | null | undefined,
  ) {
    await clearFindingRows(projectId, client, resultType);
    if (!result) {
      await client.rejectionCheckResult.deleteMany({ where: { projectId, resultType } });
      return;
    }
    const data = {
      status: normalizeStatus(result.status, ['idle', 'running', 'success', 'error'], 'idle'),
      inputSignature: result.inputSignature ? String(result.inputSignature) : null,
      activeFindingId: result.activeFindingId ? String(result.activeFindingId) : null,
      progressMessage: result.progressMessage ? String(result.progressMessage) : null,
      error: result.error ? String(result.error) : null,
      updatedAt: result.updatedAt ? String(result.updatedAt) : now(),
    };
    await client.rejectionCheckResult.upsert({
      where: { projectId_resultType: { projectId, resultType } },
      create: { projectId, resultType, ...data },
      update: data,
    });
    await saveFindingRows(projectId, client, resultType, Array.isArray(result.findings) ? result.findings : []);
  }

  async function loadFindingRows(projectId: number, client: Tx | PrismaClient, resultType: string): Promise<Record<string, unknown>[]> {
    const fallbackRow = await client.rejectionCheckDocument.findFirst({
      where: { projectId, role: 'bid' },
      orderBy: { sortOrder: 'asc' },
      select: { documentId: true },
    });
    const fallbackBidDocumentId = fallbackRow?.documentId || '';
    if (resultType === 'rejection') {
      const rows = await client.rejectionCheckRiskFinding.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });
      return rows.map((item) => ({
        id: item.findingId,
        bidDocumentId: item.bidDocumentId || fallbackBidDocumentId,
        type: item.type,
        severity: item.severity,
        title: item.title,
        summary: item.summary,
        requirement: item.requirement,
        bidEvidence: item.bidEvidence,
        riskReason: item.riskReason,
        suggestion: item.suggestion,
      }));
    }
    if (resultType === 'typo') {
      const rows = await client.rejectionCheckTypoFinding.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });
      return rows.map((item) => ({
        id: item.findingId,
        bidDocumentId: item.bidDocumentId || fallbackBidDocumentId,
        wrongText: item.wrongText,
        correctText: item.correctText,
        originalExcerpt: item.originalExcerpt,
        reason: item.reason,
        locationHint: item.locationHint || undefined,
      }));
    }
    const rows = await client.rejectionCheckLogicFinding.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });
    return rows.map((item) => ({
      id: item.findingId,
      bidDocumentId: item.bidDocumentId || fallbackBidDocumentId,
      title: item.title,
      originalText: item.originalText,
      locationHint: item.locationHint,
      fallacyReason: item.fallacyReason,
      suggestion: item.suggestion,
    }));
  }

  async function loadResult(projectId: number, client: Tx | PrismaClient, resultType: string): Promise<Record<string, unknown>> {
    const row = await client.rejectionCheckResult.findUnique({ where: { projectId_resultType: { projectId, resultType } } });
    const base = { status: 'idle', findings: [] };
    if (!row) return base;
    return {
      status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
      findings: await loadFindingRows(projectId, client, resultType),
      inputSignature: row.inputSignature || undefined,
      activeFindingId: row.activeFindingId || undefined,
      progressMessage: row.progressMessage || undefined,
      error: row.error || undefined,
      updatedAt: row.updatedAt || undefined,
    };
  }

  async function clearCheckResults(projectId: number, client: Tx | PrismaClient) {
    await client.rejectionCheckResult.deleteMany({ where: { projectId } });
    await client.rejectionCheckRiskFinding.deleteMany({ where: { projectId } });
    await client.rejectionCheckTypoFinding.deleteMany({ where: { projectId } });
    await client.rejectionCheckLogicFinding.deleteMany({ where: { projectId } });
    await client.rejectionCheckTask.deleteMany({ where: { projectId, type: 'rejection-check-run' } });
  }

  async function clearExtractionAndCheckResults(projectId: number, client: Tx | PrismaClient) {
    await client.rejectionCheckExtraction.deleteMany({ where: { projectId } });
    await client.rejectionCheckTask.deleteMany({ where: { projectId, type: 'rejection-items-extraction' } });
    await clearCheckResults(projectId, client);
  }

  // 删 DB 行前先 rm 各行 markdown 文件（对齐桌面 removeMarkdownForRow，无图片批次）。
  async function clearDocument(
    projectId: number,
    client: Tx | PrismaClient,
    paths: WorkspacePaths,
    role: unknown,
    documentId?: unknown,
  ) {
    const documentRole = normalizeDocumentRole(role);
    if (documentRole === 'tender') {
      const rows = await client.rejectionCheckDocument.findMany({
        where: { projectId, role: 'tender' },
        select: { markdownPath: true },
      });
      await Promise.all(rows.map((r) => fs.rm(paths.resolve(r.markdownPath), { force: true }).catch(() => undefined)));
      await client.rejectionCheckDocument.deleteMany({ where: { projectId, role: 'tender' } });
      await clearExtractionAndCheckResults(projectId, client);
    } else {
      const whereClause = documentId
        ? { projectId, role: 'bid' as const, documentId: String(documentId) }
        : { projectId, role: 'bid' as const };
      const rows = await client.rejectionCheckDocument.findMany({ where: whereClause, select: { markdownPath: true } });
      await Promise.all(rows.map((r) => fs.rm(paths.resolve(r.markdownPath), { force: true }).catch(() => undefined)));
      await client.rejectionCheckDocument.deleteMany({ where: whereClause });
      await resequenceBidDocuments(projectId, client);
      await clearCheckResults(projectId, client);
    }
  }

  // ---- transaction body（对应桌面 updateRejectionCheckTransaction） ----
  async function updateRejectionCheckTransaction(projectId: number, tx: Tx, paths: WorkspacePaths, partial: Record<string, unknown>) {
    await ensureMetaRow(projectId, tx);
    const metaUpdates: Record<string, unknown> = {};
    if (hasOwn(partial, 'step')) metaUpdates.step = normalizeStep(partial.step);
    if (hasOwn(partial, 'activeDocumentTab')) metaUpdates.activeDocumentTab = normalizeDocumentTab(partial.activeDocumentTab);
    if (hasOwn(partial, 'activeResultTab')) metaUpdates.activeResultTab = normalizeResultTab(partial.activeResultTab);
    if (hasOwn(partial, 'activeCheckResultTab')) metaUpdates.activeCheckResultTab = normalizeCheckResultTab(partial.activeCheckResultTab);
    if (hasOwn(partial, 'customCheckItems')) metaUpdates.customCheckItems = String(partial.customCheckItems || '');
    if (hasOwn(partial, 'checkOptions')) metaUpdates.checkOptionsJson = jsonOrNull(normalizeCheckOptions(partial.checkOptions));
    if (Object.keys(metaUpdates).length) await updateMeta(projectId, tx, metaUpdates);

    if (hasOwn(partial, 'tenderDocument')) {
      if (partial.tenderDocument) await saveDocument(projectId, tx, paths, partial.tenderDocument as Record<string, unknown>, 0);
      else await clearDocument(projectId, tx, paths, 'tender');
    }
    if (hasOwn(partial, 'tenderDocuments')) {
      await clearDocument(projectId, tx, paths, 'tender');
      const documents = Array.isArray(partial.tenderDocuments) ? partial.tenderDocuments : [];
      const combined = combineTenderMarkdown(documents);
      if (combined) {
        const firstDoc = (documents[0] as Record<string, unknown>) || {};
        await saveDocument(
          projectId,
          tx,
          paths,
          {
            id: tenderDocumentId,
            role: 'tender',
            fileName: documents.length > 1 ? `${documents.length} 份招标文件` : firstDoc.fileName || '招标文件',
            content: combined,
            source: firstDoc.source || 'upload',
            importedAt: now(),
          },
          0,
        );
      }
      for (const [index, document] of documents.entries()) {
        await saveDocument(projectId, tx, paths, document as Record<string, unknown>, index + 1);
      }
    }
    if (hasOwn(partial, 'bidDocuments')) {
      await clearDocument(projectId, tx, paths, 'bid');
      const documents = Array.isArray(partial.bidDocuments) ? partial.bidDocuments : [];
      for (const [index, document] of documents.entries()) {
        await saveDocument(projectId, tx, paths, document as Record<string, unknown>, index);
      }
    }
    if (hasOwn(partial, 'invalidBidAndRejectionItems')) {
      await saveExtraction(projectId, tx, partial.invalidBidAndRejectionItems as Record<string, unknown>);
    }
    for (const [field, type] of Object.entries(resultFieldTypes)) {
      if (hasOwn(partial, field)) await saveResult(projectId, tx, type, partial[field] as Record<string, unknown> | undefined);
    }
    for (const [field, type] of Object.entries(taskFieldTypes)) {
      if (hasOwn(partial, field)) await saveTask(projectId, tx, type, partial[field] as Record<string, unknown> | undefined);
    }
  }

  // ---- public API ----
  async function loadRejectionCheck(projectId: number): Promise<Record<string, unknown>> {
    const paths = createWorkspacePaths(projectId);
    const meta = await ensureMetaRow(projectId, prisma);
    const tasks = await loadTasks(projectId, prisma);
    const tenderDocument = await loadTenderDocument(projectId, prisma, paths);
    const tenderDocuments = await loadTenderDocuments(projectId, prisma, paths);
    const bidDocuments = await loadBidDocuments(projectId, prisma, paths);
    const activeDocumentTab = normalizeDocumentTab(meta.activeDocumentTab);
    const validActiveDocumentTab =
      activeDocumentTab === 'tender' ||
      tenderDocuments.some((document) => document.id === activeDocumentTab) ||
      bidDocuments.some((document) => document.id === activeDocumentTab)
        ? activeDocumentTab
        : tenderDocument
          ? 'tender'
          : bidDocuments[0]?.id || 'tender';
    return {
      ...initialState,
      tenderDocument,
      tenderDocuments,
      bidDocuments,
      activeDocumentTab: validActiveDocumentTab,
      step: normalizeStep(meta.step),
      activeResultTab: normalizeResultTab(meta.activeResultTab),
      activeCheckResultTab: normalizeCheckResultTab(meta.activeCheckResultTab),
      invalidBidAndRejectionItems: await loadExtraction(projectId, prisma),
      customCheckItems: meta.customCheckItems || '',
      checkOptions: normalizeCheckOptions(meta.checkOptionsJson ?? initialState.checkOptions),
      rejectionCheckResult: await loadResult(projectId, prisma, 'rejection'),
      typoCheckResult: await loadResult(projectId, prisma, 'typo'),
      logicCheckResult: await loadResult(projectId, prisma, 'logic'),
      ...tasks,
    };
  }

  async function updateRejectionCheck(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>> {
    const paths = createWorkspacePaths(projectId);
    await prisma.$transaction(async (tx) => {
      await updateRejectionCheckTransaction(projectId, tx, paths, partial || {});
    });
    return loadRejectionCheck(projectId);
  }

  async function saveUiState(
    projectId: number,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const uiState: Record<string, unknown> = {};
    for (const field of ['step', 'activeDocumentTab', 'activeResultTab', 'activeCheckResultTab', 'customCheckItems', 'checkOptions']) {
      if (hasOwn(payload, field)) uiState[field] = payload[field];
    }
    return updateRejectionCheck(projectId, uiState);
  }

  async function removeDocument(
    projectId: number,
    role: string,
    documentId?: string,
  ): Promise<Record<string, unknown>> {
    const paths = createWorkspacePaths(projectId);
    await prisma.$transaction(async (tx) => {
      await clearDocument(projectId, tx, paths, role, documentId);
      if (normalizeDocumentRole(role) === 'bid') {
        const nextBid = await tx.rejectionCheckDocument.findFirst({
          where: { projectId, role: 'bid' },
          orderBy: { sortOrder: 'asc' },
          select: { documentId: true },
        });
        await updateMeta(projectId, tx, { activeDocumentTab: nextBid?.documentId || 'tender' });
      } else {
        await updateMeta(projectId, tx, { activeDocumentTab: 'tender' });
      }
    });
    return loadRejectionCheck(projectId);
  }

  async function clearRejectionCheck(projectId: number): Promise<{ success: boolean; message: string; state: Record<string, unknown> }> {
    const paths = createWorkspacePaths(projectId);
    await prisma.$transaction(async (tx) => {
      await tx.rejectionCheckTask.deleteMany({ where: { projectId } });
      await tx.rejectionCheckExtraction.deleteMany({ where: { projectId } });
      await tx.rejectionCheckResult.deleteMany({ where: { projectId } });
      await tx.rejectionCheckRiskFinding.deleteMany({ where: { projectId } });
      await tx.rejectionCheckTypoFinding.deleteMany({ where: { projectId } });
      await tx.rejectionCheckLogicFinding.deleteMany({ where: { projectId } });
      await tx.rejectionCheckDocument.deleteMany({ where: { projectId } });
      await tx.rejectionCheckMeta.deleteMany({ where: { projectId } });
      await ensureMetaRow(projectId, tx);
    });
    await fs.rm(paths.rejectionCheckDir, { recursive: true, force: true }).catch(() => undefined);
    return { success: true, message: '废标项检查缓存已清空', state: await loadRejectionCheck(projectId) };
  }

  // 读单个文档 markdown（桌面 readDocumentMarkdown：按 role/documentId 定位行 → 读 FS）。
  // 渲染器不直接调用（无 IPC 通道），documentFromRow 已内联读 content；保留供 P6 任务引擎。
  async function readDocumentMarkdown(projectId: number, roleOrDocumentId?: string): Promise<string> {
    const paths = createWorkspacePaths(projectId);
    const value = String(roleOrDocumentId || '').trim();
    const row = await (async () => {
      if (value === 'tender') {
        return prisma.rejectionCheckDocument.findFirst({ where: { projectId, role: 'tender' }, orderBy: { sortOrder: 'asc' } });
      }
      if (value === 'bid') {
        return prisma.rejectionCheckDocument.findFirst({ where: { projectId, role: 'bid' }, orderBy: { sortOrder: 'asc' } });
      }
      if (value) {
        return prisma.rejectionCheckDocument.findUnique({ where: { projectId_documentId: { projectId, documentId: value } } });
      }
      return null;
    })();
    if (!row) return '';
    return readMarkdownFileSafe(paths.resolve(row.markdownPath));
  }

  // 文件导入（multipart 已由 route 解析成 ParsedImport[]）。对齐桌面 importDocument 691-789。
  // tender：清旧 → 合并正文存 combined 行 + 各源文件行；bid：按 fileName+contentHash 去重追加。
  async function importDocument(
    projectId: number,
    role: string,
    docs: ParsedImport[],
    failedCount = 0,
  ): Promise<{ success: boolean; message: string; state: Record<string, unknown> }> {
    const documentRole = normalizeDocumentRole(role);
    if (!docs.length) {
      return { success: false, message: '未导入文件', state: await loadRejectionCheck(projectId) };
    }
    const paths = createWorkspacePaths(projectId);
    let addedCount = 0;
    let skippedCount = 0;
    let firstAddedBidDocumentId = '';
    await prisma.$transaction(async (tx) => {
      if (documentRole === 'tender') {
        await clearDocument(projectId, tx, paths, 'tender');
        const combinedMarkdown = combineTenderMarkdown(docs);
        const first = docs[0] || ({} as ParsedImport);
        await saveDocument(projectId, tx, paths, {
          id: tenderDocumentId,
          role: documentRole,
          fileName: docs.length > 1 ? `${docs.length} 份招标文件` : first.fileName || '招标文件',
          content: combinedMarkdown,
          source: 'upload',
          parserLabel: docs.length > 1 ? undefined : first.parserLabel,
          importedAt: now(),
        }, 0);
        for (const [index, item] of docs.entries()) {
          const markdown = String(item.markdown || '').trim();
          if (!markdown) continue;
          await saveDocument(projectId, tx, paths, {
            id: createTenderSourceDocumentId(item.fileName || '招标文件', markdown, index),
            role: 'tender',
            fileName: item.fileName || '招标文件',
            content: markdown,
            source: 'upload',
            parserLabel: item.parserLabel,
            importedAt: now(),
          }, index + 1);
        }
        await updateMeta(projectId, tx, { activeDocumentTab: 'tender' });
        addedCount = docs.length;
        return;
      }

      const existingRows = await tx.rejectionCheckDocument.findMany({
        where: { projectId, role: 'bid' },
        select: { fileName: true, contentHash: true },
      });
      const existingKeys = new Set(existingRows.map((r) => `${r.fileName}\u0000${r.contentHash}`));
      let sortOrder = existingRows.length;
      for (const item of docs) {
        const markdown = String(item.markdown || '').trim();
        if (!markdown) continue;
        const fileName = item.fileName || '投标文件';
        const contentHash = stableHash(markdown);
        const key = `${fileName}\u0000${contentHash}`;
        if (existingKeys.has(key)) {
          skippedCount += 1;
          continue;
        }
        const documentId = createBidDocumentId(fileName, markdown);
        const savedDocumentId = await saveDocument(projectId, tx, paths, {
          id: documentId,
          role: 'bid',
          fileName,
          content: markdown,
          source: 'upload',
          parserLabel: item.parserLabel,
          importedAt: now(),
        }, sortOrder);
        existingKeys.add(key);
        if (!firstAddedBidDocumentId) firstAddedBidDocumentId = savedDocumentId || documentId;
        sortOrder += 1;
        addedCount += 1;
      }
      if (addedCount > 0) {
        await clearCheckResults(projectId, tx);
        await updateMeta(projectId, tx, { activeDocumentTab: firstAddedBidDocumentId || 'tender' });
      }
    });
    if (documentRole === 'bid' && addedCount === 0) {
      const messageParts: string[] = [];
      if (skippedCount > 0) messageParts.push(`已跳过 ${skippedCount} 份重复文件`);
      if (failedCount > 0) messageParts.push(`失败 ${failedCount} 份`);
      const message = messageParts.length ? messageParts.join('，') : '未导入文件';
      return { success: false, message, state: await loadRejectionCheck(projectId) };
    }
    const messageParts = [`已解析 ${addedCount} 份${documentRole === 'bid' ? '投标' : '招标'}文件`];
    if (skippedCount > 0) messageParts.push(`跳过 ${skippedCount} 份重复文件`);
    if (failedCount > 0) messageParts.push(`失败 ${failedCount} 份`);
    return { success: true, message: messageParts.join('，'), state: await loadRejectionCheck(projectId) };
  }

  // 跨域：从技术方案读招标文件正文（combined + 各源），并预填「放弃的投标段落」抽取。
  // 对齐桌面 importTenderFromTechnicalPlan 791-849。
  async function importTenderFromTechnicalPlan(projectId: number): Promise<{ success: boolean; message: string; state: Record<string, unknown> }> {
    const paths = createWorkspacePaths(projectId);
    const tpStore = createTechnicalPlanStore(prisma);
    const markdown = await tpStore.readTenderMarkdown(projectId);
    if (!markdown.trim()) {
      return { success: false, message: '技术方案中暂无可读取的招标文件正文', state: await loadRejectionCheck(projectId) };
    }
    const technicalPlan = (await tpStore.loadTechnicalPlan(projectId)) as {
      tenderFiles?: Array<{ id?: string; fileName?: string; parserLabel?: string; importedAt?: string }>;
      tenderFile?: { fileName?: string };
    };
    const sourceFiles = Array.isArray(technicalPlan?.tenderFiles) ? technicalPlan.tenderFiles : [];
    const sourceDocuments: Array<Record<string, unknown>> = [];
    for (const [index, file] of sourceFiles.entries()) {
      const content = typeof tpStore.readTenderSourceMarkdown === 'function'
        ? String(await tpStore.readTenderSourceMarkdown(projectId, String(file.id || ''))).trim()
        : '';
      if (!content) continue;
      sourceDocuments.push({
        id: createTenderSourceDocumentId(file.fileName || '技术方案招标文件', content, index),
        role: 'tender',
        fileName: file.fileName || '技术方案招标文件',
        content,
        source: 'technical-plan',
        parserLabel: file.parserLabel,
        importedAt: file.importedAt || now(),
      });
    }
    const document = {
      id: tenderDocumentId,
      role: 'tender',
      fileName: sourceDocuments.length > 1
        ? `${sourceDocuments.length} 份技术方案招标文件`
        : (sourceDocuments[0]?.fileName as string) || technicalPlan?.tenderFile?.fileName || '技术方案招标文件',
      content: markdown,
      source: 'technical-plan',
      importedAt: now(),
    };
    const documentsToSave = sourceDocuments.length
      ? sourceDocuments
      : [{ ...document, id: 'tender-technical-plan', fileName: document.fileName }];
    const discardedBids = getTechnicalPlanDiscardedBids(technicalPlan);
    const tenderSignature = createDocumentSignature(document);
    await prisma.$transaction(async (tx) => {
      await clearDocument(projectId, tx, paths, 'tender');
      await saveDocument(projectId, tx, paths, document, 0);
      for (const [index, item] of documentsToSave.entries()) {
        await saveDocument(projectId, tx, paths, item, index + 1);
      }
      await clearExtractionAndCheckResults(projectId, tx);
      if (discardedBids) {
        await saveExtraction(projectId, tx, {
          status: 'success',
          content: discardedBids,
          source: 'technical-plan',
          tenderSignature,
          updatedAt: now(),
        });
      }
      await updateMeta(projectId, tx, { activeDocumentTab: 'tender' });
    });
    return { success: true, message: '已从技术方案读取招标文件', state: await loadRejectionCheck(projectId) };
  }

  return {
    loadRejectionCheck,
    updateRejectionCheck,
    saveUiState,
    removeDocument,
    clearRejectionCheck,
    readDocumentMarkdown,
    importDocument,
    importTenderFromTechnicalPlan,
  };
}

export type RejectionCheckStore = ReturnType<typeof createRejectionCheckStore>;
