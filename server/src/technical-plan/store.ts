// 技术方案状态持久化（按用户隔离）。忠实移植自 client/electron/services/technicalPlanStore.cjs
// 的**纯状态部分**（loadTechnicalPlan 装配 + 12 个写入方法）。
// better-sqlite3 同步 → Prisma 异步；snake_case 行 → 混合大小写 DTO（顶层标量 camelCase，
// task/plan/runtime/section/facts/outline 等嵌套对象 snake_case，少数 camelCase）。
//
// P3 边界：文件系统纠缠（招标/原方案 markdown 读写、标段工作副本派生、import/checkBidSections）
// 全部 stub 或跳过，留给 P4 文件上传。任务引擎（tasks:* 生成）留给 P6/P7。
//
// 移植时与桌面 technicalPlanStore.cjs 逐段对照；行号注释指向桌面源以便溯源。
import { Prisma, PrismaClient } from '@prisma/client';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWorkspacePaths } from '../document/paths';
import type { ParsedImport } from '../document/parser';
import { detectBidSections, type BidSectionDetection } from './bidSectionDetector';

export type { ParsedImport };

type Db = PrismaClient | Prisma.TransactionClient;

export interface ImportResult {
  success: boolean;
  message: string;
  state: TechnicalPlanState;
  markdown: string;
}

// ---- DTO 形状（与 client/src/features/technical-plan/types.ts 逐字段对齐） ----
// 顶层标量 camelCase；嵌套按各自 DTO（多数 snake_case）。

export interface BackgroundTaskState {
  task_id: string;
  type: string;
  status: string;
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
  stats?: unknown;
  pause_requested: boolean;
  diagnostic_trace_id?: string;
  degraded?: boolean;
  reused?: boolean;
}

export interface BidAnalysisTaskState {
  id: string;
  label: string;
  status: string;
  content: string;
  error?: string;
}

export interface GlobalFactGroupState {
  id: string;
  title: string;
  content: string;
  updated_at?: string;
}

export interface ContentGenerationSectionState {
  id: string;
  title: string;
  status: string;
  content: string;
  error?: string;
  updated_at?: string;
}

export interface ContentGenerationPlanState {
  plan_version: number;
  plan: unknown;
  table_requirement?: string;
  updated_at?: string;
}

export interface OutlineItem {
  id: string;
  title: string;
  description?: string;
  source_requirement_id?: string;
  source_requirement_title?: string;
  knowledge_item_ids?: string[];
  outlineAttribute?: string;
  contentMode?: string;
  contentModeNote?: string;
  isMirror?: boolean;
  mirrorSourceText?: string;
  content?: string;
  children?: OutlineItem[];
}

export interface OutlineData {
  outline: OutlineItem[];
  project_name?: string;
  project_overview?: string;
  word_control_options?: Record<string, unknown>;
  word_control_snapshot?: Record<string, unknown>;
}

export interface TechnicalPlanState {
  workflowKind: string;
  step: string;
  tenderFile: Record<string, unknown> | null;
  tenderFiles: Record<string, unknown>[];
  originalPlanFile: Record<string, unknown> | null;
  projectOverview: string;
  techRequirements: string;
  bidAnalysisMode: string;
  bidAnalysisSelectedTaskIds: string[];
  bidAnalysisTasks: Record<string, BidAnalysisTaskState>;
  bidAnalysisProgress: number;
  bidSectionMode: string;
  bidSections: unknown[];
  bidSectionExtractionStatus: string;
  bidSectionExtractionError?: string;
  outlineMode: string;
  outlineExpansionMode: string;
  mirrorProcurementEnabled: boolean;
  outlineWordControlOptions?: Record<string, unknown>;
  outlineWordControlSnapshot?: Record<string, unknown>;
  referenceKnowledgeDocumentIds: string[];
  bidSectionExtractionTask?: BackgroundTaskState;
  bidAnalysisTask?: BackgroundTaskState;
  outlineGenerationTask?: BackgroundTaskState;
  globalFactsTask?: BackgroundTaskState;
  globalFacts: GlobalFactGroupState[];
  contentGenerationTask?: BackgroundTaskState;
  contentGenerationOptions?: unknown;
  contentGenerationSections: Record<string, ContentGenerationSectionState>;
  contentGenerationPlans: Record<string, ContentGenerationPlanState>;
  contentIllustrationPlan?: unknown;
  contentGenerationRuntime?: unknown;
  outlineData: OutlineData | null;
}

// 桌面 initialState（technicalPlanStore.cjs:21-52）
const INITIAL_STATE = {
  workflowKind: 'technical-plan',
  step: 'document-analysis',
  tenderFile: null,
  tenderFiles: [],
  originalPlanFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key',
  bidAnalysisSelectedTaskIds: [],
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  bidSectionMode: 'single',
  bidSections: [],
  bidSectionExtractionStatus: 'idle',
  outlineMode: 'aligned',
  outlineExpansionMode: 'ai-complement',
  mirrorProcurementEnabled: true,
  referenceKnowledgeDocumentIds: [],
  globalFacts: [],
  contentGenerationSections: {},
  contentGenerationPlans: {},
  outlineData: null,
};

// 招标解析任务规范集（移植自 bidAnalysisTask.cjs 的 tasks 数组，仅取 id/label/required）。
// 用于 bid_items 的 label 兜底、sort_order、以及 mode↔selectedTaskIds 归一化。
const BID_ANALYSIS_TASKS: Array<{ id: string; label: string; required: boolean }> = [
  { id: 'projectOverview', label: '项目概述', required: true },
  { id: 'techRequirements', label: '技术评分要求', required: true },
  { id: 'projectInfo', label: '项目信息', required: true },
  { id: 'partAInfo', label: '甲方信息', required: true },
  { id: 'deliveryAndServiceRequirements', label: '交货和服务要求', required: true },
  { id: 'procurementList', label: '采购清单', required: false },
  { id: 'responseFileRequirements', label: '响应文件要求', required: false },
  { id: 'agentInfo', label: '代理机构信息', required: false },
  { id: 'keyInfo', label: '投标关键节点', required: false },
  { id: 'marginInfo', label: '投标保证金', required: false },
  { id: 'qualificationReview', label: '资格性审查', required: false },
  { id: 'complianceCheck', label: '符合性检查', required: false },
  { id: 'openBid', label: '开标要求', required: false },
  { id: 'evaluationBid', label: '评标要求', required: false },
  { id: 'businessScoring', label: '商务评分要求', required: false },
  { id: 'discardedBids', label: '无效标与废标项', required: false },
  { id: 'signingProcess', label: '合同授予与签订', required: false },
  { id: 'terminationCondition', label: '合同解除和终止', required: false },
];

function getBidAnalysisTasks(mode: 'full' | 'key'): typeof BID_ANALYSIS_TASKS {
  return mode === 'full' ? BID_ANALYSIS_TASKS : BID_ANALYSIS_TASKS.filter((t) => t.required);
}

// task 字段名 ↔ task type（technicalPlanStore.cjs:54-62）
const TASK_FIELD_TYPES: Record<string, string> = {
  bidSectionExtractionTask: 'bid-section-extraction',
  bidAnalysisTask: 'bid-analysis',
  outlineGenerationTask: 'outline-generation',
  globalFactsTask: 'global-facts-generation',
  contentGenerationTask: 'content-generation',
};
const TASK_TYPE_FIELDS: Record<string, string> = Object.fromEntries(
  Object.entries(TASK_FIELD_TYPES).map(([field, type]) => [type, field]),
);

// ---- 纯助手（technicalPlanStore.cjs:64-350） ----

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

function normalizeWorkflowKind(value: unknown): string {
  return value === 'existing-plan-expansion' ? 'existing-plan-expansion' : 'technical-plan';
}

function isValidStep(value: unknown): boolean {
  return ['document-analysis', 'bid-analysis', 'outline-generation', 'global-facts', 'content-edit', 'expand'].includes(value as string);
}

function isValidBidMode(value: unknown): value is 'key' | 'full' | 'custom' {
  return value === 'key' || value === 'full' || value === 'custom';
}

function normalizeBidSectionMode(value: unknown): string {
  return value === 'multiple' ? 'multiple' : 'single';
}

function normalizeBidSectionExtractionStatus(value: unknown): string {
  return normalizeStatus(value, ['idle', 'running', 'success', 'error'], 'idle');
}

function isValidOutlineMode(value: unknown): boolean {
  return value === 'aligned';
}

function isValidOutlineExpansionMode(value: unknown): boolean {
  return value === 'original-only' || value === 'ai-complement';
}

function normalizeOutlineContentMode(value: unknown): 'ai-generate' | 'template-fill' | 'point-to-point' | 'other' {
  return value === 'template-fill' || value === 'point-to-point' || value === 'other' ? value : 'ai-generate';
}

function normalizeOutlineAttribute(value: unknown): 'general' | 'business' | 'qualification' | 'technical' | 'other' {
  return value === 'general' || value === 'business' || value === 'qualification' || value === 'other' ? value : 'technical';
}

function normalizeWordWan(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : 0;
}

function normalizeOutlineWordControlOptions(value: unknown): Record<string, unknown> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    minWordsWan: normalizeWordWan(input.minWordsWan),
    maxWordsWan: normalizeWordWan(input.maxWordsWan),
    wordsPerSectionWan: normalizeWordWan(input.wordsPerSectionWan),
    forceSectionWords: input.forceSectionWords === true,
  };
}

// Prisma Json 列读出来已经是反序列化值（非字符串）；兼容字符串兜底。
function readJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

// 写入 Prisma Json 列：undefined/null → DbNull（Prisma 对可空 Json 不接受裸 null），其余原样（Prisma 负责 JSONB 序列化）。
function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

function normalizeBidAnalysisTaskIds(taskIds: unknown): string[] {
  const requestedIds = new Set(
    (Array.isArray(taskIds) ? taskIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  return BID_ANALYSIS_TASKS.filter((t) => requestedIds.has(t.id)).map((t) => t.id);
}

function normalizeBidAnalysisConfig(mode: unknown, selectedTaskIds: unknown): { mode: string; selectedTaskIds: string[] } {
  const allTaskIds = BID_ANALYSIS_TASKS.map((t) => t.id);
  const requiredTaskIds = getBidAnalysisTasks('key').map((t) => t.id);
  const requiredSet = new Set(requiredTaskIds);
  const selectedSet = new Set([...requiredTaskIds, ...normalizeBidAnalysisTaskIds(selectedTaskIds)]);
  const selectedIds = allTaskIds.filter((id) => selectedSet.has(id));
  const hasOptional = selectedIds.some((id) => !requiredSet.has(id));
  const hasAll = selectedIds.length === allTaskIds.length;

  if (mode === 'full' || hasAll) return { mode: 'full', selectedTaskIds: allTaskIds };
  if (mode === 'custom' || hasOptional) return { mode: 'custom', selectedTaskIds: selectedIds };
  return { mode: 'key', selectedTaskIds: requiredTaskIds };
}

function getBidAnalysisTaskIdsForConfig(mode: unknown, selectedTaskIds: unknown): string[] {
  return normalizeBidAnalysisConfig(mode, selectedTaskIds).selectedTaskIds;
}

function getBidItemSortOrder(itemId: string): number {
  const index = BID_ANALYSIS_TASKS.findIndex((t) => t.id === itemId);
  return index >= 0 ? index : 9999;
}

function getBidItemLabel(itemId: string, fallbackLabel?: string): string {
  const task = BID_ANALYSIS_TASKS.find((t) => t.id === itemId);
  return fallbackLabel || task?.label || itemId;
}

function calculateBidProgress(mode: string, bidTasks: Record<string, BidAnalysisTaskState>, selectedTaskIds: string[]): number {
  const selectedIds = getBidAnalysisTaskIdsForConfig(mode, selectedTaskIds);
  if (!selectedIds.length) return 0;
  const done = selectedIds.filter((id) => ['success', 'error'].includes(bidTasks[id]?.status)).length;
  return Math.round((done / selectedIds.length) * 100);
}

function normalizeBidSectionRanges(value: unknown): Array<{ startLine: number; endLine: number; reason?: string }> {
  return (Array.isArray(value) ? value : [])
    .map((range) => {
      const r = range as Record<string, unknown>;
      return {
        startLine: Math.max(1, Math.floor(Number(r?.startLine || r?.start_line || 0))),
        endLine: Math.max(1, Math.floor(Number(r?.endLine || r?.end_line || 0))),
        reason: r?.reason ? String(r.reason) : undefined,
      };
    })
    .filter((range) => range.startLine > 0 && range.endLine >= range.startLine);
}

function normalizeBidSections(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : [])
    .map((section, index) => {
      const s = section as Record<string, unknown>;
      const normalizedIndex = Number(s?.index || index + 1);
      const title = String(s?.title || '').trim();
      return {
        id: String(s?.id || `section-${normalizedIndex || index + 1}`).trim(),
        index: Number.isFinite(normalizedIndex) && normalizedIndex > 0 ? normalizedIndex : index + 1,
        unit: String(s?.unit || '标段').trim() || '标段',
        title,
        headLine: String(s?.headLine || s?.head_line || ''),
        description: String(s?.description || ''),
        includeRanges: normalizeBidSectionRanges(s?.includeRanges || s?.include_ranges),
        evidence: (Array.isArray(s?.evidence) ? s.evidence : [])
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      };
    })
    .filter((section) => (section as Record<string, unknown>).id && (section as Record<string, unknown>).title);
}

function normalizeGlobalFactId(value: unknown, index: number): string {
  const id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || `fact_${String(index + 1).padStart(3, '0')}`;
}

function normalizeGlobalFactGroups(groups: unknown): GlobalFactGroupState[] {
  const seen = new Set<string>();
  return (Array.isArray(groups) ? groups : [])
    .map((group, index) => {
      const g = group as Record<string, unknown>;
      const title = String(g?.title || '').trim();
      const content = String(g?.content || '').trim();
      if (!title || !content) return null;
      let id = normalizeGlobalFactId(g?.id || g?.group_id || title, index);
      let suffix = 2;
      while (seen.has(id)) {
        id = `${id}_${suffix}`;
        suffix += 1;
      }
      seen.add(id);
      return {
        id,
        title,
        content,
        updated_at: (g?.updated_at as string) || (g?.updatedAt as string) || now(),
      };
    })
    .filter(Boolean) as GlobalFactGroupState[];
}

const OUTLINE_SAVE_REASONS = new Set(['sort', 'edit', 'delete', 'add-root', 'add-child', 'replace']);
function normalizeOutlineSaveReason(value: unknown): string {
  return OUTLINE_SAVE_REASONS.has(value as string) ? (value as string) : 'replace';
}

function normalizeStringMap(value: unknown): Map<string, string> {
  const entries = value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>) : [];
  const map = new Map<string, string>();
  for (const [from, to] of entries) {
    const fromId = String(from || '').trim();
    const toId = String(to || '').trim();
    if (fromId && toId) map.set(fromId, toId);
  }
  return map;
}

function normalizeStringSet(value: unknown): Set<string> {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
}

function reverseIdMap(idMap: Map<string, string>): Map<string, string> {
  const reversed = new Map<string, string>();
  for (const [oldId, newId] of idMap.entries()) {
    reversed.set(newId, oldId);
  }
  return reversed;
}

function collectLeafItems(items?: OutlineItem[]): OutlineItem[] {
  return (items || []).flatMap((item) => (item?.children?.length ? collectLeafItems(item.children) : [item]));
}

// 扁平化大纲树为行（snake_case 内部键，对齐桌面 flattenOutlineItems:275-296）。
function flattenOutlineItems(items: OutlineItem[] | undefined, parentNodeId: string | null = null, level = 1): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  (items || []).forEach((item, index) => {
    const nodeId = String(item?.id || '').trim();
    if (!nodeId) return;
    rows.push({
      node_id: nodeId,
      parent_node_id: parentNodeId,
      sort_order: index,
      level,
      title: String(item?.title || '未命名章节').trim() || '未命名章节',
      description: String(item?.description || '').trim(),
      source_requirement_id: item?.source_requirement_id ? String(item.source_requirement_id) : null,
      source_requirement_title: item?.source_requirement_title ? String(item.source_requirement_title) : null,
      knowledge_item_ids: Array.isArray(item?.knowledge_item_ids) && item.knowledge_item_ids.length ? item.knowledge_item_ids : null,
      content: String(item?.content || ''),
      is_mirror: item?.isMirror === true,
      mirror_source_text: item?.mirrorSourceText ? String(item.mirrorSourceText) : null,
      outline_attribute: normalizeOutlineAttribute(item?.outlineAttribute),
      content_mode: normalizeOutlineContentMode(item?.contentMode),
      content_mode_note: item?.contentModeNote ? String(item.contentModeNote) : null,
    });
    if (item?.children?.length) {
      rows.push(...flattenOutlineItems(item.children, nodeId, level + 1));
    }
  });
  return rows;
}

function mapOutlineItems(items: OutlineItem[] | undefined, mapper: (item: OutlineItem) => OutlineItem): OutlineItem[] {
  return (items || []).map((item) => {
    const nextItem = mapper(item);
    if (item?.children?.length) {
      nextItem.children = mapOutlineItems(item.children, mapper);
    }
    return nextItem;
  });
}

function shouldClearSavedNode(opts: { clearAll: boolean; oldId: string; newId: string; affectedIds: Set<string> }): boolean {
  return opts.clearAll || opts.affectedIds.has(opts.oldId) || (!opts.oldId && opts.affectedIds.has(opts.newId));
}

function buildOutlineWithPersistedContent(
  outlineData: OutlineData | null | undefined,
  opts: { snapshot: { nodes: Record<string, { content: string }> }; reverseMap: Map<string, string>; affectedIds: Set<string>; clearAll: boolean },
): OutlineData | null | undefined {
  if (!outlineData?.outline?.length) return outlineData;
  return {
    ...outlineData,
    outline: mapOutlineItems(outlineData.outline, (item) => {
      const newId = String(item?.id || '').trim();
      const oldId = opts.reverseMap.get(newId) || newId;
      const clearContent = shouldClearSavedNode({ clearAll: opts.clearAll, oldId, newId, affectedIds: opts.affectedIds });
      const oldContent = opts.snapshot.nodes[oldId]?.content;
      return {
        ...item,
        content: clearContent ? '' : String(oldContent ?? item?.content ?? ''),
      };
    }),
  };
}

// ---- 文件名/合并/落盘助手（移植自 technicalPlanStore.cjs:93-107, 619-630） ----

function shortHash(input: string): string {
  return createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function safeFileNamePart(value: unknown): string {
  return String(value || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'file';
}

function createTenderSourceId(fileName: string, markdown: string, index: number): string {
  const hash = shortHash(`${fileName}\n${markdown}`).slice(0, 12);
  return `tender-${String(index + 1).padStart(2, '0')}-${hash}`;
}

function combineTenderMarkdown(markdowns: string[]): string {
  return markdowns.map((m) => String(m || '').trim()).filter(Boolean).join('\n\n');
}

// 原子写 markdown（temp + rename，对齐桌面 writeMarkdownFile:619-630）。
async function writeMarkdownFile(targetPath: string, markdown: string, prefix: string): Promise<void> {
  const targetDir = path.dirname(targetPath);
  await fs.mkdir(targetDir, { recursive: true });
  const tempPath = path.join(targetDir, `${prefix}-${Date.now()}.tmp.md`);
  await fs.writeFile(tempPath, `${String(markdown || '').trim()}\n`, 'utf-8');
  try {
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ---- store 工厂 ----

export function createTechnicalPlanStore(prisma: PrismaClient) {
  // ---- meta 单例 ----
  async function ensureMetaRow(projectId: number, client: Db = prisma) {
    const existing = await client.technicalPlanMeta.findUnique({ where: { projectId } });
    if (existing) return existing;
    const ts = now();
    return client.technicalPlanMeta.create({
      data: {
        projectId,
        workflowKind: 'technical-plan',
        step: 'document-analysis',
        bidAnalysisMode: 'key',
        outlineMode: 'aligned',
        outlineExpansionMode: 'ai-complement',
        mirrorProcurementEnabled: true,
        createdAt: ts,
        updatedAt: ts,
      },
    });
  }

  async function updateMeta(projectId: number, fields: Record<string, unknown>, client: Db = prisma): Promise<void> {
    await ensureMetaRow(projectId, client);
    const entries = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const data: Record<string, unknown> = Object.fromEntries(entries);
    data.updatedAt = now();
    await client.technicalPlanMeta.update({ where: { projectId }, data });
  }

  // ---- 装配助手 ----

  function taskFromRow(row: { taskId: string; type: string; status: string; progress: number; logsJson: unknown; startedAt: string; updatedAt: string; error: string | null; statsJson: unknown; pauseRequested: number }): BackgroundTaskState {
    const storedStats = readJson<any>(row.statsJson, undefined);
    const taskMeta = storedStats?._task_meta || {};
    return {
      task_id: row.taskId,
      type: row.type,
      status: normalizeStatus(row.status, ['running', 'pausing', 'paused', 'success', 'error'], 'running'),
      progress: Number(row.progress || 0),
      logs: readJson<string[]>(row.logsJson, []),
      started_at: row.startedAt,
      updated_at: row.updatedAt,
      error: row.error || undefined,
      stats: storedStats,
      pause_requested: fromDbBool(row.pauseRequested),
      diagnostic_trace_id: taskMeta.diagnostic_trace_id,
      degraded: taskMeta.degraded,
      reused: taskMeta.reused,
    };
  }

  async function loadTasks(projectId: number, client: Db = prisma): Promise<Record<string, BackgroundTaskState | undefined>> {
    const rows = await client.technicalPlanTask.findMany({ where: { projectId } });
    const tasks: Record<string, BackgroundTaskState | undefined> = {};
    for (const row of rows) {
      const field = TASK_TYPE_FIELDS[row.type];
      if (field) tasks[field] = taskFromRow(row);
    }
    return tasks;
  }

  async function loadBidItems(projectId: number, client: Db = prisma): Promise<Record<string, BidAnalysisTaskState>> {
    const rows = await client.technicalPlanBidItem.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { itemId: 'asc' }],
    });
    const acc: Record<string, BidAnalysisTaskState> = {};
    for (const row of rows) {
      acc[row.itemId] = {
        id: row.itemId,
        label: row.label,
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: row.content || '',
        error: row.error || undefined,
      };
    }
    return acc;
  }

  async function loadOutlineData(projectId: number, meta: { outlineProjectName: string | null; outlineProjectOverview: string | null }, client: Db = prisma): Promise<OutlineData | null> {
    const rows = await client.technicalPlanOutlineNode.findMany({
      where: { projectId },
      orderBy: [{ level: 'asc' }, { parentNodeId: 'asc' }, { sortOrder: 'asc' }],
    });
    if (!rows.length) return null;
    const map = new Map<string, OutlineItem>();
    for (const row of rows) {
      map.set(row.nodeId, {
        id: row.nodeId,
        title: row.title,
        description: row.description || '',
        source_requirement_id: row.sourceRequirementId || undefined,
        source_requirement_title: row.sourceRequirementTitle || undefined,
        knowledge_item_ids: readJson<string[] | undefined>(row.knowledgeItemIdsJson, undefined),
        content: row.content || '',
        isMirror: row.isMirror === true,
        mirrorSourceText: row.mirrorSourceText || undefined,
        outlineAttribute: normalizeOutlineAttribute(row.outlineAttribute),
        contentMode: normalizeOutlineContentMode(row.contentMode),
        contentModeNote: row.contentModeNote || undefined,
        children: [],
      });
    }
    const roots: OutlineItem[] = [];
    for (const row of rows) {
      const item = map.get(row.nodeId);
      if (!item) continue;
      if (row.parentNodeId && map.has(row.parentNodeId)) {
        map.get(row.parentNodeId)!.children!.push(item);
      } else {
        roots.push(item);
      }
    }
    function cleanup(item: OutlineItem): OutlineItem {
      if (!item.children!.length) {
        delete item.children;
      } else {
        item.children!.forEach(cleanup);
      }
      if (!item.knowledge_item_ids?.length) delete item.knowledge_item_ids;
      if (!item.content) delete item.content;
      return item;
    }
    return {
      outline: roots.map(cleanup),
      project_name: meta.outlineProjectName || undefined,
      project_overview: meta.outlineProjectOverview || undefined,
      word_control_options: readJson<Record<string, unknown> | undefined>(meta.outlineWordControlOptionsJson, undefined),
      word_control_snapshot: readJson<Record<string, unknown> | undefined>(meta.outlineWordControlSnapshotJson, undefined),
    };
  }

  async function loadContentSections(projectId: number, outlineData: OutlineData | null, client: Db = prisma): Promise<Record<string, ContentGenerationSectionState>> {
    const sections = await client.technicalPlanContentSection.findMany({ where: { projectId } });
    const nodes = await client.technicalPlanOutlineNode.findMany({ where: { projectId }, select: { nodeId: true, title: true, content: true } });
    const nodeMap = new Map(nodes.map((n) => [n.nodeId, n]));
    const result: Record<string, ContentGenerationSectionState> = {};
    for (const row of sections) {
      const node = nodeMap.get(row.nodeId);
      if (!node) continue; // 孤立行（节点已删）→ 跳过，对齐桌面 INNER JOIN 语义
      result[row.nodeId] = {
        id: row.nodeId,
        title: node.title || '未命名章节',
        status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: node.content || '',
        error: row.error || undefined,
        updated_at: row.updatedAt || undefined,
      };
    }
    for (const item of collectLeafItems(outlineData?.outline || [])) {
      if (!result[item.id] && item.content?.trim()) {
        result[item.id] = {
          id: item.id,
          title: item.title || '未命名章节',
          status: 'success',
          content: item.content,
        };
      }
    }
    return result;
  }

  async function loadContentPlans(projectId: number, client: Db = prisma): Promise<Record<string, ContentGenerationPlanState>> {
    const rows = await client.technicalPlanContentPlan.findMany({ where: { projectId } });
    const acc: Record<string, ContentGenerationPlanState> = {};
    for (const row of rows) {
      const stored = readJson<{ plan_version?: number; plan?: unknown; table_requirement?: string } | null>(row.planJson, null);
      if (stored?.plan && Number(stored.plan_version) > 0) {
        acc[row.nodeId] = {
          plan_version: Number(stored.plan_version),
          plan: stored.plan,
          ...(stored.table_requirement ? { table_requirement: stored.table_requirement } : {}),
          updated_at: row.updatedAt || undefined,
        };
      }
    }
    return acc;
  }

  async function loadGlobalFacts(projectId: number, client: Db = prisma): Promise<GlobalFactGroupState[]> {
    const rows = await client.technicalPlanGlobalFactGroup.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { groupId: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.groupId,
      title: row.title,
      content: row.content || '',
      updated_at: row.updatedAt || undefined,
    }));
  }

  async function loadReferenceDocumentIds(projectId: number, client: Db = prisma): Promise<string[]> {
    const rows = await client.technicalPlanReferenceDoc.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }],
    });
    return rows.map((r) => r.documentId);
  }

  function loadTenderSourceFiles(meta: { tenderFilesJson: unknown; tenderMarkdownPath: string | null; tenderFileName: string | null; tenderMarkdownChars: number; tenderMarkdownHash: string | null; tenderParserLabel: string | null; tenderImportedAt: string | null; updatedAt: string }): Record<string, unknown>[] {
    const sourceFiles = readJson<Record<string, unknown>[]>(meta.tenderFilesJson, []);
    if (Array.isArray(sourceFiles) && sourceFiles.length) {
      return sourceFiles
        .map((file) => ({
          id: String(file?.id || ''),
          fileName: String(file?.fileName || '招标文件'),
          markdownPath: String(file?.markdownPath || ''),
          markdownChars: Number(file?.markdownChars || 0),
          contentHash: String(file?.contentHash || ''),
          parserLabel: file?.parserLabel ? String(file.parserLabel) : undefined,
          importedAt: file?.importedAt ? String(file.importedAt) : undefined,
          updatedAt: file?.updatedAt ? String(file.updatedAt) : meta.updatedAt,
        }))
        .filter((f) => f.id && f.markdownPath);
    }
    if (meta.tenderMarkdownPath) {
      return [
        {
          id: 'tender-legacy-01',
          fileName: meta.tenderFileName || '技术方案招标文件',
          markdownPath: meta.tenderMarkdownPath,
          markdownChars: Number(meta.tenderMarkdownChars || 0),
          contentHash: meta.tenderMarkdownHash || '',
          parserLabel: meta.tenderParserLabel || undefined,
          importedAt: meta.tenderImportedAt || undefined,
          updatedAt: meta.updatedAt,
        },
      ];
    }
    return [];
  }

  // ---- 完整状态装配（technicalPlanStore.cjs:1386-1457，跳过 markdown FS 读取） ----
  async function loadTechnicalPlan(projectId: number): Promise<TechnicalPlanState> {
    const meta = await ensureMetaRow(projectId);
    const bidAnalysisMode = isValidBidMode(meta.bidAnalysisMode) ? meta.bidAnalysisMode : 'key';
    const bidAnalysisSelectedTaskIds = getBidAnalysisTaskIdsForConfig(bidAnalysisMode, readJson(meta.bidAnalysisSelectedTaskIdsJson, []));
    const bidAnalysisTasks = await loadBidItems(projectId);
    const outlineData = await loadOutlineData(projectId, meta);
    const tasks = await loadTasks(projectId);
    const bidSections = normalizeBidSections(readJson(meta.bidSectionsJson, []));
    const bidSectionExtractionTask = tasks.bidSectionExtractionTask;
    const tenderFiles = loadTenderSourceFiles(meta);
    const tenderFile = meta.tenderMarkdownPath
      ? {
          fileName: meta.tenderFileName || '技术方案招标文件',
          markdownPath: meta.tenderMarkdownPath,
          markdownChars: Number(meta.tenderMarkdownChars || 0),
          contentHash: meta.tenderMarkdownHash || '',
          originalMarkdownPath: meta.tenderOriginalMarkdownPath || meta.tenderMarkdownPath,
          originalMarkdownChars: Number(meta.tenderOriginalMarkdownChars || meta.tenderMarkdownChars || 0),
          originalContentHash: meta.tenderOriginalMarkdownHash || meta.tenderMarkdownHash || '',
          parserLabel: meta.tenderParserLabel || undefined,
          importedAt: meta.tenderImportedAt || undefined,
          selectedSectionId: meta.selectedSectionId || undefined,
          selectedSectionTitle: meta.selectedSectionTitle || undefined,
          updatedAt: meta.updatedAt,
        }
      : null;
    const originalPlanFile = meta.originalPlanMarkdownPath
      ? {
          fileName: meta.originalPlanFileName || '原方案',
          markdownPath: meta.originalPlanMarkdownPath,
          markdownChars: Number(meta.originalPlanMarkdownChars || 0),
          contentHash: meta.originalPlanMarkdownHash || '',
          parserLabel: meta.originalPlanParserLabel || undefined,
          importedAt: meta.originalPlanImportedAt || undefined,
          updatedAt: meta.updatedAt,
        }
      : null;

    return {
      ...INITIAL_STATE,
      workflowKind: normalizeWorkflowKind(meta.workflowKind),
      step: isValidStep(meta.step) ? meta.step : 'document-analysis',
      tenderFile,
      tenderFiles,
      originalPlanFile,
      projectOverview: bidAnalysisTasks.projectOverview?.status === 'success' ? bidAnalysisTasks.projectOverview.content : '',
      techRequirements: bidAnalysisTasks.techRequirements?.status === 'success' ? bidAnalysisTasks.techRequirements.content : '',
      bidAnalysisMode,
      bidAnalysisSelectedTaskIds,
      bidAnalysisTasks,
      bidAnalysisProgress: calculateBidProgress(bidAnalysisMode, bidAnalysisTasks, bidAnalysisSelectedTaskIds),
      bidSectionMode: normalizeBidSectionMode(meta.bidSectionMode),
      bidSections,
      bidSectionExtractionStatus: bidSectionExtractionTask?.status
        ? normalizeBidSectionExtractionStatus(bidSectionExtractionTask.status)
        : normalizeBidSectionExtractionStatus(meta.bidSectionExtractionStatus),
      bidSectionExtractionError: bidSectionExtractionTask?.error || meta.bidSectionExtractionError || undefined,
      outlineMode: isValidOutlineMode(meta.outlineMode) ? meta.outlineMode : 'aligned',
      outlineExpansionMode: isValidOutlineExpansionMode(meta.outlineExpansionMode) ? meta.outlineExpansionMode : 'ai-complement',
      mirrorProcurementEnabled: meta.mirrorProcurementEnabled !== false,
      outlineWordControlOptions: readJson<Record<string, unknown> | undefined>(meta.outlineWordControlOptionsJson, undefined),
      outlineWordControlSnapshot: readJson<Record<string, unknown> | undefined>(meta.outlineWordControlSnapshotJson, undefined),
      referenceKnowledgeDocumentIds: await loadReferenceDocumentIds(projectId),
      ...tasks,
      globalFacts: await loadGlobalFacts(projectId),
      contentGenerationOptions: readJson(meta.contentGenerationOptionsJson, undefined),
      contentGenerationRuntime: readJson(meta.contentGenerationRuntimeJson, undefined),
      contentIllustrationPlan: readJson(meta.contentIllustrationPlanJson, undefined),
      contentGenerationSections: await loadContentSections(projectId, outlineData),
      contentGenerationPlans: await loadContentPlans(projectId),
      outlineData,
    };
  }

  // ---- 守卫 ----
  async function assertNoTechnicalPlanTaskRunning(projectId: number, client: Db): Promise<void> {
    const row = await client.technicalPlanTask.findFirst({
      where: { projectId, status: { in: ['running', 'pausing'] } },
      select: { type: true },
    });
    if (row) throw new Error('当前有技术方案任务正在运行，请等待任务结束后再切换模式');
  }

  async function assertContentEditingAllowed(projectId: number, client: Db): Promise<void> {
    const row = await client.technicalPlanTask.findFirst({
      where: { projectId, type: 'content-generation', status: { in: ['running', 'pausing', 'paused'] } },
      select: { status: true },
    });
    if (row) throw new Error('当前正文生成任务正在运行或已暂停，请先完成任务再编辑正文');
  }

  async function assertOutlineMutationAllowed(projectId: number, client: Db): Promise<void> {
    const task = await client.technicalPlanTask.findFirst({
      where: { projectId, type: 'content-generation' },
      select: { status: true },
    });
    if (task && ['running', 'pausing', 'paused'].includes(task.status)) {
      throw new Error('正文生成任务正在运行或暂停中，请结束后再调整目录');
    }
  }

  // ---- 子表写入助手 ----

  async function saveTask(projectId: number, type: string, task: Partial<BackgroundTaskState> | undefined, client: Db): Promise<void> {
    if (!task) {
      await client.technicalPlanTask.deleteMany({ where: { projectId, type } });
      if (type === 'bid-section-extraction') {
        await updateMeta(projectId, { bidSectionExtractionStatus: 'idle', bidSectionExtractionError: null }, client);
      }
      return;
    }
    const ts = now();
    const data = {
      taskId: String(task.task_id || ''),
      status: String(task.status || 'running'),
      progress: Math.max(0, Math.min(100, Math.round(Number(task.progress || 0)))),
      logsJson: Array.isArray(task.logs) ? task.logs : [],
      statsJson: jsonOrNull({
        ...((task.stats && typeof task.stats === 'object') ? task.stats as Record<string, unknown> : {}),
        _task_meta: {
          diagnostic_trace_id: task.diagnostic_trace_id,
          degraded: Boolean(task.degraded),
          reused: Boolean(task.reused),
        },
      }),
      error: task.error ? String(task.error) : null,
      pauseRequested: toDbBool(task.pause_requested),
      startedAt: task.started_at || ts,
      updatedAt: task.updated_at || ts,
    };
    await client.technicalPlanTask.upsert({
      where: { projectId_type: { projectId, type } },
      create: { projectId, type, ...data },
      update: data,
    });
    if (type === 'bid-section-extraction') {
      await updateMeta(
        projectId,
        {
          bidSectionExtractionStatus: normalizeBidSectionExtractionStatus(task.status),
          bidSectionExtractionError: task.error ? String(task.error) : null,
        },
        client,
      );
    }
  }

  async function saveBidItems(projectId: number, tasks: Record<string, Partial<BidAnalysisTaskState>> | undefined, _mode: string, client: Db): Promise<void> {
    const entries = Object.entries(tasks || {});
    if (!entries.length) {
      await client.technicalPlanBidItem.deleteMany({ where: { projectId } });
      return;
    }
    const ts = now();
    for (const [itemId, task] of entries) {
      const data = {
        label: getBidItemLabel(itemId, task?.label),
        status: normalizeStatus(task?.status, ['idle', 'running', 'success', 'error'], 'idle'),
        content: String(task?.content || ''),
        error: task?.error ? String(task.error) : null,
        sortOrder: getBidItemSortOrder(itemId),
        updatedAt: (task as Record<string, unknown>)?.updated_at ? String((task as Record<string, unknown>).updated_at) : ts,
      };
      await client.technicalPlanBidItem.upsert({
        where: { projectId_itemId: { projectId, itemId } },
        create: { projectId, itemId, ...data },
        update: data,
      });
    }
  }

  async function upsertDerivedBidItem(projectId: number, itemId: string, content: unknown, _mode: string, client: Db): Promise<void> {
    const label = getBidItemLabel(itemId);
    const value = String(content || '');
    const data = {
      label,
      status: value.trim() ? 'success' : 'idle',
      content: value,
      error: null,
      sortOrder: getBidItemSortOrder(itemId),
      updatedAt: now(),
    };
    await client.technicalPlanBidItem.upsert({
      where: { projectId_itemId: { projectId, itemId } },
      create: { projectId, itemId, ...data },
      update: data,
    });
  }

  async function replaceReferenceDocumentIds(projectId: number, documentIds: unknown, client: Db): Promise<void> {
    await client.technicalPlanReferenceDoc.deleteMany({ where: { projectId } });
    const ids = [...new Set((Array.isArray(documentIds) ? documentIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    for (let index = 0; index < ids.length; index++) {
      await client.technicalPlanReferenceDoc.create({
        data: { projectId, documentId: ids[index], sortOrder: index },
      });
    }
  }

  async function replaceGlobalFacts(projectId: number, groups: unknown, client: Db): Promise<void> {
    const normalized = normalizeGlobalFactGroups(groups);
    await client.technicalPlanGlobalFactGroup.deleteMany({ where: { projectId } });
    if (!normalized.length) return;
    const ts = now();
    for (let index = 0; index < normalized.length; index++) {
      const g = normalized[index];
      await client.technicalPlanGlobalFactGroup.create({
        data: {
          projectId,
          groupId: g.id,
          title: g.title,
          content: g.content,
          sortOrder: index,
          createdAt: ts,
          updatedAt: g.updated_at || ts,
        },
      });
    }
  }

  async function saveOutlineData(projectId: number, outlineData: OutlineData | null | undefined, client: Db): Promise<void> {
    if (!outlineData?.outline?.length) {
      await client.technicalPlanOutlineNode.deleteMany({ where: { projectId } });
      await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
      await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
      await updateMeta(projectId, { outlineProjectName: null, outlineProjectOverview: null }, client);
      return;
    }
    const rows = flattenOutlineItems(outlineData.outline);
    const nextIds = new Set(rows.map((r) => r.node_id as string));
    const ts = now();
    // 批量全量重写：本用户大纲节点先全删再一次 createMany。
    // ContentSection/Plan 的 nodeId 是普通字符串列（无 DB 外键，应用层 INNER JOIN），全删不违反外键。
    // 把原先 N 次逐行 upsert 压成 2 次查询，避免大目录 + 高并发下顶破交互事务超时。
    await client.technicalPlanOutlineNode.deleteMany({ where: { projectId } });
    if (rows.length) {
      await client.technicalPlanOutlineNode.createMany({
        data: rows.map((row) => ({
          projectId,
          nodeId: row.node_id as string,
          createdAt: ts,
          parentNodeId: (row.parent_node_id as string | null) ?? null,
          sortOrder: row.sort_order as number,
          level: row.level as number,
          title: row.title as string,
          description: (row.description as string) || '',
          sourceRequirementId: (row.source_requirement_id as string | null) ?? null,
          sourceRequirementTitle: (row.source_requirement_title as string | null) ?? null,
          knowledgeItemIdsJson: Array.isArray(row.knowledge_item_ids) && (row.knowledge_item_ids as string[]).length ? (row.knowledge_item_ids as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          content: String(row.content ?? ''),
          isMirror: row.is_mirror === true,
          mirrorSourceText: (row.mirror_source_text as string | null) ?? null,
          outlineAttribute: row.outline_attribute as string,
          contentMode: row.content_mode as string,
          contentModeNote: (row.content_mode_note as string | null) ?? null,
          updatedAt: ts,
        })),
      });
    }
    // 清理孤立章节状态/计划（节点已不存在），避免幽灵行（桌面靠 INNER JOIN 隐式排除）。
    const nextIdList = [...nextIds];
    await client.technicalPlanContentSection.deleteMany({ where: { projectId, nodeId: { notIn: nextIdList } } });
    await client.technicalPlanContentPlan.deleteMany({ where: { projectId, nodeId: { notIn: nextIdList } } });
    await updateMeta(
      projectId,
      {
        outlineProjectName: outlineData.project_name || null,
        outlineProjectOverview: outlineData.project_overview || null,
      },
      client,
    );
  }

  async function saveContentSections(projectId: number, sections: Record<string, Partial<ContentGenerationSectionState> & { content?: string }> | undefined, client: Db): Promise<void> {
    const entries = Object.entries(sections || {});
    if (!entries.length) {
      await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
      return;
    }
    const ts = now();
    // 批量全量重写 section 行（deleteMany + createMany），把原先 N 次逐行 upsert 压成 2 次查询，
    // 与 saveOutlineData 同模式；孤立行（不在本次快照内）随 deleteMany 自然清除。
    await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
    await client.technicalPlanContentSection.createMany({
      data: entries.map(([nodeId, section]) => ({
        projectId,
        nodeId,
        status: normalizeStatus(section?.status, ['idle', 'running', 'success', 'error'], 'idle'),
        error: section?.error ? String(section.error) : null,
        updatedAt: section?.updated_at || ts,
      })),
    });
    // 正文回写到 outlineNode.content：仅同步含 content 字段的项（单列更新，量小且节流 flush 已串行）。
    for (const [nodeId, section] of entries) {
      if (hasOwn(section, 'content')) {
        await client.technicalPlanOutlineNode.updateMany({
          where: { projectId, nodeId },
          data: { content: String(section.content || ''), updatedAt: ts },
        });
      }
    }
  }

  async function saveContentPlans(projectId: number, plans: Record<string, Partial<ContentGenerationPlanState>> | undefined, client: Db): Promise<void> {
    const entries = Object.entries(plans || {}).filter(([, v]) => v?.plan && Number(v.plan_version) > 0);
    if (!entries.length) {
      await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
      return;
    }
    const ts = now();
    // 批量全量重写：与 saveOutlineData 同模式（deleteMany + createMany），把原先 N 次逐行 upsert 压成 2 次查询，
    // 避免大目录下 planOne 节流 flush 单事务内数百次 upsert 顶破交互事务超时。
    await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
    await client.technicalPlanContentPlan.createMany({
      data: entries.map(([nodeId, value]) => ({
        projectId,
        nodeId,
        planJson: {
          plan_version: Number(value.plan_version),
          plan: value.plan as unknown as Prisma.InputJsonValue,
          ...(value.table_requirement ? { table_requirement: value.table_requirement } : {}),
        } as unknown as Prisma.InputJsonValue,
        updatedAt: value.updated_at || ts,
      })),
    });
  }

  async function loadOutlinePersistenceSnapshot(projectId: number, client: Db) {
    const nodes = await client.technicalPlanOutlineNode.findMany({
      where: { projectId },
      select: { nodeId: true, content: true },
    });
    const sections = await client.technicalPlanContentSection.findMany({
      where: { projectId },
      select: { nodeId: true, status: true, error: true, updatedAt: true },
    });
    const plans = await client.technicalPlanContentPlan.findMany({
      where: { projectId },
      select: { nodeId: true, planJson: true, updatedAt: true },
    });
    return {
      nodes: Object.fromEntries(nodes.map((n) => [n.nodeId, { content: n.content || '' }])) as Record<string, { content: string }>,
      sections,
      plans,
    };
  }

  async function restoreMappedContentRows(
    projectId: number,
    opts: {
      snapshot: { sections: Array<{ nodeId: string; status: string; error: string | null; updatedAt: string }>; plans: Array<{ nodeId: string; planJson: unknown; updatedAt: string }> };
      idMap: Map<string, string>;
      affectedIds: Set<string>;
      nextIds: Set<string>;
      clearAll: boolean;
    },
    client: Db,
  ): Promise<void> {
    await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
    await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
    if (opts.clearAll || !opts.nextIds.size) return;
    const ts = now();
    const seenSections = new Set<string>();
    for (const row of opts.snapshot.sections) {
      const oldId = String(row.nodeId || '').trim();
      const newId = opts.idMap.get(oldId) || oldId;
      if (!newId || !opts.nextIds.has(newId) || seenSections.has(newId)) continue;
      if (shouldClearSavedNode({ clearAll: opts.clearAll, oldId, newId, affectedIds: opts.affectedIds })) continue;
      seenSections.add(newId);
      await client.technicalPlanContentSection.create({
        data: {
          projectId,
          nodeId: newId,
          status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
          error: row.error || null,
          updatedAt: row.updatedAt || ts,
        },
      });
    }
    const seenPlans = new Set<string>();
    for (const row of opts.snapshot.plans) {
      const oldId = String(row.nodeId || '').trim();
      const newId = opts.idMap.get(oldId) || oldId;
      if (!newId || !opts.nextIds.has(newId) || seenPlans.has(newId)) continue;
      if (shouldClearSavedNode({ clearAll: opts.clearAll, oldId, newId, affectedIds: opts.affectedIds })) continue;
      if (!row.planJson) continue;
      seenPlans.add(newId);
      await client.technicalPlanContentPlan.create({
        data: { projectId, nodeId: newId, planJson: row.planJson as unknown as Prisma.InputJsonValue, updatedAt: row.updatedAt || ts },
      });
    }
  }

  // ---- 级联清理 ----

  async function clearContentGenerationState(projectId: number, client: Db): Promise<void> {
    const ts = now();
    await client.technicalPlanOutlineNode.updateMany({ where: { projectId }, data: { content: '', updatedAt: ts } });
    await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
    await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
    await client.technicalPlanTask.deleteMany({ where: { projectId, type: 'content-generation' } });
    await updateMeta(projectId, { contentGenerationRuntimeJson: null, contentIllustrationPlanJson: null }, client);
  }

  async function clearDownstreamFromTender(projectId: number, client: Db): Promise<void> {
    await client.technicalPlanTask.deleteMany({ where: { projectId } });
    await client.technicalPlanBidItem.deleteMany({ where: { projectId } });
    await client.technicalPlanReferenceDoc.deleteMany({ where: { projectId } });
    await client.technicalPlanOutlineNode.deleteMany({ where: { projectId } });
    await client.technicalPlanGlobalFactGroup.deleteMany({ where: { projectId } });
    await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
    await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
    await updateMeta(
      projectId,
      {
        step: 'document-analysis',
        bidAnalysisMode: 'key',
        bidAnalysisSelectedTaskIdsJson: null,
        outlineMode: 'aligned',
        outlineExpansionMode: 'ai-complement',
        mirrorProcurementEnabled: true,
        outlineProjectName: null,
        outlineProjectOverview: null,
        contentGenerationOptionsJson: null,
        contentGenerationRuntimeJson: null,
        contentIllustrationPlanJson: null,
        pendingTenderMarkdownPath: null,
        pendingTenderFileName: null,
        pendingTenderParserLabel: null,
        pendingTenderSectionsJson: null,
        pendingTenderTotalDeclared: null,
        bidSectionMode: 'single',
        bidSectionsJson: null,
        bidSectionExtractionStatus: 'idle',
        bidSectionExtractionError: null,
        selectedSectionId: null,
        selectedSectionTitle: null,
      },
      client,
    );
  }

  async function clearDownstreamFromBidSectionChange(projectId: number, client: Db): Promise<void> {
    await client.technicalPlanTask.deleteMany({ where: { projectId } });
    await client.technicalPlanBidItem.deleteMany({ where: { projectId } });
    await client.technicalPlanReferenceDoc.deleteMany({ where: { projectId } });
    await client.technicalPlanOutlineNode.deleteMany({ where: { projectId } });
    await client.technicalPlanGlobalFactGroup.deleteMany({ where: { projectId } });
    await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
    await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
    await updateMeta(
      projectId,
      {
        step: 'bid-analysis',
        contentGenerationOptionsJson: null,
        contentGenerationRuntimeJson: null,
        contentIllustrationPlanJson: null,
        outlineProjectName: null,
        outlineProjectOverview: null,
      },
      client,
    );
  }

  async function clearDownstreamFromOriginalPlan(projectId: number, client: Db): Promise<void> {
    await client.technicalPlanTask.deleteMany({
      where: { projectId, type: { in: ['outline-generation', 'global-facts-generation', 'content-generation'] } },
    });
    await client.technicalPlanOutlineNode.deleteMany({ where: { projectId } });
    await client.technicalPlanGlobalFactGroup.deleteMany({ where: { projectId } });
    await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
    await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
    await updateMeta(
      projectId,
      {
        step: 'document-analysis',
        outlineProjectName: null,
        outlineProjectOverview: null,
        contentGenerationRuntimeJson: null,
        contentIllustrationPlanJson: null,
      },
      client,
    );
  }

  async function clearWorkflowSpecificState(projectId: number, workflowKind: string, client: Db): Promise<void> {
    await client.technicalPlanTask.deleteMany({
      where: { projectId, type: { in: ['outline-generation', 'global-facts-generation', 'content-generation'] } },
    });
    await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
    await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
    await client.technicalPlanOutlineNode.deleteMany({ where: { projectId } });
    await client.technicalPlanGlobalFactGroup.deleteMany({ where: { projectId } });
    await updateMeta(
      projectId,
      {
        workflowKind: normalizeWorkflowKind(workflowKind),
        step: 'document-analysis',
        outlineExpansionMode: 'ai-complement',
        mirrorProcurementEnabled: true,
        originalPlanFileName: null,
        originalPlanMarkdownPath: null,
        originalPlanMarkdownHash: null,
        originalPlanMarkdownChars: 0,
        originalPlanParserLabel: null,
        originalPlanImportedAt: null,
        outlineProjectName: null,
        outlineProjectOverview: null,
        contentGenerationOptionsJson: null,
        contentGenerationRuntimeJson: null,
        contentIllustrationPlanJson: null,
      },
      client,
    );
  }

  // ---- 通用 partial 应用器（technicalPlanStore.cjs:1339-1384） ----
  async function applyPartial(projectId: number, partial: Record<string, unknown>, client: Db): Promise<void> {
    const meta = await ensureMetaRow(projectId, client);
    const metaUpdates: Record<string, unknown> = {};

    if (hasOwn(partial, 'workflowKind')) metaUpdates.workflowKind = normalizeWorkflowKind(partial.workflowKind);
    if (hasOwn(partial, 'step') && isValidStep(partial.step)) metaUpdates.step = partial.step;
    if (hasOwn(partial, 'bidAnalysisMode') && isValidBidMode(partial.bidAnalysisMode)) metaUpdates.bidAnalysisMode = partial.bidAnalysisMode;
    if (hasOwn(partial, 'bidAnalysisSelectedTaskIds')) metaUpdates.bidAnalysisSelectedTaskIdsJson = jsonOrNull(normalizeBidAnalysisTaskIds(partial.bidAnalysisSelectedTaskIds));
    if (hasOwn(partial, 'bidSectionMode')) metaUpdates.bidSectionMode = normalizeBidSectionMode(partial.bidSectionMode);
    if (hasOwn(partial, 'bidSections')) metaUpdates.bidSectionsJson = jsonOrNull(normalizeBidSections(partial.bidSections));
    if (hasOwn(partial, 'bidSectionExtractionStatus')) metaUpdates.bidSectionExtractionStatus = normalizeBidSectionExtractionStatus(partial.bidSectionExtractionStatus);
    if (hasOwn(partial, 'bidSectionExtractionError')) metaUpdates.bidSectionExtractionError = partial.bidSectionExtractionError ? String(partial.bidSectionExtractionError) : null;
    if (hasOwn(partial, 'outlineMode') && isValidOutlineMode(partial.outlineMode)) metaUpdates.outlineMode = partial.outlineMode;
    if (hasOwn(partial, 'outlineExpansionMode') && isValidOutlineExpansionMode(partial.outlineExpansionMode)) metaUpdates.outlineExpansionMode = partial.outlineExpansionMode;
    if (hasOwn(partial, 'mirrorProcurementEnabled')) metaUpdates.mirrorProcurementEnabled = partial.mirrorProcurementEnabled === true;
    if (hasOwn(partial, 'outlineWordControlOptions')) metaUpdates.outlineWordControlOptionsJson = jsonOrNull(partial.outlineWordControlOptions);
    if (hasOwn(partial, 'outlineWordControlSnapshot')) metaUpdates.outlineWordControlSnapshotJson = jsonOrNull(partial.outlineWordControlSnapshot);
    if (hasOwn(partial, 'contentGenerationOptions')) metaUpdates.contentGenerationOptionsJson = jsonOrNull(partial.contentGenerationOptions);
    if (hasOwn(partial, 'contentGenerationRuntime')) metaUpdates.contentGenerationRuntimeJson = jsonOrNull(partial.contentGenerationRuntime);
    if (hasOwn(partial, 'contentIllustrationPlan')) metaUpdates.contentIllustrationPlanJson = jsonOrNull(partial.contentIllustrationPlan);

    if (Object.keys(metaUpdates).length) await updateMeta(projectId, metaUpdates, client);

    const nextBidMode = isValidBidMode(partial.bidAnalysisMode) ? partial.bidAnalysisMode : meta.bidAnalysisMode;
    if (hasOwn(partial, 'referenceKnowledgeDocumentIds')) await replaceReferenceDocumentIds(projectId, partial.referenceKnowledgeDocumentIds, client);
    if (hasOwn(partial, 'bidAnalysisTasks')) await saveBidItems(projectId, partial.bidAnalysisTasks as Record<string, Partial<BidAnalysisTaskState>>, nextBidMode, client);
    if (hasOwn(partial, 'projectOverview')) await upsertDerivedBidItem(projectId, 'projectOverview', partial.projectOverview, nextBidMode, client);
    if (hasOwn(partial, 'techRequirements')) await upsertDerivedBidItem(projectId, 'techRequirements', partial.techRequirements, nextBidMode, client);
    if (hasOwn(partial, 'globalFacts')) {
      await replaceGlobalFacts(projectId, partial.globalFacts, client);
      await clearContentGenerationState(projectId, client);
    }

    for (const [field, type] of Object.entries(TASK_FIELD_TYPES)) {
      if (hasOwn(partial, field)) await saveTask(projectId, type, partial[field] as Partial<BackgroundTaskState> | undefined, client);
    }

    if (hasOwn(partial, 'outlineData')) {
      if (partial.outlineData === null) {
        await client.technicalPlanOutlineNode.deleteMany({ where: { projectId } });
        await client.technicalPlanContentSection.deleteMany({ where: { projectId } });
        await client.technicalPlanContentPlan.deleteMany({ where: { projectId } });
        await updateMeta(projectId, { outlineProjectName: null, outlineProjectOverview: null }, client);
      } else {
        await saveOutlineData(projectId, partial.outlineData as OutlineData, client);
      }
    }

    if (hasOwn(partial, 'contentGenerationSections')) await saveContentSections(projectId, partial.contentGenerationSections as Record<string, Partial<ContentGenerationSectionState>>, client);
    if (hasOwn(partial, 'contentGenerationPlans')) await saveContentPlans(projectId, partial.contentGenerationPlans as Record<string, Partial<ContentGenerationPlanState>>, client);
  }

  async function updateTechnicalPlan(projectId: number, partial: Record<string, unknown>): Promise<TechnicalPlanState> {
    await prisma.$transaction(async (tx) => {
      await applyPartial(projectId, partial || {}, tx);
    });
    return loadTechnicalPlan(projectId);
  }

  // ---- 公开写入方法 ----

  async function updateStep(projectId: number, step: unknown): Promise<TechnicalPlanState> {
    return updateTechnicalPlan(projectId, { step });
  }

  async function setWorkflowKind(projectId: number, workflowKind: unknown): Promise<TechnicalPlanState> {
    return updateTechnicalPlan(projectId, { workflowKind: normalizeWorkflowKind(workflowKind) });
  }

  async function switchWorkflowKind(projectId: number, workflowKind: unknown): Promise<TechnicalPlanState> {
    const nextWorkflowKind = normalizeWorkflowKind(workflowKind);
    const meta = await ensureMetaRow(projectId);
    if (normalizeWorkflowKind(meta.workflowKind) === nextWorkflowKind) {
      return loadTechnicalPlan(projectId);
    }
    await prisma.$transaction(async (tx) => {
      await assertNoTechnicalPlanTaskRunning(projectId, tx);
      await clearWorkflowSpecificState(projectId, nextWorkflowKind, tx);
    });
    // FS 删 original-plan.md 跳过（P4）
    return loadTechnicalPlan(projectId);
  }

  async function saveBidAnalysisConfig(
    projectId: number,
    payload: { mode?: unknown; selectedTaskIds?: unknown; bidSectionMode?: unknown } | undefined,
  ): Promise<TechnicalPlanState> {
    const { mode, selectedTaskIds, bidSectionMode } = payload || {};
    const config = normalizeBidAnalysisConfig(mode, selectedTaskIds);
    const nextSectionMode = bidSectionMode === undefined ? null : normalizeBidSectionMode(bidSectionMode);
    const meta = await ensureMetaRow(projectId);
    const shouldChangeSectionMode = nextSectionMode && nextSectionMode !== normalizeBidSectionMode(meta.bidSectionMode);
    if (!shouldChangeSectionMode) {
      return updateTechnicalPlan(projectId, {
        bidAnalysisMode: config.mode,
        bidAnalysisSelectedTaskIds: config.selectedTaskIds,
      });
    }
    await prisma.$transaction(async (tx) => {
      // resetTenderWorkingCopyToOriginal 跳过（FS，P4）
      await clearDownstreamFromBidSectionChange(projectId, tx);
      await updateMeta(
        projectId,
        {
          bidAnalysisMode: config.mode,
          bidAnalysisSelectedTaskIdsJson: jsonOrNull(config.selectedTaskIds),
          bidSectionMode: nextSectionMode,
          bidSectionsJson: null,
          bidSectionExtractionStatus: 'idle',
          bidSectionExtractionError: null,
          selectedSectionId: null,
          selectedSectionTitle: null,
        },
        tx,
      );
    });
    return loadTechnicalPlan(projectId);
  }

  async function saveOutlineConfig(
    projectId: number,
    payload: { referenceKnowledgeDocumentIds?: unknown; outlineExpansionMode?: unknown; mirrorProcurementEnabled?: unknown; outlineWordControlOptions?: unknown } | undefined,
  ): Promise<TechnicalPlanState> {
    const { referenceKnowledgeDocumentIds, outlineExpansionMode, mirrorProcurementEnabled, outlineWordControlOptions } = payload || {};
    return updateTechnicalPlan(projectId, {
      outlineMode: 'aligned',
      outlineExpansionMode: isValidOutlineExpansionMode(outlineExpansionMode) ? outlineExpansionMode : 'ai-complement',
      mirrorProcurementEnabled: mirrorProcurementEnabled !== false,
      outlineWordControlOptions: normalizeOutlineWordControlOptions(outlineWordControlOptions),
      referenceKnowledgeDocumentIds,
    });
  }

  async function saveOutline(
    projectId: number,
    payload: unknown,
  ): Promise<TechnicalPlanState> {
    await prisma.$transaction(async (tx) => {
      await assertOutlineMutationAllowed(projectId, tx);
      const request = (payload as { outlineData?: OutlineData })?.outlineData ? (payload as { outlineData?: OutlineData; reason?: string; idMap?: Record<string, string>; affectedNodeIds?: string[] }) : { outlineData: payload as OutlineData, reason: 'replace' as const };
      const outlineData = request?.outlineData;
      const reason = normalizeOutlineSaveReason(request?.reason);
      const idMap = normalizeStringMap(request?.idMap);
      const reverseMap = reverseIdMap(idMap);
      const affectedIds = normalizeStringSet(request?.affectedNodeIds);
      const clearAll = reason === 'replace';
      const invalidatesContentTask = reason !== 'sort';
      const snapshot = await loadOutlinePersistenceSnapshot(projectId, tx);
      const outlineToSave = buildOutlineWithPersistedContent(outlineData, { snapshot, reverseMap, affectedIds, clearAll });
      await saveOutlineData(projectId, outlineToSave, tx);
      const rows = flattenOutlineItems(outlineToSave?.outline || []);
      const nextIds = new Set(rows.map((r) => r.node_id as string));
      await restoreMappedContentRows(projectId, { snapshot, idMap, affectedIds, nextIds, clearAll }, tx);
      if (invalidatesContentTask) {
        await tx.technicalPlanTask.deleteMany({ where: { projectId, type: 'content-generation' } });
        await updateMeta(projectId, { contentGenerationRuntimeJson: null }, tx);
      }
      await updateMeta(projectId, { contentIllustrationPlanJson: null }, tx);
    });
    return loadTechnicalPlan(projectId);
  }

  async function saveGlobalFacts(projectId: number, globalFacts: unknown): Promise<TechnicalPlanState> {
    await prisma.$transaction(async (tx) => {
      await replaceGlobalFacts(projectId, globalFacts, tx);
      await clearContentGenerationState(projectId, tx);
      const ts = now();
      await saveTask(
        projectId,
        'global-facts-generation',
        {
          task_id: `manual-global-facts-${Date.now()}`,
          type: 'global-facts-generation',
          status: 'success',
          progress: 100,
          logs: ['全局事实已保存。'],
          started_at: ts,
          updated_at: ts,
          pause_requested: false,
        },
        tx,
      );
    });
    return loadTechnicalPlan(projectId);
  }

  async function saveContentGenerationOptions(projectId: number, options: unknown): Promise<TechnicalPlanState> {
    return updateTechnicalPlan(projectId, { contentGenerationOptions: options, contentIllustrationPlan: undefined });
  }

  async function saveChapterContent(projectId: number, payload: { nodeId?: string; content?: unknown }): Promise<TechnicalPlanState> {
    const { nodeId, content } = payload || {};
    if (!nodeId) throw new Error('缺少章节 nodeId');
    await prisma.$transaction(async (tx) => {
      await assertContentEditingAllowed(projectId, tx);
      const ts = now();
      const node = await tx.technicalPlanOutlineNode.findFirst({ where: { projectId, nodeId }, select: { nodeId: true, title: true } });
      if (!node) throw new Error('当前目录中未找到该章节');
      const nextContent = String(content || '');
      await tx.technicalPlanOutlineNode.updateMany({ where: { projectId, nodeId }, data: { content: nextContent, updatedAt: ts } });
      await tx.technicalPlanContentSection.upsert({
        where: { projectId_nodeId: { projectId, nodeId } },
        create: { projectId, nodeId, status: nextContent.trim() ? 'success' : 'idle', error: null, updatedAt: ts },
        update: { status: nextContent.trim() ? 'success' : 'idle', error: null, updatedAt: ts },
      });
      await updateMeta(projectId, { contentIllustrationPlanJson: null }, tx);
    });
    return loadTechnicalPlan(projectId);
  }

  async function selectBidSection(projectId: number, selectedSection: { id?: string; title?: string } | undefined): Promise<{ success: boolean; message: string; state: TechnicalPlanState; markdown: string }> {
    const selected = selectedSection || {};
    const meta = await ensureMetaRow(projectId);
    const aiSections = normalizeBidSections(readJson(meta.bidSectionsJson, [])) as Array<{ id: string; title: string }>;
    if (aiSections.length >= 2) {
      const matched = aiSections.find((s) => s.id === selected.id) || selected;
      // buildSelectedSectionMarkdown + 写 tender.md 跳过（FS，P4）；markdown 返回 ''
      await prisma.$transaction(async (tx) => {
        await clearDownstreamFromBidSectionChange(projectId, tx);
        await updateMeta(
          projectId,
          {
            bidSectionMode: 'multiple',
            selectedSectionId: matched.id || null,
            selectedSectionTitle: matched.title || null,
          },
          tx,
        );
      });
      return {
        success: true,
        message: `已选择【${matched.title || '投标范围'}】，招标文件解析将仅使用当前投标范围`,
        state: await loadTechnicalPlan(projectId),
        markdown: '',
      };
    }
    throw new Error('请先完成多标段识别，再选择投标范围');
  }

  async function clear(projectId: number): Promise<{ success: boolean; message: string; state: TechnicalPlanState }> {
    const meta = await ensureMetaRow(projectId);
    const workflowKind = normalizeWorkflowKind(meta.workflowKind);
    await prisma.$transaction(async (tx) => {
      await tx.technicalPlanTask.deleteMany({ where: { projectId } });
      await tx.technicalPlanBidItem.deleteMany({ where: { projectId } });
      await tx.technicalPlanReferenceDoc.deleteMany({ where: { projectId } });
      await tx.technicalPlanOutlineNode.deleteMany({ where: { projectId } });
      await tx.technicalPlanGlobalFactGroup.deleteMany({ where: { projectId } });
      await tx.technicalPlanContentSection.deleteMany({ where: { projectId } });
      await tx.technicalPlanContentPlan.deleteMany({ where: { projectId } });
      await tx.technicalPlanMeta.delete({ where: { projectId } });
      const ts = now();
      await tx.technicalPlanMeta.create({
        data: {
          projectId,
          workflowKind,
          step: 'document-analysis',
          bidAnalysisMode: 'key',
          outlineMode: 'aligned',
          outlineExpansionMode: 'ai-complement',
          mirrorProcurementEnabled: true,
          createdAt: ts,
          updatedAt: ts,
        },
      });
    });
    // FS 清理：招标/原方案 markdown + 分源目录（illustrations/imported images 仍 no-op，属 P6+）
    const paths = createWorkspacePaths(projectId);
    await Promise.all([
      fs.rm(paths.technicalPlanTenderMarkdownPath, { force: true }).catch(() => undefined),
      fs.rm(paths.technicalPlanTenderOriginalMarkdownPath, { force: true }).catch(() => undefined),
      fs.rm(paths.technicalPlanOriginalPlanMarkdownPath, { force: true }).catch(() => undefined),
      fs.rm(paths.technicalPlanTenderFilesDir, { recursive: true, force: true }).catch(() => undefined),
    ]);
    return { success: true, message: '技术方案缓存已清空', state: await loadTechnicalPlan(projectId) };
  }

  // ---- FS 读（P4-2：从工作区磁盘读回招标/原方案 markdown） ----
  async function readTenderMarkdown(projectId: number): Promise<string> {
    const meta = await ensureMetaRow(projectId);
    if (!meta.tenderMarkdownPath) return '';
    const paths = createWorkspacePaths(projectId);
    try {
      return await fs.readFile(paths.resolve(meta.tenderMarkdownPath), 'utf-8');
    } catch {
      return '';
    }
  }

  // 对齐桌面 readOriginalTenderMarkdown（technicalPlanStore.cjs:605-617）。
  // 多标段识别需要“原始未裁剪”的招标正文（selectBidSection 在桌面会重写工作副本 tender.md 成
  // 选中分段子集）。web 版 selectBidSection/saveBidAnalysisConfig 的 FS 重写是 P3 stub（恒不重写），
  // 故工作副本恒等于原始副本；本方法仍忠实读 tenderOriginalMarkdownPath 以保语义。
  // - 未导入招标（无 tenderMarkdownPath）→ 返回 ''（runner 兜底抛“请先上传招标文件”）
  // - 已导入但原始副本缺失 → 抛“原始招标文件缺失”（对齐桌面）
  async function readOriginalTenderMarkdown(projectId: number): Promise<string> {
    const meta = await ensureMetaRow(projectId);
    if (!meta.tenderMarkdownPath) return '';
    if (!meta.tenderOriginalMarkdownPath) {
      throw new Error('原始招标文件缺失，请重新上传招标文件');
    }
    const paths = createWorkspacePaths(projectId);
    try {
      return await fs.readFile(paths.resolve(meta.tenderOriginalMarkdownPath), 'utf-8');
    } catch {
      throw new Error('原始招标文件缺失，请重新上传招标文件');
    }
  }

  // 对齐桌面 checkBidSections（technicalPlanStore.cjs:632-635）。
  // 读原始未裁剪招标正文 → 纯正则 detectBidSections 判定是否疑似多标段。
  async function checkBidSections(projectId: number): Promise<BidSectionDetection> {
    const markdown = await readOriginalTenderMarkdown(projectId);
    return detectBidSections(markdown);
  }

  async function readTenderSourceMarkdown(projectId: number, sourceId: string): Promise<string> {
    const meta = await ensureMetaRow(projectId);
    const target = loadTenderSourceFiles(meta).find((file) => file.id === String(sourceId || ''));
    if (!target?.markdownPath) return '';
    const paths = createWorkspacePaths(projectId);
    try {
      return await fs.readFile(paths.resolve(String(target.markdownPath)), 'utf-8');
    } catch {
      return '';
    }
  }

  async function readOriginalPlanMarkdown(projectId: number): Promise<string> {
    const meta = await ensureMetaRow(projectId);
    if (!meta.originalPlanMarkdownPath) return '';
    const paths = createWorkspacePaths(projectId);
    try {
      return await fs.readFile(paths.resolve(meta.originalPlanMarkdownPath), 'utf-8');
    } catch {
      return '';
    }
  }

  // 对齐桌面 prepareBidSectionExtraction（technicalPlanStore.cjs:1554-1569）。
  // resetTenderWorkingCopyToOriginal（FS：把 tender-original.md 拷回 tender.md）在 web 是 no-op
  // （工作副本恒等于原始副本，见 readOriginalTenderMarkdown 注释），故只做 DB 清理 + meta 置位。
  // selectedSectionId/selectedSectionTitle 不在 updateTechnicalPlan 的 mapper 里，须直接 updateMeta。
  async function prepareBidSectionExtraction(projectId: number): Promise<TechnicalPlanState> {
    await prisma.$transaction(async (tx) => {
      await clearDownstreamFromBidSectionChange(projectId, tx);
      await updateMeta(
        projectId,
        {
          bidSectionMode: 'multiple',
          bidSectionsJson: null,
          bidSectionExtractionStatus: 'running',
          bidSectionExtractionError: null,
          selectedSectionId: null,
          selectedSectionTitle: null,
        },
        tx,
      );
    });
    return loadTechnicalPlan(projectId);
  }

  // ---- 文件导入（P4-2：route 已把上传 buffer 解析成 markdown，这里负责落盘 + 写库） ----
  // 对齐桌面 importTenderDocument:1642-1671 + saveTenderMarkdownAndState:1727-1765。
  async function importTenderDocument(projectId: number, docs: ParsedImport[]): Promise<ImportResult> {
    if (!docs?.length) {
      return { success: false, message: '未导入文件', state: await loadTechnicalPlan(projectId), markdown: '' };
    }
    const paths = createWorkspacePaths(projectId);
    const markdowns = docs.map((d) => String(d.markdown || '').trim()).filter(Boolean);
    const combinedMarkdown = combineTenderMarkdown(markdowns);
    if (!combinedMarkdown) {
      return { success: false, message: '文件内容为空或解析失败', state: await loadTechnicalPlan(projectId), markdown: '' };
    }
    const fileName = docs.length > 1 ? `${docs.length} 份招标文件` : docs[0].fileName || '未命名文件';
    const parserLabel = docs.length > 1 ? null : docs[0].parserLabel || null;

    // 清空旧的分源文件目录，写每份独立 markdown（对齐 clearTenderSourceFiles + writeTenderSourceMarkdown）。
    await fs.rm(paths.technicalPlanTenderFilesDir, { recursive: true, force: true }).catch(() => undefined);
    const tenderFilesJson: Array<Record<string, unknown>> = [];
    for (let index = 0; index < docs.length; index++) {
      const doc = docs[index];
      const markdown = String(doc.markdown || '').trim();
      const id = createTenderSourceId(doc.fileName, markdown, index);
      const relPath = path.join('technical-plan', 'tender-files', `${id}-${safeFileNamePart(doc.fileName)}.md`).replace(/\\/g, '/');
      await writeMarkdownFile(paths.resolve(relPath), markdown, id);
      tenderFilesJson.push({
        id,
        fileName: doc.fileName || '招标文件',
        markdownPath: relPath,
        markdownChars: markdown.length,
        contentHash: doc.hash || shortHash(markdown),
        parserLabel: doc.parserLabel || undefined,
        importedAt: now(),
        updatedAt: now(),
      });
    }
    // 合并 markdown 落 tender.md + tender-original.md（备份，供 checkBidSections/selectBidSection 用）
    await writeMarkdownFile(paths.technicalPlanTenderMarkdownPath, combinedMarkdown, 'tender');
    await writeMarkdownFile(paths.technicalPlanTenderOriginalMarkdownPath, combinedMarkdown, 'tender-original');
    const tenderMarkdownRelativePath = paths.relativize(paths.technicalPlanTenderMarkdownPath);
    const tenderOriginalRelativePath = paths.relativize(paths.technicalPlanTenderOriginalMarkdownPath);

    await prisma.$transaction(async (tx) => {
      await clearDownstreamFromTender(projectId, tx);
      await updateMeta(
        projectId,
        {
          tenderFileName: fileName,
          tenderMarkdownPath: tenderMarkdownRelativePath,
          tenderMarkdownHash: shortHash(combinedMarkdown),
          tenderMarkdownChars: combinedMarkdown.length,
          tenderOriginalMarkdownPath: tenderOriginalRelativePath,
          tenderOriginalMarkdownHash: shortHash(combinedMarkdown),
          tenderOriginalMarkdownChars: combinedMarkdown.length,
          tenderParserLabel: parserLabel,
          tenderImportedAt: now(),
          tenderFilesJson: jsonOrNull(tenderFilesJson),
        },
        tx,
      );
    });
    return {
      success: true,
      message: '招标文件已导入',
      state: await loadTechnicalPlan(projectId),
      markdown: combinedMarkdown,
    };
  }

  // 对齐桌面 importOriginalPlanDocument:1673-1725。
  async function importOriginalPlanDocument(projectId: number, docs: ParsedImport[]): Promise<ImportResult> {
    if (!docs?.length) {
      return { success: false, message: '未导入文件', state: await loadTechnicalPlan(projectId), markdown: '' };
    }
    const doc = docs[0];
    const markdown = String(doc.markdown || '').trim();
    if (!markdown) {
      return { success: false, message: '文件内容为空或解析失败', state: await loadTechnicalPlan(projectId), markdown: '' };
    }
    const paths = createWorkspacePaths(projectId);
    await writeMarkdownFile(paths.technicalPlanOriginalPlanMarkdownPath, markdown, 'original-plan');
    const originalPlanRelativePath = paths.relativize(paths.technicalPlanOriginalPlanMarkdownPath);

    await prisma.$transaction(async (tx) => {
      await clearDownstreamFromOriginalPlan(projectId, tx);
      await updateMeta(
        projectId,
        {
          workflowKind: 'existing-plan-expansion',
          originalPlanFileName: doc.fileName || '未命名文件',
          originalPlanMarkdownPath: originalPlanRelativePath,
          originalPlanMarkdownHash: doc.hash || shortHash(markdown),
          originalPlanMarkdownChars: markdown.length,
          originalPlanParserLabel: doc.parserLabel || null,
          originalPlanImportedAt: now(),
        },
        tx,
      );
    });
    return {
      success: true,
      message: '原方案已导入',
      state: await loadTechnicalPlan(projectId),
      markdown,
    };
  }

  return {
    loadTechnicalPlan,
    updateTechnicalPlan,
    updateStep,
    setWorkflowKind,
    switchWorkflowKind,
    saveBidAnalysisConfig,
    saveOutlineConfig,
    saveOutline,
    saveGlobalFacts,
    saveContentGenerationOptions,
    saveChapterContent,
    selectBidSection,
    clear,
    readTenderMarkdown,
    readOriginalTenderMarkdown,
    readTenderSourceMarkdown,
    readOriginalPlanMarkdown,
    prepareBidSectionExtraction,
    importTenderDocument,
    importOriginalPlanDocument,
    checkBidSections,
  };
}
