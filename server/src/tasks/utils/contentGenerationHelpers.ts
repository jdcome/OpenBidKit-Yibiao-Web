// L4 runner #65 helpers：content-generation（技术方案正文生成）纯函数 + prompt + 编排工具。
// 逐字移植自 client/electron/services/contentGenerationTask.cjs（行 1-2945 的常量与顶层 helper）。
// 入口 runContentGenerationTask（cjs:2946+）由独立的 entry 文件实现，本文件不包含。
//
// 适配点（桌面→web）：
//   - shouldUseAgentForMessages 恒 false：M1 降级，强制走 LLM 路径，agent 路径未启用。
//     所有 *Agent* prompt/file builder 仍逐字移植（纯函数，仍可编译），但 entry 不会调用。
//   - countReadableWords / createNoopDeveloperLogger / AI_QUEUE_SCOPE_PAUSED 来自 web 已有模块或内联：
//     * splitUserTextByContextLimit → ../../document/userTextSplitter（已存在）
//     * AI_QUEUE_SCOPE_PAUSED → ../../ai/requestQueue（已存在）
//     * countReadableWords → web 未提供 wordCount 模块，内联最小实现
//     * createNoopDeveloperLogger → web 未提供 developerLog 模块，内联最小实现
//   - 文本/AI 服务通过 ContentAiService 注入；不再 require electron services。
import { createHash } from 'node:crypto';
import { splitUserTextByContextLimit } from '../../document/userTextSplitter';
import { AI_QUEUE_SCOPE_PAUSED } from '../../ai/requestQueue';

// ---- 类型 ----

export type LogFn = (message: string, progress?: number) => void | Promise<void>;

export type ChatMessage = { role: string; content: string };

export interface ContentAiService {
  collectJsonResponse(options: Record<string, unknown>): Promise<unknown>;
  getConfig(): Record<string, unknown>;
  isDeveloperMode?(): boolean;
  createTechnicalPlanDeveloperLogger?(request: unknown): DeveloperLogger;
}

export interface DeveloperLogger {
  log(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

export interface ContentPlan {
  writing_focus?: string;
  knowledge: { item_ids: string[] };
  facts: { titles: string[] };
  table: { needed: boolean; purpose: string };
  original_material?: OriginalMaterial;
  [key: string]: unknown;
}

export interface ContentStoredPlan {
  plan_version: number;
  plan: ContentPlan;
  table_requirement?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ContentSection {
  id: string;
  title: string;
  status: string;
  content?: string;
  error?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export type ContentSectionMap = Record<string, ContentSection>;

export interface OriginalMaterial {
  restored: boolean;
  optimized: boolean;
  source_ids: string[];
  source_titles: string[];
  source_hashes: string[];
  restored_chars: number;
  restored_at?: string;
  optimized_at?: string;
  [key: string]: unknown;
}

export interface OutlineItem {
  id?: string;
  title?: string;
  description?: string;
  content?: string;
  knowledge_item_ids?: string[];
  children?: OutlineItem[];
  [key: string]: unknown;
}

export interface OutlineNodeInfo {
  item: OutlineItem;
  level: number;
  parent: OutlineItem | null;
}

export interface OutlinePayload {
  outline?: OutlineItem[];
  project_overview?: string;
  [key: string]: unknown;
}

export interface OriginalSegment {
  id: string;
  title_path: string[];
  content: string;
  hash: string;
  chars: number;
  [key: string]: unknown;
}

export interface ContentTableBlock {
  id: string;
  type: string;
  start: number;
  end: number;
  text: string;
  before: string;
  after: string;
  [key: string]: unknown;
}

export interface ContentKnowledgeItem {
  id: string;
  title: string;
  resume: string;
  content?: string;
  [key: string]: unknown;
}

export interface ContentKnowledgeBaseService {
  getOutlineReferences?(documentIds: string[]): { items: Array<{ id: string; title: string; resume: string }> };
  readItems?(documentId: string): ContentKnowledgeItem[] | { id?: string; content?: string }[];
}

export interface OutlineExpansionAddition {
  parent_id: string;
  title: string;
  description?: string;
  children?: unknown[];
  [key: string]: unknown;
}

export interface OutlineExpansionPatch {
  additions: OutlineExpansionAddition[];
}

export interface ContentExpansionPatch {
  operation: string;
  anchor: string;
  target_text: string;
  content: string;
}

export interface OutlineWordControlSnapshot {
  enabled: boolean;
  minimumWords: number;
  maximumWords: number;
  sectionWords: number;
  strictSectionWords: boolean;
  sectionMinimumWords: number;
  sectionMaximumWords: number;
}

export interface ConsistencyPatch {
  section_id: string;
  start_line: number;
  end_line: number;
  old_text: string;
  new_text: string;
  reason: string;
}

export interface ConsistencyConflict {
  section_id: string;
  fact_title: string;
  evidence: string;
  reason: string;
  severity: string;
}

export interface ConsistencyAuditGroupItem {
  item: OutlineItem;
  parentChapters: OutlineItem[];
  siblingChapters: OutlineItem[];
  content?: string;
}

export interface ConsistencyAuditGroup {
  items: ConsistencyAuditGroupItem[];
}

export interface OriginalCoverageItem {
  source_id: string;
  node_id: string;
  status: string;
  missing_points: string[];
  repair_suggestion: string;
}

export interface OriginalRestoreAssignment {
  node_id: string;
  source_ids: string[];
}

export interface TableCleanupReplacement {
  table_id: string;
  replacement_text: string;
}

export interface ContentGenerationRuntime {
  phase: string;
  touched_item_ids: string[];
  outline_expansion_completed: number;
  expansion_cycle_item_ids: string[];
  expansion_attempted_item_ids: string[];
  expansion_cycle_start_words: number;
  target_item_id: string;
  regenerate_requirement: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface LeafContext {
  item: OutlineItem;
  parentChapters: OutlineItem[];
  siblingChapters: OutlineItem[];
}

// ---- 内联依赖（web 未提供 wordCount / developerLog） ----

// TODO: 共享 wordCount 模块未在 web，临时内联。最小复刻 cjs/utils/wordCount.cjs 的可读字数统计：
// 中文按字符计；拉丁文按空白分词数加和。
function countReadableWords(input: string): number {
  const text = String(input || '').trim();
  if (!text) return 0;
  let count = 0;
  let latinBuffer = '';
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    const isCjk = code >= 0x3400 && code <= 0x9fff || code >= 0xf900 && code <= 0xfaff || code >= 0x20000 && code <= 0x2fa1f;
    const isKana = code >= 0x3040 && code <= 0x30ff;
    if (isCjk || isKana) {
      if (latinBuffer.trim()) {
        count += latinBuffer.trim().split(/\s+/).length;
        latinBuffer = '';
      }
      count += 1;
    } else {
      latinBuffer += char;
    }
  }
  if (latinBuffer.trim()) {
    count += latinBuffer.trim().split(/\s+/).length;
  }
  return count;
}

// TODO: 共享 developerLog 模块未在 web，临时内联 noop logger。
function createNoopDeveloperLogger(): DeveloperLogger {
  return {
    log() {},
    debug() {},
    warn() {},
    error() {},
    info() {},
  };
}

// ---- 常量（cjs:23-47, 1315-1339, 2080） ----

const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;
const AGENT_CONTEXT_THRESHOLD_RATIO = 0.7;
const DEFAULT_TEXT_CONCURRENCY_LIMIT = (() => {
  const raw = Number(process.env.AI_TEXT_CONCURRENCY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 24;
})();
const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;
const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';
const MAX_OUTLINE_EXPANSION_ROUNDS = 3;
const OUTLINE_EXPANSION_STEPS_PER_ROUND = 6;
const OUTLINE_EXPANSION_TARGET_RATIO = 0.8;
const EARLY_CONTENT_PROBE_COUNT = 3;
const MIN_SECTION_EXPANSION_INCREMENT = 800;
const GENERATION_WORD_TARGET_RATIO = 0.8;
const CONSISTENCY_AUDIT_GROUP_WORD_LIMIT = 300000;
const CONSISTENCY_REPAIR_MAX_ATTEMPTS = 2;
const ORIGINAL_PLAN_SEGMENT_MAX_CHARS = 6000;
const ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS = 2;
const TABLE_CLEANUP_CONTEXT_CHARS = 600;
const TABLE_CLEANUP_BATCH_CHAR_LIMIT = 30000;
const CONTENT_GENERATION_PAUSED = 'CONTENT_GENERATION_PAUSED';
const CONTENT_PLAN_VERSION = 4;
const PROMPT_CACHE_WARMUP_DELAY_MS = (() => {
  const raw = Number(process.env.AI_PROMPT_CACHE_WARMUP_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 1000;
})();
const TABLE_REQUIREMENT_LABELS: Record<string, string> = {
  none: '不要',
  light: '少量',
  moderate: '适中',
  heavy: '大量',
};

const OUTLINE_EXPANSION_TOP_LEVEL_KEYS = new Set(['additions']);
const OUTLINE_EXPANSION_ADDITION_KEYS = new Set(['parent_id', 'parentId', 'title', 'name', 'description', 'summary', 'resume', 'children']);
const OUTLINE_EXPANSION_CHILD_KEYS = new Set(['title', 'name', 'description', 'summary', 'resume', 'children']);
const OUTLINE_EXPANSION_FORBIDDEN_KEY_NAMES = new Set([
  'id',
  'outline',
  'content',
  'markdown',
  'body',
  'image',
  'images',
  'picture',
  'pictures',
  'table',
  'tables',
  'plan',
  'plans',
  'contentplan',
  'contentplans',
  'contentgenerationplans',
  'contentgenerationsections',
  'illustration',
  'illustrationtype',
  'mermaid',
]);

const ORIGINAL_COVERAGE_STATUSES = new Set(['covered', 'partial', 'missing', 'conflict']);

// cjs buildChapterContentPlanMessages 在 tableLimitInstruction 中引用了未声明的 totalSections
// 自由变量（CommonJS 非严格模式下解析为 undefined，再 fallback 到 0）。为保持完全等价的运行
// 时行为，这里在模块作用域显式声明为 undefined，使 `tableTotalSections || totalSections || 0`
// 在 tableTotalSections 为 falsy 时仍然落到 0。entry 不需要传 totalSections 参数。
const totalSections: number | undefined = undefined;

// ---- 错误/暂停助手（cjs:49-65） ----

export function isAiQueueScopePausedError(error: unknown): boolean {
  return (error as { code?: string })?.code === AI_QUEUE_SCOPE_PAUSED;
}

export function isContentGenerationPausedError(error: unknown): boolean {
  return (error as { code?: string })?.code === CONTENT_GENERATION_PAUSED;
}

export function isPauseLikeError(error: unknown): boolean {
  return isContentGenerationPausedError(error) || isAiQueueScopePausedError(error);
}

export function createContentGenerationPausedError(): Error {
  const error = new Error(CONTENT_GENERATION_PAUSED) as Error & { code?: string };
  error.code = CONTENT_GENERATION_PAUSED;
  return error;
}

// ---- 缓存预热 / 单行格式化（cjs:67-73） ----

export function waitForPromptCacheWarmup(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_CACHE_WARMUP_DELAY_MS));
}

export function singleLine(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// ---- 全局事实变量格式化（cjs:75-110） ----

export function formatGlobalFactsForPrompt(globalFacts: unknown): string {
  const groups = (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group, index) => {
      const g = (group || {}) as { title?: string; content?: string };
      const title = singleLine(g.title || `全局事实${index + 1}`);
      const content = String(g.content || '').trim();
      if (!title || !content) return '';
      return `## ${title}\n${content}`;
    })
    .filter(Boolean);
  return groups.join('\n\n');
}

export function appendGlobalFactsMessage(messages: ChatMessage[], globalFactsText?: string): void {
  const content = String(globalFactsText || '').trim();
  if (!content) return;
  messages.push({
    role: 'user',
    content: `全局事实变量（正文涉及时优先使用这些变量值，避免各章节随机变化）：\n${content}`,
  });
}

export function appendSelectedFactsMessage(messages: ChatMessage[], selectedFactsText?: string): void {
  const content = String(selectedFactsText || '').trim();
  if (!content) return;
  messages.push({
    role: 'user',
    content: `本章节需要使用的全局事实变量（正文涉及时优先使用这些变量值，保证全文一致）：\n${content}`,
  });
}

export function formatGlobalFactTitlesForPrompt(globalFacts: unknown): string {
  const titles = (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group) => singleLine((group as { title?: string })?.title))
    .filter(Boolean);
  return JSON.stringify([...new Set(titles)], null, 2);
}

// ---- 招标分析事实 / 关键信息（cjs:112-131） ----

export function formatBidAnalysisFactForPrompt(
  storedPlan: Record<string, unknown> | null | undefined,
  itemId: string,
  label: string,
): string {
  const tasks = (storedPlan?.bidAnalysisTasks as Record<string, { status?: string; content?: string } | undefined>) || {};
  const item = tasks[itemId];
  const content = item?.status === 'success' ? String(item.content || '').trim() : '';
  return content ? `## ${label}\n${content}` : '';
}

export function formatBidAnalysisFactsForPrompt(storedPlan: Record<string, unknown> | null | undefined): string {
  return [
    formatBidAnalysisFactForPrompt(storedPlan, 'projectInfo', '项目信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'partAInfo', '甲方信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'deliveryAndServiceRequirements', '交货和服务要求'),
  ].filter(Boolean).join('\n\n');
}

export function formatBidKeyInfoForPrompt(projectOverview: unknown, bidAnalysisFactsText?: string): string {
  return [
    String(projectOverview || '').trim() ? `## 项目概述\n${String(projectOverview || '').trim()}` : '',
    String(bidAnalysisFactsText || '').trim(),
  ].filter(Boolean).join('\n\n') || '未提供';
}

// ---- 全局事实标题归一化（cjs:133-168） ----

export function normalizeFactTitles(value: unknown, allowedFactTitles?: Set<string> | null): string[] {
  const source = Array.isArray(value) ? value : [];
  const titles = source.map((title) => singleLine(title)).filter(Boolean);
  const filtered = allowedFactTitles instanceof Set
    ? titles.filter((title) => allowedFactTitles.has(title))
    : titles;
  return [...new Set(filtered)];
}

export function resolveGlobalFactsByTitles(
  titles: unknown,
  globalFacts: unknown,
): Array<{ title: string; content: string }> {
  const selected = new Set(normalizeFactTitles(titles));
  if (!selected.size) return [];
  return (Array.isArray(globalFacts) ? globalFacts : [])
    .filter((group) => {
      const g = (group || {}) as { title?: string; content?: string };
      return selected.has(singleLine(g.title)) && String(g.content || '').trim();
    })
    .map((group) => {
      const g = (group || {}) as { title?: string; content?: string };
      return { title: singleLine(g.title), content: String(g.content || '').trim() };
    });
}

export function formatSelectedGlobalFactsForPrompt(globalFacts: unknown): string {
  return (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group) => {
      const g = (group || {}) as { title?: string; content?: string };
      const title = singleLine(g.title);
      const content = String(g.content || '').trim();
      return title && content ? `## ${title}\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function hasFactSelection(value: unknown): boolean {
  const v = value as Record<string, unknown> | undefined;
  const source = v?.plan && typeof v.plan === 'object' ? (v.plan as Record<string, unknown>) : v || {};
  return Object.prototype.hasOwnProperty.call(source, 'facts')
    || Object.prototype.hasOwnProperty.call(source, 'fact_titles')
    || Object.prototype.hasOwnProperty.call(source, 'factTitles')
    || Object.prototype.hasOwnProperty.call(source, 'global_fact_titles')
    || Object.prototype.hasOwnProperty.call(source, 'globalFactTitles');
}

// ---- Markdown / 表格切分（cjs:170-323） ----

export function normalizeGeneratedMarkdown(content: unknown): string {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => {
      const normalizedLine = line.replace(/<br\s*\/?\s*>/gi, '<br />');
      if (normalizedLine.trim().startsWith('|')) {
        return normalizedLine;
      }
      return normalizedLine.replace(/\s*<br \/>\s*/g, '  \n');
    })
    .join('\n');
}

export function splitLinesWithRanges(content: unknown): Array<{ text: string; start: number; end: number; newlineEnd: number }> {
  const text = String(content || '');
  const lines: Array<{ text: string; start: number; end: number; newlineEnd: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\r' && char !== '\n') {
      continue;
    }
    const lineEnd = index;
    const newlineEnd = char === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
    lines.push({ text: text.slice(start, lineEnd), start, end: lineEnd, newlineEnd });
    start = newlineEnd;
    if (newlineEnd > index + 1) {
      index += 1;
    }
  }
  if (start < text.length || !lines.length) {
    lines.push({ text: text.slice(start), start, end: text.length, newlineEnd: text.length });
  }
  return lines;
}

export function collectFencedCodeRanges(content: unknown): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const lines = splitLinesWithRanges(content);
  let fence: { marker: string; length: number } | null = null;
  let start = 0;
  for (const line of lines) {
    const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (!match) {
      continue;
    }
    const marker = match[1][0];
    const length = match[1].length;
    const rest = match[2] || '';
    if (!fence) {
      if (marker === '`' && rest.includes('`')) {
        continue;
      }
      fence = { marker, length };
      start = line.start;
      continue;
    }
    if (marker === fence.marker && length >= fence.length && /^[ \t]*$/.test(rest)) {
      ranges.push({ start, end: line.newlineEnd });
      fence = null;
    }
  }
  if (fence) {
    ranges.push({ start, end: String(content || '').length });
  }
  return ranges;
}

export function rangeOverlaps(start: number, end: number, ranges: Array<{ start: number; end: number }> | null): boolean {
  return (ranges || []).some((range) => start < range.end && end > range.start);
}

export function isMarkdownTableRow(line: unknown): boolean {
  const trimmed = String(line || '').trim();
  return trimmed.includes('|') && trimmed.replace(/\\\|/g, '').includes('|');
}

export function isMarkdownTableSeparator(line: unknown): boolean {
  const trimmed = String(line || '').trim();
  if (!isMarkdownTableRow(trimmed)) return false;
  const rawCells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  const cells = rawCells.map((cell) => cell.trim()).filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function extractMarkdownTableBlocks(
  content: unknown,
  fencedRanges: Array<{ start: number; end: number }>,
): Array<{ type: string; start: number; end: number; text: string }> {
  const lines = splitLinesWithRanges(content);
  const tables: Array<{ type: string; start: number; end: number; text: string }> = [];
  let index = 0;
  while (index < lines.length - 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (rangeOverlaps(header.start, separator.end, fencedRanges) || !isMarkdownTableRow(header.text) || !isMarkdownTableSeparator(separator.text)) {
      index += 1;
      continue;
    }

    let endLine = index + 1;
    while (endLine + 1 < lines.length && !rangeOverlaps(lines[endLine + 1].start, lines[endLine + 1].end, fencedRanges) && isMarkdownTableRow(lines[endLine + 1].text)) {
      endLine += 1;
    }
    const start = header.start;
    const end = lines[endLine].end;
    tables.push({ type: 'markdown', start, end, text: String(content || '').slice(start, end) });
    index = endLine + 1;
  }
  return tables;
}

export function extractHtmlTableBlocks(
  content: unknown,
  fencedRanges: Array<{ start: number; end: number }>,
): Array<{ type: string; start: number; end: number; text: string }> {
  const text = String(content || '');
  const tables: Array<{ type: string; start: number; end: number; text: string }> = [];
  const pattern = /<table\b[\s\S]*?<\/table>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (rangeOverlaps(start, end, fencedRanges)) {
      continue;
    }
    tables.push({ type: 'html', start, end, text: match[0] });
  }
  return tables;
}

export function addTableContext(
  content: unknown,
  tables: Array<{ type: string; start: number; end: number; text: string }>,
): ContentTableBlock[] {
  const text = String(content || '');
  return (tables || []).map((table, index) => ({
    id: `T${String(index + 1).padStart(3, '0')}`,
    ...table,
    before: text.slice(Math.max(0, table.start - TABLE_CLEANUP_CONTEXT_CHARS), table.start).trim(),
    after: text.slice(table.end, Math.min(text.length, table.end + TABLE_CLEANUP_CONTEXT_CHARS)).trim(),
  }));
}

export function extractContentTableBlocks(content: unknown): ContentTableBlock[] {
  const fencedRanges = collectFencedCodeRanges(content);
  const tables = [
    ...extractMarkdownTableBlocks(content, fencedRanges),
    ...extractHtmlTableBlocks(content, fencedRanges),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const nonOverlapping: Array<{ type: string; start: number; end: number; text: string }> = [];
  for (const table of tables) {
    if (nonOverlapping.some((existing) => table.start < existing.end && table.end > existing.start)) {
      continue;
    }
    nonOverlapping.push(table);
  }
  return addTableContext(content, nonOverlapping);
}

export function containsContentTable(content: unknown): boolean {
  return extractContentTableBlocks(content).length > 0;
}

export function createTableCleanupBatches(tables: ContentTableBlock[]): ContentTableBlock[][] {
  const batches: ContentTableBlock[][] = [];
  let current: ContentTableBlock[] = [];
  let currentSize = 0;
  for (const table of tables || []) {
    const size = String(table.text || '').length + String(table.before || '').length + String(table.after || '').length;
    if (current.length && currentSize + size > TABLE_CLEANUP_BATCH_CHAR_LIMIT) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(table);
    currentSize += size;
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

// ---- 紧凑错误/归一化数值（cjs:345-378） ----

export function compactError(value: unknown, maxLength = 220): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function normalizeTableRequirement(value: unknown): string {
  const text = String(value || '').trim();
  if (['none', 'light', 'moderate', 'heavy'].includes(text)) {
    return text;
  }
  if (text === '不要') return 'none';
  if (text === '少量') return 'light';
  if (text === '适中') return 'moderate';
  if (text === '大量') return 'heavy';
  return 'heavy';
}

export function normalizeConsistencyRepairMode(value: unknown): string {
  return String(value || '').trim() === 'normal' ? 'normal' : 'agent';
}

export function normalizeOriginalPlanCoverageRepairMode(value: unknown): string {
  return String(value || '').trim() === 'normal' ? 'normal' : 'agent';
}

export function normalizeMinimumWords(value: unknown): number {
  const words = Number(value);
  return Math.max(0, Number.isFinite(words) ? Math.round(words) : 0);
}

function normalizeWordControlInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function normalizeWordControlWan(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 10000) : 0;
}

export function normalizeOutlineWordControlSnapshot(value: unknown): OutlineWordControlSnapshot {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const minimumWords = normalizeWordControlInteger(
    source.minimumWords ?? source.minWords ?? source.minimum_words ?? normalizeWordControlWan(source.minWordsWan),
  );
  const maximumWords = normalizeWordControlInteger(
    source.maximumWords ?? source.maxWords ?? source.maximum_words ?? normalizeWordControlWan(source.maxWordsWan),
  );
  const sectionWords = normalizeWordControlInteger(
    source.sectionWords ?? source.wordsPerSection ?? source.section_words ?? normalizeWordControlWan(source.wordsPerSectionWan),
  );
  const strictSectionWords = sectionWords > 0 && Boolean(source.strictSectionWords ?? source.forceSectionWords ?? source.strict_section_words);
  return Object.freeze({
    enabled: minimumWords > 0 || maximumWords > 0 || sectionWords > 0,
    minimumWords,
    maximumWords,
    sectionWords,
    strictSectionWords,
    sectionMinimumWords: sectionWords > 0 ? Math.ceil(sectionWords * 0.8) : 0,
    sectionMaximumWords: sectionWords > 0 ? Math.floor(sectionWords * 1.2) : 0,
  });
}

export function computeGenerationWordTarget(wordControl: OutlineWordControlSnapshot, leafCount: number): number {
  if (!wordControl.strictSectionWords) return 0;
  if (!(wordControl.maximumWords > 0) || !(leafCount > 0)) return 0;
  const derived = Math.floor((wordControl.maximumWords * GENERATION_WORD_TARGET_RATIO) / leafCount);
  return Math.max(wordControl.sectionMinimumWords, derived);
}

export function buildSectionWordRequirement(
  wordControl: OutlineWordControlSnapshot | undefined,
  preserveOriginalMaterial = false,
  generationTarget = 0,
): string {
  if (!wordControl || wordControl.sectionWords <= 0) return '';
  const targetWords = generationTarget > 0 ? generationTarget : wordControl.sectionWords;
  const base = wordControl.strictSectionWords
    ? `本小节目标字数约 ${targetWords} 字，硬性上限 ${wordControl.sectionMaximumWords} 字，绝对不得超过上限；低于 ${wordControl.sectionMinimumWords} 字或超过 ${wordControl.sectionMaximumWords} 字都需要后续修正。请在信息完整、专业、不重复的前提下贴近目标字数，宁可略短也不要为凑字数扩写、堆砌或重复表达。`
    : `本小节建议字数 ${wordControl.sectionMinimumWords} 至 ${wordControl.sectionMaximumWords} 字（目标约 ${targetWords} 字）。请在内容完整、专业、不重复的前提下控制篇幅，避免明显超出该范围；如确有必要可略有出入，最终由全文字数流程统一调整。`;
  return preserveOriginalMaterial
    ? `${base}\n字数要求不能覆盖保留原方案实质内容的要求；可以消除重复和冗余，但不得删除技术路线、参数、周期、人员、验收、售后和承诺。`
    : base;
}

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

// ---- 长度/上下文/并发（cjs:380-430） ----

export function getMessageContentLength(content: unknown): number {
  if (typeof content === 'string') {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => {
      const i = item as { text?: string; content?: unknown };
      return sum + getMessageContentLength(i?.text ?? i?.content ?? item);
    }, 0);
  }
  if (content === undefined || content === null) {
    return 0;
  }
  return JSON.stringify(content).length;
}

export function getMessagesContentLength(messages: ChatMessage[] | null): number {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => (
    sum + String(message?.role || '').length + getMessageContentLength(message?.content)
  ), 0);
}

export function getTextContextLengthLimit(aiService: ContentAiService | undefined): number {
  let config: Record<string, unknown> = {};
  try {
    config = aiService?.getConfig?.() || {};
  } catch {
    config = {};
  }
  return normalizePositiveInteger(config.context_length_limit, DEFAULT_CONTEXT_LENGTH_LIMIT);
}

export function shouldUseAgentForMessages(_aiService: ContentAiService | undefined, _messages: ChatMessage[] | null): boolean {
  // M1 降级：恒 false，强制走 LLM 路径（agent 路径未启用）
  return false;
}

export function normalizeContentConcurrency(value: unknown): number {
  const concurrency = Number(value);
  return Math.max(1, Number.isFinite(concurrency) ? Math.round(concurrency) : DEFAULT_TEXT_CONCURRENCY_LIMIT);
}

export function normalizeImageConcurrency(value: unknown): number {
  const concurrency = Number(value);
  return Math.max(1, Number.isFinite(concurrency) ? Math.round(concurrency) : DEFAULT_IMAGE_CONCURRENCY_LIMIT);
}

export function isDeveloperModeEnabled(aiService: ContentAiService | undefined): boolean {
  try {
    return Boolean(aiService?.isDeveloperMode?.());
  } catch {
    return false;
  }
}

// ---- 文本哈希 / 字数（cjs:432-454） ----

export function textHash(value: unknown): string {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function textMetrics(value: unknown): { chars: number; hash: string } {
  const content = String(value || '');
  return {
    chars: content.length,
    hash: textHash(content),
  };
}

export function createContentDeveloperLogger(aiService: ContentAiService | undefined, request: unknown): DeveloperLogger {
  try {
    return aiService?.createTechnicalPlanDeveloperLogger?.(request) || createNoopDeveloperLogger();
  } catch {
    return createNoopDeveloperLogger();
  }
}

export function countContentWords(content: unknown): number {
  return countReadableWords(String(content || ''));
}

// ---- 表格需求 / 计划清理（cjs:456-471） ----

export function maxTablesForRequirement(requirement: string, leafCount: number): number | null {
  if (requirement === 'none') return 0;
  if (requirement === 'light') return Math.floor(Math.max(0, leafCount) * 0.2);
  if (requirement === 'moderate') return Math.floor(Math.max(0, leafCount) * 0.4);
  return null;
}

export function clearContentPlanTable(contentPlan: ContentPlan): ContentPlan {
  return {
    ...contentPlan,
    table: {
      needed: false,
      purpose: '',
    },
  };
}

// ---- 编排计划归一化（cjs:473-612） ----

export function normalizeKnowledgeItemIds(value: unknown, allowedKnowledgeItemIds?: Set<string> | null): string[] {
  const source = Array.isArray(value) ? value : [];
  const ids = source.map((id) => String(id || '').trim()).filter(Boolean);
  const filtered = allowedKnowledgeItemIds instanceof Set
    ? ids.filter((id) => allowedKnowledgeItemIds.has(id))
    : ids;
  return [...new Set(filtered)];
}

export function normalizeOriginalMaterial(value: unknown): OriginalMaterial {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sourceIds = Array.isArray(source.source_ids || source.sourceIds)
    ? (source.source_ids as unknown[]) || (source.sourceIds as unknown[])
    : [];
  const sourceTitles = Array.isArray(source.source_titles || source.sourceTitles)
    ? (source.source_titles as unknown[]) || (source.sourceTitles as unknown[])
    : [];
  const sourceHashes = Array.isArray(source.source_hashes || source.sourceHashes)
    ? (source.source_hashes as unknown[]) || (source.sourceHashes as unknown[])
    : [];
  return {
    restored: Boolean(source.restored),
    optimized: Boolean(source.optimized),
    source_ids: [...new Set(sourceIds.map((id) => String(id || '').trim()).filter(Boolean))],
    source_titles: [...new Set(sourceTitles.map((title) => singleLine(title)).filter(Boolean))],
    source_hashes: [...new Set(sourceHashes.map((hash) => String(hash || '').trim()).filter(Boolean))],
    restored_chars: Math.max(0, Math.round(Number(source.restored_chars ?? source.restoredChars) || 0)),
    ...(source.restored_at || source.restoredAt ? { restored_at: String(source.restored_at || source.restoredAt) } : {}),
    ...(source.optimized_at || source.optimizedAt ? { optimized_at: String(source.optimized_at || source.optimizedAt) } : {}),
  };
}

export function normalizeContentPlan(
  value: unknown,
  allowedKnowledgeItemIds?: Set<string> | null,
  allowedFactTitles?: Set<string> | null,
): ContentPlan {
  const v = value as Record<string, unknown> | undefined;
  const source: Record<string, unknown> = v?.plan && typeof v.plan === 'object' ? v.plan as Record<string, unknown> : v || {};
  const writing = source.writing && typeof source.writing === 'object' && !Array.isArray(source.writing) ? source.writing as Record<string, unknown> : {};
  const knowledgeSource = source.knowledge as unknown;
  const knowledge = knowledgeSource && typeof knowledgeSource === 'object' && !Array.isArray(knowledgeSource)
    ? knowledgeSource as Record<string, unknown>
    : {};
  const rawKnowledgeItemIds = Array.isArray(knowledgeSource)
    ? knowledgeSource
    : knowledge.item_ids ?? knowledge.itemIds ?? knowledge.knowledge_item_ids ?? source.knowledge_item_ids ?? source.knowledgeItemIds;
  const factsSource = source.facts as unknown;
  const facts = factsSource && typeof factsSource === 'object' && !Array.isArray(factsSource)
    ? factsSource as Record<string, unknown>
    : {};
  const rawFactTitles = Array.isArray(factsSource)
    ? factsSource
    : facts.titles ?? facts.fact_titles ?? facts.factTitles ?? source.fact_titles ?? source.factTitles ?? source.global_fact_titles ?? source.globalFactTitles;
  const table = source.table && typeof source.table === 'object' ? source.table as Record<string, unknown> : {};
  const tableNeeded = Boolean(table.needed);

  return {
    writing_focus: singleLine(source.writing_focus || source.writingFocus || writing.focus || writing.writing_focus || writing.writingFocus),
    knowledge: {
      item_ids: normalizeKnowledgeItemIds(rawKnowledgeItemIds, allowedKnowledgeItemIds),
    },
    facts: {
      titles: normalizeFactTitles(rawFactTitles, allowedFactTitles),
    },
    table: {
      needed: tableNeeded,
      purpose: tableNeeded ? singleLine(table.purpose) : '',
    },
    original_material: normalizeOriginalMaterial(source.original_material || source.originalMaterial),
  };
}

export function createStoredContentPlan(plan: unknown, tableRequirement?: unknown): ContentStoredPlan {
  const normalizedTableRequirement = tableRequirement ? normalizeTableRequirement(tableRequirement) : '';
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan: normalizeContentPlan(plan),
    ...(normalizedTableRequirement ? { table_requirement: normalizedTableRequirement } : {}),
    updated_at: now(),
  };
}

export function normalizeStoredContentPlan(value: unknown): ContentStoredPlan | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, unknown>;

  if (Number(v.plan_version ?? v.planVersion ?? 0) !== CONTENT_PLAN_VERSION) {
    return null;
  }

  if (!hasFactSelection(v)) {
    return null;
  }

  const plan = normalizeContentPlan(v.plan || v.contentPlan || v);
  if (!plan.writing_focus) {
    return null;
  }
  try {
    validateContentPlan(plan);
  } catch {
    return null;
  }
  const tableRequirement = v.table_requirement || v.tableRequirement
    ? normalizeTableRequirement(v.table_requirement || v.tableRequirement)
    : '';
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan,
    ...(tableRequirement ? { table_requirement: tableRequirement } : {}),
    updated_at: (v.updated_at as string) || (v.updatedAt as string) || now(),
  };
}

export function isStoredContentPlanReusableForTableRequirement(
  storedContentPlan: ContentStoredPlan | null | undefined,
  tableRequirement: unknown,
): boolean {
  const currentRequirement = normalizeTableRequirement(tableRequirement);
  const storedRequirement = storedContentPlan?.table_requirement || '';
  if (storedRequirement) {
    return storedRequirement === currentRequirement;
  }
  return currentRequirement === 'none';
}

export function originalMaterialFromStoredPlan(value: unknown): OriginalMaterial {
  const storedPlan = normalizeStoredContentPlan(value);
  return normalizeOriginalMaterial(storedPlan?.plan?.original_material);
}

export function needsOriginalMaterialOptimization(value: unknown): boolean {
  const originalMaterial = originalMaterialFromStoredPlan(value);
  return originalMaterial.restored && !originalMaterial.optimized;
}

export function pruneContentGenerationPlans(
  plans: Record<string, unknown> | null | undefined,
  leaves: LeafContext[],
): Record<string, ContentStoredPlan> {
  const leafIds = new Set(leaves.map(({ item }) => item.id));
  const next: Record<string, ContentStoredPlan> = {};
  for (const [itemId, value] of Object.entries(plans || {})) {
    if (!leafIds.has(itemId)) {
      continue;
    }
    const storedPlan = normalizeStoredContentPlan(value);
    if (storedPlan) {
      next[itemId] = storedPlan;
    }
  }
  return next;
}

// ---- 编排计划校验 / 格式化（cjs:614-653） ----

export function validateContentPlan(plan: unknown): void {
  if (!plan || typeof plan !== 'object') {
    throw new Error('正文编排决策必须是对象');
  }
  const p = plan as ContentPlan;
  if (!p.knowledge || !Array.isArray(p.knowledge.item_ids)) {
    throw new Error('正文编排决策缺少 knowledge.item_ids');
  }
  if (!p.facts || !Array.isArray(p.facts.titles)) {
    throw new Error('正文编排决策缺少 facts.titles');
  }
  if (typeof p.writing_focus !== 'string' || !p.writing_focus.trim()) {
    throw new Error('正文编排决策缺少 writing_focus');
  }
  if (!p.table || typeof p.table.needed !== 'boolean') {
    throw new Error('正文编排决策缺少 table.needed');
  }
}

export function formatContentPlanForPrompt(plan: ContentPlan): string {
  const lines = [
    `写作重点：${plan.writing_focus || '围绕当前章节标题和描述展开'}`,
    `事实变量：${plan.facts?.titles?.length ? plan.facts.titles.join('；') : '无'}`,
    `表格：${plan.table.needed ? `需要，目的：${plan.table.purpose || '提升正文表达清晰度'}` : '不需要，本小节不要输出 Markdown 表格'}`,
    `原方案还原：${plan.original_material?.restored ? `已还原 ${plan.original_material.restored_chars || 0} 字` : '未还原'}`,
  ];
  return lines.join('\n');
}

export function formatTablesForCleanupPrompt(tables: ContentTableBlock[]): string {
  return (tables || []).map((table) => `<table_block id="${table.id}" type="${table.type}">
上文片段：
${table.before || '无'}

待转换表格：
${table.text || ''}

下文片段：
${table.after || '无'}
</table_block>`).join('\n\n');
}

// ---- 表格清理 prompt（cjs:655-719） ----

export function buildTableCleanupMessages({ chapter, tables }: { chapter: OutlineItem | undefined; tables: ContentTableBlock[] }): ChatMessage[] {
  const allowedIds = (tables || []).map((table) => table.id).join('、') || '无';
  return [
    {
      role: 'user',
      content: `你是投标技术方案正文编辑助手。请把指定小节中的表格转换为普通文字描述。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 必须逐个处理输入中的 table_id；允许按表格内容改写为普通段落或普通列表。
3. 不改变原文意思，不删除数字、参数、工期、标准、职责、流程、承诺、验收要求、频次和数量。
4. replacement_text 只写用于替换该表格块的正文片段，不返回完整小节正文。
5. replacement_text 严禁包含 Markdown 表格、HTML <table>、代码块、章节标题或伪目录标题。
6. 如表格本身为空或无法理解，也要用一句普通文字概括其表达意图，不要返回空字符串。

返回格式：
{
  "replacements": [
    { "table_id": "T001", "replacement_text": "普通文字描述" }
  ]
}

允许的 table_id：${allowedIds}`,
    },
    {
      role: 'user',
      content: `当前小节：${chapter?.id || 'unknown'} ${chapter?.title || '未命名章节'}
小节描述：${chapter?.description || '无'}`,
    },
    {
      role: 'user',
      content: `待转换表格块：
${formatTablesForCleanupPrompt(tables)}`,
    },
  ];
}

export function normalizeTableCleanupResponse(value: unknown, allowedTableIds?: Set<string> | null): { replacements: TableCleanupReplacement[] } {
  const v = value as { result?: unknown } | undefined;
  const source: unknown = v?.result && typeof v.result === 'object' ? v.result : value || {};
  const rawReplacements = Array.isArray(source)
    ? source
    : Array.isArray((source as Record<string, unknown>)?.replacements)
      ? (source as Record<string, unknown>).replacements as unknown[]
      : Array.isArray((source as Record<string, unknown>)?.items)
        ? (source as Record<string, unknown>).items as unknown[]
        : [];
  const seen = new Set<string>();
  const replacements: TableCleanupReplacement[] = [];
  for (const item of rawReplacements) {
    const r = (item || {}) as Record<string, unknown>;
    const tableId = String(r.table_id || r.tableId || r.id || '').trim();
    const replacementText = normalizeGeneratedMarkdown(String(r.replacement_text || r.replacementText || r.text || r.content || '')).trim();
    if (!tableId || seen.has(tableId) || (allowedTableIds instanceof Set && !allowedTableIds.has(tableId)) || !replacementText) {
      continue;
    }
    replacements.push({ table_id: tableId, replacement_text: replacementText });
    seen.add(tableId);
  }
  return { replacements };
}

export function validateTableCleanupResponse(value: unknown): void {
  if (!value || !Array.isArray((value as { replacements?: unknown[] }).replacements)) {
    throw new Error('表格转换结果缺少 replacements 数组');
  }
}

// ---- 章节正文编排 / 生成 prompt（cjs:721-937） ----

export function renderKnowledgeItemsForPrompt(items: ContentKnowledgeItem[] | null | undefined): string {
  return JSON.stringify((items || []).map((item) => ({
    id: String(item.id || '').trim(),
    title: String(item.title || '').trim(),
    resume: String(item.resume || '').trim(),
  })).filter((item) => item.id && item.title && item.resume), null, 2);
}

export interface ChapterContentPlanContext {
  chapter: OutlineItem | undefined;
  parentChapters?: OutlineItem[];
  siblingChapters?: OutlineItem[];
  projectOverview?: string;
  bidAnalysisFactsText?: string;
  globalFactTitlesText?: string;
  regenerateRequirement?: string;
  tableRequirement?: string;
  maxTables?: number | null;
  tableTotalSections?: number;
  knowledgeItems?: ContentKnowledgeItem[];
}

export function buildChapterContentPlanMessages(ctx: ChapterContentPlanContext): ChatMessage[] {
  const { chapter, parentChapters, siblingChapters, projectOverview, bidAnalysisFactsText, globalFactTitlesText, regenerateRequirement, tableRequirement, maxTables, tableTotalSections, knowledgeItems } = ctx;
  const chapterId = chapter?.id || 'unknown';
  const chapterTitle = chapter?.title || '未命名章节';
  const chapterDescription = chapter?.description || '';
  const tableRequirementLabel = TABLE_REQUIREMENT_LABELS[tableRequirement || ''] || TABLE_REQUIREMENT_LABELS.heavy;
  const tablePlanningAllowed = tableRequirement !== 'none';
  const tableLimitInstruction = tableRequirement === 'heavy'
    ? '表格需求为“大量”，保持现有编排逻辑；仍然只有明显适合表格的小节才将 table.needed 设为 true。'
    : tableRequirement === 'none'
      ? '表格需求为“不要”，table.needed 必须为 false，table.purpose 留空。'
      : `表格需求为“${tableRequirementLabel}”，table.needed 表示进入表格候选池，不代表最终一定生成；全文表格上限为 ${maxTables || 0} 个，共 ${tableTotalSections || totalSections || 0} 个叶子小节，系统后续会全局择优。`;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是投标技术方案正文编排助手。请根据章节上下文判断本小节最适合的表达方式。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. ${tablePlanningAllowed ? '由你自行判断是否适合使用表格，判断要克制、合情合理，不要为了形式而硬插。' : '本次不编排表格，table.needed 必须为 false。'}
3. ${tableLimitInstruction}
4. ${tablePlanningAllowed ? '表格仅在能明显提升表达清晰度时使用，例如归纳职责、步骤、参数、风险、措施、成果等。' : '不要为了满足 JSON 格式而编造表格目的。'}
5. knowledge.item_ids 只能从参考知识库轻量条目的 id 中选择；可以多选，可以为空数组；不要编造 id，不要输出 reason。
6. facts.titles 只能从全局事实变量标题清单中选择；请选择编写本章节正文时会用到的变量组标题，可以多选，可以为空数组；不要编造标题，不要输出具体变量内容。
7. writing_focus 用 1-2 句话概括本节正文重点，只围绕当前章节标题和描述，不展开成正文，不编造具体承诺、参数、周期、品牌或型号。
8. 编排判断必须结合招标文件关键信息和全局事实变量标题，不要规划会造成时间、地点、人员、设备、标准或服务承诺前后不一致的表达。`,
    },
  ];

  messages.push({
    role: 'user',
    content: `参考知识库轻量条目（只包含 id、标题和简介，不包含正文；如无合适条目，knowledge.item_ids 返回空数组）：
${renderKnowledgeItemsForPrompt(knowledgeItems)}`,
  });

  messages.push({ role: 'user', content: `招标文件关键信息（用于判断正文需要引用哪些事实）：\n${formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText)}` });
  if (String(globalFactTitlesText || '').trim()) {
    messages.push({ role: 'user', content: `Step04 全局事实变量标题清单（编排时只能选择标题，不要输出具体变量内容）：\n${globalFactTitlesText}` });
  }

  if (parentChapters?.length) {
    messages.push({
      role: 'user',
      content: ['上级章节信息：', ...parentChapters.map((parent) => `- ${parent.id || 'unknown'} ${parent.title || '未命名章节'}\n  ${parent.description || ''}`)].join('\n'),
    });
  }

  if (siblingChapters?.length) {
    const siblingLines = ['同级章节信息：'];
    for (const sibling of siblingChapters) {
      if (sibling.id !== chapterId) {
        siblingLines.push(`- ${sibling.id || 'unknown'} ${sibling.title || '未命名章节'}\n  ${sibling.description || ''}`);
      }
    }
    if (siblingLines.length > 1) {
      messages.push({ role: 'user', content: siblingLines.join('\n') });
    }
  }

  if (String(regenerateRequirement || '').trim()) {
    messages.push({ role: 'user', content: `用户对本次重新生成的额外要求：\n${regenerateRequirement}` });
  }

  messages.push({
    role: 'user',
    content: `请为以下章节返回正文编排 JSON：

章节ID: ${chapterId}
章节标题: ${chapterTitle}
章节描述: ${chapterDescription}

JSON 格式：
{
  "writing_focus": "1-2 句话说明本节正文重点展开什么，只聚焦当前章节，不写成正文",
  "knowledge": {
    "item_ids": ["从参考知识库轻量条目中选择的 id；没有合适条目时返回空数组"]
  },
  "facts": {
    "titles": ["从全局事实变量标题清单中选择正文会用到的变量组标题；没有需要引用的变量时返回空数组"]
  },
  "table": {
    "needed": true,
    "purpose": "说明表格在本小节中要表达什么；不需要表格时留空"
  }
}`,
  });

  return messages;
}

export function formatKnowledgeContentsForPrompt(contents: unknown[] | null | undefined): string {
  return (contents || [])
    .map((content) => `<knowledge_content>\n${String(content || '').trim()}\n</knowledge_content>`)
    .join('\n\n');
}

export interface ChapterContentContext {
  chapter: OutlineItem | undefined;
  projectOverview?: string;
  selectedFactsText?: string;
  regenerateRequirement?: string;
  contentPlan?: ContentPlan;
  knowledgeContents?: unknown[];
  preSectionInstruction?: string;
  bidderName?: string;
  wordControl?: OutlineWordControlSnapshot;
  generationTarget?: number;
  preserveOriginalMaterialForWordControl?: boolean;
}

export function buildChapterContentMessages(ctx: ChapterContentContext): ChatMessage[] {
  const { chapter, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, preSectionInstruction, bidderName, wordControl, generationTarget, preserveOriginalMaterialForWordControl } = ctx;
  const chapterId = chapter?.id || 'unknown';
  const chapterTitle = chapter?.title || '未命名章节';
  const chapterDescription = chapter?.description || '';
  const tableAllowed = Boolean(contentPlan?.table?.needed);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是一个专业的标书编写专家，负责为投标文件的技术标部分生成具体内容。

要求：
1. 内容要专业、准确，与章节标题和描述保持一致。
2. 这是技术方案，不是宣传报告，注意朴实无华，不要假大空。
3. 语言要正式、规范，符合标书写作要求，但不要使用奇怪的连接词，不要让人觉得内容像是 AI 生成的。
4. 内容要详细具体，避免空泛的描述。
5. 围绕当前章节标题、描述和正文编排重点展开，保持内容聚焦。
6. ${tableAllowed ? '可以使用 Markdown 段落、列表和表格；表格必须服务于内容表达，不要为了形式硬插。' : '只能使用 Markdown 段落、普通列表和加粗引导语，严禁输出 Markdown 表格或 HTML 表格。'}
7. ${tableAllowed ? '正文只生成文字、列表、表格等内容，配图由系统另行处理。' : '正文只生成文字和普通列表，配图由系统另行处理。'}
8. 严禁输出 Mermaid、PlantUML、Graphviz、flowchart、graph、sequenceDiagram 等图表代码块、mermaid.ink 链接或图片 Markdown；配图由系统另行处理。
9. ${tableAllowed ? '表格单元格内如有多项内容，优先使用编号、顿号、分号或短句，不要使用 HTML <br> 标签。' : '如需表达多项参数、职责、流程或措施，请改用分段文字或普通列表，不要用表格模拟。'}
10. 严禁使用 Markdown 标题语法（#、##、###、####、#####、######），也不要生成与当前章节同级或下级的伪目录标题。
11. 如需在正文中分层表达，只能使用普通段落、无编号列表、表格或无编号加粗引导语，例如 **实施要点：**。
12. 加粗引导语只允许写简短主题词，禁止使用任何形式的编号。
13. 只有步骤、流程、时间顺序、操作顺序等连续性非常强的内容，才可以使用有序列表；其他分段一律使用自然段、无编号列表或无编号加粗引导语，禁止使用任何形式的编号。
14. 直接返回章节内容，不生成标题，不要任何额外说明。
15. 如果本章节需要使用的全局事实变量中包含相关内容，必须优先使用变量值，不得前后矛盾。
16. 仅使用本章节提供的全局事实变量；未提供时不要主动编造具体人员、周期、质保、品牌、型号等会影响全文一致性的承诺。`,
    },
  ];

  const trimmedBidderName = String(bidderName || '').trim();
  if (trimmedBidderName) {
    messages.push({
      role: 'user',
      content: `投标响应语气要求：
本文件是「${trimmedBidderName}」向采购人提交的投标响应，不是对招标文件的复述。请按以下要求把握语气：
1. 我方（投标方）承担的义务、承诺、职责，一律用承诺口吻表述（如“将”“承诺”“确保”“保证”）。
2. 描述我方义务的句子，不得使用规定性措辞（须、应、应当、必须、不得、需）——这些是招标方对投标方提要求的语气，不应出现在我方响应里（「需要」「必需」等表「需要」之意的词除外）。范例：把“项目组成员须遵守保密要求”改为“我方项目组全体成员将严格遵守保密要求”，把“投标人需提供方案”改为“我方将提供方案”。
3. 描述采购人（招标人、甲方）职责、权利或评审规则的句子，若使用“应”“应当”，属正常招标行文，应保留，不要改动。`,
    });
  }

  if (String(projectOverview || '').trim()) {
    messages.push({ role: 'user', content: `项目概述信息：\n${projectOverview}` });
  }
  if (String(preSectionInstruction || '').trim()) {
    messages.push({ role: 'user', content: String(preSectionInstruction || '').trim() });
  }
  const sectionWordRequirement = buildSectionWordRequirement(wordControl, Boolean(preserveOriginalMaterialForWordControl), generationTarget || 0);
  if (sectionWordRequirement) {
    messages.push({ role: 'user', content: `本小节字数要求：\n${sectionWordRequirement}` });
  }
  appendSelectedFactsMessage(messages, selectedFactsText);

  if (knowledgeContents?.length) {
    messages.push({
      role: 'user',
      content: '参考正文素材使用规则：以下内容只作为可吸收的技术素材。请改写为当前项目语境下的投标技术方案正文，不要照抄，不要提到“知识库”“历史文档”“参考资料”或素材来源。',
    });
    messages.push({
      role: 'user',
      content: `参考正文素材：\n${formatKnowledgeContentsForPrompt(knowledgeContents)}`,
    });
  }

  if (String(regenerateRequirement || '').trim()) {
    messages.push({
      role: 'user',
      content: `用户对本次重新生成的额外要求：\n${regenerateRequirement}`,
    });
  }

  if (contentPlan) {
    messages.push({
      role: 'user',
      content: `正文编排决策：\n${formatContentPlanForPrompt(contentPlan)}`,
    });
  }

  messages.push({
    role: 'user',
    content: `请为以下标书章节生成具体内容：

当前章节信息：
章节ID: ${chapterId}
章节标题: ${chapterTitle}
章节描述: ${chapterDescription}

请结合项目概述信息、本章节全局事实变量、参考正文素材和正文编排决策，围绕当前章节标题、描述和写作重点生成详细的专业内容。
直接返回编写的正文内容，不要输出标题、Markdown 标题、带任何形式编号的加粗引导语、伪目录标题、解释、总结等任何其他内容`,
  });

  return messages;
}

export interface RestoredChapterContentContext extends ChapterContentContext {
  restoredContent?: string;
}

export function buildRestoredChapterContentMessages(ctx: RestoredChapterContentContext): ChatMessage[] {
  const { restoredContent } = ctx;
  const messages = buildChapterContentMessages({
    ...ctx,
    preSectionInstruction: `当前章节已经从用户原方案中还原出正文底稿。该底稿是用户已经写好的真实技术方案内容，必须作为本章节的基础保留。

处理要求：
1. 首要遵从正文底稿，不要从零重写成另一套方案。
2. 必须保留底稿中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后和实施方法。
3. 可以调整语序、合并重复表达、提升专业性、补充细节、增加过渡和说明，让正文更完整、更适合投标文件。
4. 正文底稿中可能包含原方案 Markdown 标题行或编号标题，例如“# 第一章...”“## 第一节...”“### 二、...”“（一）...”，这些只作为章节定位线索，不属于最终正文。
5. 输出时必须跳过底稿中的章节标题、Markdown 标题和编号标题；当前章节标题会由程序统一渲染，不要在正文中重复。
6. 不要提到“原方案”“历史文档”“用户原文”或“底稿”。
7. 加粗引导语不得使用任何形式的编号；除连续性非常强的步骤、流程、操作顺序外，不得使用有序编号分段。
8. 输出当前章节完整正文，不输出标题。`,
    wordControl: ctx.wordControl,
    generationTarget: ctx.generationTarget,
    preserveOriginalMaterialForWordControl: true,
  });
  const finalMessage = messages.pop();
  if (finalMessage) {
    messages.push(finalMessage);
  }
  messages.push({
    role: 'user',
    content: `已还原正文底稿：
${String(restoredContent || '').trim()}`,
  });
  messages.push({
    role: 'user',
    content: '请基于已还原正文底稿输出当前章节完整正文。必须保留底稿中的实质内容，可以优化扩写，但不要从零重写；如果底稿开头或中间出现章节标题、Markdown 标题或编号标题，只把它当作定位线索，不要输出这些标题或解释。',
  });
  return messages;
}

// ---- 原方案分段（cjs:939-1004） ----

export function splitLongOriginalSegment(segment: { content?: string; [key: string]: unknown }): Array<{ content: string; [key: string]: unknown }> {
  const content = String(segment.content || '').trim();
  if (!content) return [];
  return splitUserTextByContextLimit(content, {}, {
    contextLengthLimit: ORIGINAL_PLAN_SEGMENT_MAX_CHARS,
    limitRatio: 1,
    maxSegmentLimitRatio: 1,
  }).map((part) => ({ ...segment, content: part.trim() })).filter((part) => part.content);
}

export function splitOriginalPlanSegments(markdown: unknown): OriginalSegment[] {
  const lines = normalizeNewlines(markdown).split('\n');
  const rawSegments: Array<{ title_path: string[]; content: string }> = [];
  let titleStack: string[] = [];
  let currentTitlePath: string[] = [];
  let buffer: string[] = [];

  function flush(): void {
    const content = buffer.join('\n').trim();
    if (content) {
      rawSegments.push({ title_path: [...currentTitlePath], content });
    }
    buffer = [];
  }

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      const title = singleLine(heading[2]);
      titleStack = titleStack.slice(0, level - 1);
      titleStack[level - 1] = title;
      currentTitlePath = titleStack.filter(Boolean);
      buffer.push(line.trim());
      continue;
    }
    buffer.push(line);
  }
  flush();

  const sourceSegments = rawSegments.length ? rawSegments : [{ title_path: [], content: String(markdown || '').trim() }];
  const segments = sourceSegments.flatMap(splitLongOriginalSegment)
    .map((segment, index) => {
      const content = String(segment.content || '').trim();
      return {
        id: `P${String(index + 1).padStart(3, '0')}`,
        title_path: Array.isArray(segment.title_path) ? segment.title_path.map((title) => singleLine(title)).filter(Boolean) : [],
        content,
        hash: textHash(content),
        chars: content.length,
      };
    })
    .filter((segment) => segment.content);

  return segments;
}

export function formatOriginalSegmentsForPrompt(segments: OriginalSegment[] | null | undefined): string {
  return (segments || []).map((segment) => `<original_segment id="${segment.id}">
标题路径：${segment.title_path?.length ? segment.title_path.join(' > ') : '未识别标题'}
字符数：${segment.chars || String(segment.content || '').length}
原文：
${segment.content}
</original_segment>`).join('\n\n');
}

export function formatRestoreTargetsForPrompt(targets: LeafContext[] | null | undefined): string {
  return (targets || []).map(({ item, parentChapters, siblingChapters }) => {
    const parentPath = (parentChapters || []).map((parent) => `${parent.id || 'unknown'} ${parent.title || '未命名章节'}`).join(' > ') || '无';
    const siblings = (siblingChapters || [])
      .filter((sibling) => sibling.id !== item.id)
      .map((sibling) => `${sibling.id || 'unknown'} ${sibling.title || '未命名章节'}`)
      .join('；') || '无';
    return `- node_id: ${item.id || 'unknown'}
  标题: ${item.title || '未命名章节'}
  描述: ${item.description || ''}
  上级章节: ${parentPath}
  同级章节: ${siblings}`;
  }).join('\n');
}

// ---- 原方案还原 prompt（cjs:1021-1155） ----

export interface OriginalMaterialRestoreContext {
  targets: LeafContext[];
  originalSegments: OriginalSegment[];
  projectOverview?: string;
  bidAnalysisFactsText?: string;
  globalFactTitlesText?: string;
}

export function buildOriginalMaterialRestoreMessages(ctx: OriginalMaterialRestoreContext): ChatMessage[] {
  const { targets, originalSegments, projectOverview, bidAnalysisFactsText, globalFactTitlesText } = ctx;
  return [
    {
      role: 'user',
      content: `你是投标技术方案原文归属判断助手。用户提供的原方案是本次要扩写的核心草稿。请判断每个原方案段落应该还原到当前目录的哪个叶子小节。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 你只能返回原方案段编号与叶子节点 ID 的映射，严禁改写、总结或生成正文。
3. node_id 必须逐字使用“当前可还原叶子节点”中给出的 ID。
4. source_ids 必须逐字使用“原方案段落”中的编号。
5. 每个原方案段默认只分配给一个最匹配的主节点；如果完全不适合当前叶子节点，可以不分配。
6. 优先按标题语义、章节职责、技术路线和同级章节边界归属，避免把同一内容拆散到无关章节。
7. 如果某个原方案段只有章节标题、Markdown 标题或目录编号，没有实质正文内容，不要把它分配为正文来源；段落开头的标题行只用于判断归属。

返回格式：
{
  "assignments": [
    { "node_id": "1.1", "source_ids": ["P001", "P002"] }
  ]
}`,
    },
    { role: 'user', content: `招标文件关键信息：\n${formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText)}` },
    { role: 'user', content: `Step04 全局事实变量标题清单：\n${globalFactTitlesText || '未提供'}` },
    { role: 'user', content: `当前可还原叶子节点：\n${formatRestoreTargetsForPrompt(targets) || '无'}` },
    { role: 'user', content: `原方案段落：\n${formatOriginalSegmentsForPrompt(originalSegments)}` },
    { role: 'user', content: '请只返回 JSON，不要生成正文。' },
  ];
}

export function buildAgentOriginalMaterialRestorePrompt(): string {
  return `你是投标技术方案原文归属判断 Agent。用户提供的原方案是本次已有方案扩写的核心草稿，请基于 workspace 输入文件判断每个原方案段落应该还原到当前目录的哪个叶子小节。

workspace 文件：
- context.md：招标文件关键信息和全局事实变量标题清单。
- restore-targets.md：当前可还原叶子节点，包含 node_id、标题、描述、上级章节和同级章节。
- original-segments.md：原方案段落，包含 source_id、标题路径、字符数和原文。

工作要求：
1. 你可以分批读取、建立索引和创建临时草稿，但最终只写入 original-restore-result.json。
2. 只判断归属映射，严禁改写、总结或生成正文。
3. node_id 必须逐字使用 restore-targets.md 中给出的 ID。
4. source_ids 必须逐字使用 original-segments.md 中给出的编号。
5. 每个原方案段默认只分配给一个最匹配的主节点；如果完全不适合当前叶子节点，可以不分配。
6. 优先按标题语义、章节职责、技术路线和同级章节边界归属，避免把同一内容拆散到无关章节。
7. 如果某个原方案段只有章节标题、Markdown 标题或目录编号，没有实质正文内容，不要把它分配为正文来源；段落开头的标题行只用于判断归属。
8. 不要修改业务数据库、不要生成 technical-plan.md，程序会读取你的输出文件后自行写回。

最终输出文件 original-restore-result.json 必须是合法 JSON，格式如下：
{
  "assignments": [
    { "node_id": "1.1", "source_ids": ["P001", "P002"] }
  ]
}`;
}

export function buildAgentOriginalMaterialRestoreFiles(ctx: OriginalMaterialRestoreContext): Array<{ path: string; content: string }> {
  const { targets, originalSegments, projectOverview, bidAnalysisFactsText, globalFactTitlesText } = ctx;
  return [
    {
      path: 'context.md',
      content: `# 招标文件关键信息
${formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText)}

# Step04 全局事实变量标题清单
${globalFactTitlesText || '未提供'}`,
    },
    {
      path: 'restore-targets.md',
      content: `# 当前可还原叶子节点
${formatRestoreTargetsForPrompt(targets) || '无'}`,
    },
    {
      path: 'original-segments.md',
      content: `# 原方案段落
${formatOriginalSegmentsForPrompt(originalSegments)}`,
    },
  ];
}

export function buildAgentRestoredChapterContentPrompt(): string {
  return `你是投标技术方案正文优化扩写 Agent。当前章节已经从用户原方案中还原出正文底稿，该底稿是用户已经写好的真实技术方案内容，必须作为本章节的基础保留。

workspace 文件：
- chapter-context.md：当前章节信息、项目概述、本章节全局事实变量、用户额外要求和正文编排决策。
- restored-content.md：已还原正文底稿。
- knowledge-contents.md：可参考的正文素材，如无则为“无”。

工作要求：
1. 首要遵从 restored-content.md，不要从零重写成另一套方案。
2. 必须保留底稿中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后和实施方法。
3. 可以调整语序、合并重复表达、提升专业性、补充细节、增加过渡和说明，让正文更完整、更适合投标文件。
4. 结合 chapter-context.md 中的项目概述、全局事实变量和正文编排决策；如存在冲突，以全局事实变量为准。
5. 可以吸收 knowledge-contents.md 中适合当前章节的技术素材，但不要提到“知识库”“历史文档”“参考资料”或素材来源。
6. 不要提到“原方案”“历史文档”“用户原文”或“底稿”。
7. 严禁输出 Mermaid、PlantUML、Graphviz、flowchart、graph、sequenceDiagram 等图表代码块、mermaid.ink 链接或图片 Markdown。
8. restored-content.md 可能包含原方案 Markdown 标题行或编号标题，例如“# 第一章...”“## 第一节...”“### 二、...”“（一）...”，这些只作为章节定位线索，不属于最终正文。
9. 不要输出章节标题、Markdown 标题、编号标题、解释、总结或过程说明；当前章节标题会由程序统一渲染。
10. 不要修改业务数据库，程序会读取你的输出文件后自行写回。

最终请把当前小节完整正文写入 optimized-section.md。该文件只能包含正文内容，不要包含标题或说明。`;
}

export function buildAgentRestoredChapterContentFiles(ctx: RestoredChapterContentContext): Array<{ path: string; content: string }> {
  const { chapter, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, restoredContent } = ctx;
  return [
    {
      path: 'chapter-context.md',
      content: `# 当前章节
章节ID: ${chapter?.id || 'unknown'}
章节标题: ${chapter?.title || '未命名章节'}
章节描述: ${chapter?.description || '无'}

说明：章节编号和章节标题由程序统一渲染，optimized-section.md 只能写正文，不要重复输出章节标题、Markdown 标题或编号标题。

# 项目概述信息
${projectOverview || '未提供'}

# 本章节需要使用的全局事实变量
${String(selectedFactsText || '').trim() || '未提供'}

# 用户对本次重新生成的额外要求
${String(regenerateRequirement || '').trim() || '无'}

# 正文编排决策
${contentPlan ? formatContentPlanForPrompt(contentPlan) : '无'}`,
    },
    {
      path: 'restored-content.md',
      content: String(restoredContent || '').trim(),
    },
    {
      path: 'knowledge-contents.md',
      content: knowledgeContents?.length ? formatKnowledgeContentsForPrompt(knowledgeContents) : '无',
    },
  ];
}

// ---- 原方案还原归一化 / 校验（cjs:1157-1232） ----

export function normalizeOriginalRestoreAssignments(
  value: unknown,
  context: { allowedNodeIds?: Set<string>; allowedSourceIds?: Set<string> },
): { assignments: OriginalRestoreAssignment[] } {
  const v = value as { result?: unknown } | undefined;
  const source: unknown = v?.result && typeof v.result === 'object' ? v.result : value || {};
  const rawAssignments = Array.isArray(source)
    ? source
    : Array.isArray((source as Record<string, unknown>)?.assignments)
      ? (source as Record<string, unknown>).assignments as unknown[]
      : Array.isArray((source as Record<string, unknown>)?.items)
        ? (source as Record<string, unknown>).items as unknown[]
        : [];
  const allowedNodeIds = context.allowedNodeIds || new Set<string>();
  const allowedSourceIds = context.allowedSourceIds || new Set<string>();
  const usedSourceIds = new Set<string>();
  const byNode = new Map<string, string[]>();

  for (const assignment of rawAssignments) {
    const a = (assignment || {}) as Record<string, unknown>;
    const nodeId = String(a.node_id || a.nodeId || a.id || '').trim();
    if (!allowedNodeIds.has(nodeId)) {
      continue;
    }
    const rawSourceIds = Array.isArray(a.source_ids || a.sourceIds)
      ? (a.source_ids as unknown[]) || (a.sourceIds as unknown[])
      : Array.isArray(a.sources)
        ? a.sources as unknown[]
        : [];
    const sourceIds = rawSourceIds
      .map((sourceId) => String(sourceId || '').trim())
      .filter((sourceId) => allowedSourceIds.has(sourceId) && !usedSourceIds.has(sourceId));
    if (!sourceIds.length) {
      continue;
    }
    for (const sourceId of sourceIds) {
      usedSourceIds.add(sourceId);
    }
    byNode.set(nodeId, [...(byNode.get(nodeId) || []), ...sourceIds]);
  }

  return {
    assignments: Array.from(byNode.entries()).map(([node_id, source_ids]) => ({
      node_id,
      source_ids: [...new Set(source_ids)],
    })),
  };
}

export function validateOriginalRestoreAssignments(value: unknown): void {
  if (!value || !Array.isArray((value as { assignments?: unknown[] }).assignments)) {
    throw new Error('原方案还原映射缺少 assignments 数组');
  }
  for (const assignment of (value as { assignments: OriginalRestoreAssignment[] }).assignments) {
    if (!assignment.node_id || !Array.isArray(assignment.source_ids)) {
      throw new Error('原方案还原映射项缺少 node_id 或 source_ids');
    }
  }
}

export function buildOriginalRestoreRepairMessages(
  repairCtx: { invalidContent?: string; issues?: string[] },
  targets: LeafContext[] | null | undefined,
  originalSegments: OriginalSegment[] | null | undefined,
): ChatMessage[] {
  const issueLines = (repairCtx.issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格 JSON 修复器。请把模型输出修复为“原方案段落归属映射”JSON。

必须满足：
1. 顶层只能包含 assignments 数组。
2. 每条 assignment 必须包含 node_id 和 source_ids。
3. node_id 只能使用当前可还原叶子节点中的 ID。
4. source_ids 只能使用原方案段落编号。
5. 如果某个原方案段只有章节标题、Markdown 标题或目录编号，没有实质正文内容，不要把它分配为正文来源；如果待修复内容中包含这类 source_id，请从 source_ids 中移除。
6. 严禁输出正文、总结、解释或 Markdown。`,
    },
    { role: 'user', content: `当前可还原叶子节点：\n${formatRestoreTargetsForPrompt(targets) || '无'}` },
    { role: 'user', content: `原方案段落（用于判断 source_ids 是否只有标题、编号或实质正文）：\n${formatOriginalSegmentsForPrompt(originalSegments) || '无'}` },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(repairCtx.invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

// ---- 目录格式化 / 节点映射（cjs:1234-1274） ----

export function formatOutlineForPrompt(items: OutlineItem[] | null | undefined, level = 1, lines: string[] = []): string {
  for (const item of items || []) {
    const indent = '  '.repeat(Math.max(0, level - 1));
    lines.push(`${indent}- ${item.id || 'unknown'} ${item.title || '未命名章节'}：${item.description || ''}`);
    if (item.children?.length) {
      formatOutlineForPrompt(item.children, level + 1, lines);
    }
  }
  return lines.join('\n');
}

export function createOutlineNodeMap(items: OutlineItem[] | null | undefined): Map<string, OutlineNodeInfo> {
  const map = new Map<string, OutlineNodeInfo>();
  function visit(nodes: OutlineItem[] | null | undefined, level = 1, parent: OutlineItem | null = null): void {
    for (const item of nodes || []) {
      const id = String(item?.id || '').trim();
      if (id) {
        map.set(id, { item, level, parent });
      }
      if (item?.children?.length) {
        visit(item.children, level + 1, item);
      }
    }
  }
  visit(items || []);
  return map;
}

export function formatOutlineExpansionContext(
  items: OutlineItem[] | null | undefined,
  level = 1,
  lines: string[] = [],
  restoredNodeIds: Set<string> = new Set(),
): string {
  for (const item of items || []) {
    const id = String(item?.id || 'unknown').trim() || 'unknown';
    const title = singleLine(item?.title || '未命名章节');
    const indent = '  '.repeat(Math.max(0, level - 1));
    const addState = restoredNodeIds.has(id) ? 'locked-restored' : level >= 1 && level <= 3 ? `add:L${level + 1}` : 'locked';
    lines.push(`${indent}- ${id} | L${level} | ${addState} | ${title}`);
    if (item?.children?.length) {
      formatOutlineExpansionContext(item.children, level + 1, lines, restoredNodeIds);
    }
  }
  return lines.join('\n');
}

// ---- 补目录 prompt / 归一化（cjs:1276-1461） ----

export interface OutlineExpansionContext {
  projectOverview?: string;
  globalFactsText?: string;
  outlineData: OutlinePayload;
  currentWords: number;
  minimumWords: number;
  medianLeafWords: number;
  round: number;
  nodeMap: Map<string, OutlineNodeInfo>;
  restoredNodeIds?: Set<string>;
}

export function buildOutlineExpansionMessages(ctx: OutlineExpansionContext): ChatMessage[] {
  const { projectOverview, globalFactsText, outlineData, currentWords, minimumWords, medianLeafWords, round, nodeMap, restoredNodeIds } = ctx;
  const sampleParentId = Array.from(nodeMap.entries()).find(([id, info]) => info.level === 1 && !restoredNodeIds?.has(id))?.[0] || '1';
  return [
    {
      role: 'user',
      content: `你是投标技术方案目录补充专家。当前技术方案正文字数不足，需要通过补充二级、三级或四级目录扩展可生成正文的空间。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 只能新增二级、三级、四级目录，严禁新增、删除、重命名或调整一级目录。
3. parent_id 只能使用目录上下文中标记为 add:* 的节点 ID，必须逐字复制；locked 和 locked-restored 节点不能作为 parent_id。
4. 只输出新增目录，不要输出完整目录，不要输出正文内容。
5. 允许补充通用但不违背项目的技术方案内容，例如组织管理、质量控制、安全管理、进度保障、验收交付、运维服务、培训计划、资料管理、风险控制、应急响应等。
6. 不要重复已有目录，不要输出明显凑字数的空泛标题。
7. 四级目录不能再包含 children。
8. 新增目录不得引入与全局事实变量冲突的项目范围、周期、地点、验收、质保、售后或技术边界方向。
9. locked-restored 节点已经承载用户原方案正文，严禁新增子节点，不允许把已还原正文节点拆成下级目录。

返回格式：
{
  "additions": [
    {
      "parent_id": "${sampleParentId}",
      "title": "新增目录标题",
      "description": "新增目录说明",
      "children": [
        { "title": "可选下级目录标题", "description": "可选下级目录说明" }
      ]
    }
  ]
}`,
    },
    { role: 'user', content: `项目概述：\n${projectOverview || '未提供'}` },
    ...(String(globalFactsText || '').trim() ? [{ role: 'user' as const, content: `全局事实变量（新增目录不得冲突）：\n${globalFactsText}` }] : []),
    { role: 'user', content: `目录上下文（每行：id | 层级 | 可挂载状态 | 标题）：\n${formatOutlineExpansionContext(outlineData.outline || [], 1, [], restoredNodeIds)}` },
    { role: 'user', content: `当前总字数：${currentWords}\n预期最低字数：${minimumWords}\n当前叶子节点字数中位数：${medianLeafWords}\n本次补目录轮次：${round}/${MAX_OUTLINE_EXPANSION_ROUNDS}\n请只返回新增目录 JSON。` },
  ];
}

export function normalizeFieldName(value: unknown): string {
  return String(value || '').replace(/[_\-\s]/g, '').toLowerCase();
}

export function collectUnexpectedOutlineExpansionKeys(
  value: Record<string, unknown> | null | undefined,
  path: string,
  allowedKeys: Set<string>,
  issues: string[],
): void {
  for (const key of Object.keys(value || {})) {
    if (allowedKeys.has(key)) {
      continue;
    }
    const normalizedKey = normalizeFieldName(key);
    if (OUTLINE_EXPANSION_FORBIDDEN_KEY_NAMES.has(normalizedKey)) {
      issues.push(`${path}.${key} 不允许返回完整目录、正文、图片、表格或编排计划字段`);
    } else {
      issues.push(`${path}.${key} 不是允许的新增目录字段`);
    }
  }
}

export function normalizeOutlineExpansionChild(
  value: unknown,
  level: number,
  path: string,
  issues: string[],
  allowedKeys: Set<string> = OUTLINE_EXPANSION_CHILD_KEYS,
): { title: string; description: string; children?: unknown[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${path} 必须是对象`);
    return null;
  }
  const v = value as Record<string, unknown>;
  collectUnexpectedOutlineExpansionKeys(v, path, allowedKeys, issues);
  const title = singleLine(v.title || v.name);
  if (!title) {
    issues.push(`${path}.title 缺失`);
    return null;
  }
  const description = String(v.description || v.summary || v.resume || title).trim() || title;
  const node: { title: string; description: string; children?: unknown[] } = { title, description };
  if (level < 4 && Array.isArray(v.children) && v.children.length) {
    const children: unknown[] = [];
    v.children.forEach((child, index) => {
      const normalized = normalizeOutlineExpansionChild(child, level + 1, `${path}.children[${index}]`, issues);
      if (normalized) children.push(normalized);
    });
    if (children.length) node.children = children;
  }
  if (level >= 4 && Array.isArray(v.children) && v.children.length) {
    issues.push(`${path}.children 四级目录不能包含下级目录`);
  }
  return node;
}

export function normalizeOutlineExpansionResponse(
  payload: unknown,
  context: { nodeMap: Map<string, OutlineNodeInfo>; restoredNodeIds?: Set<string> },
): OutlineExpansionPatch {
  const p = payload as { result?: unknown } | undefined;
  const raw: unknown = p?.result && typeof p.result === 'object' ? p.result : payload || {};
  const issues: string[] = [];
  const additions: OutlineExpansionAddition[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('补目录返回格式无效：顶层必须是只包含 additions 数组的对象');
  }

  collectUnexpectedOutlineExpansionKeys(raw as Record<string, unknown>, 'root', OUTLINE_EXPANSION_TOP_LEVEL_KEYS, issues);

  const r = raw as Record<string, unknown>;
  if (r.additions === undefined) {
    issues.push('root.additions 缺失');
  } else if (!Array.isArray(r.additions)) {
    issues.push('root.additions 必须是数组');
  }

  const candidates = Array.isArray(r.additions) ? r.additions : [];

  candidates.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      issues.push(`additions[${index}] 必须是对象`);
      return;
    }
    const c = candidate as Record<string, unknown>;
    const parentId = String(c.parent_id || c.parentId || '').trim();
    const parentInfo = context.nodeMap.get(parentId);
    if (!parentId || !parentInfo || parentInfo.level < 1 || parentInfo.level > 3) {
      issues.push(`additions[${index}].parent_id 无效：${parentId || '空'}`);
      return;
    }
    if (context.restoredNodeIds?.has(parentId)) {
      issues.push(`additions[${index}].parent_id 不能使用已还原原方案正文的节点：${parentId}`);
      return;
    }
    const child = normalizeOutlineExpansionChild(candidate, parentInfo.level + 1, `additions[${index}]`, issues, OUTLINE_EXPANSION_ADDITION_KEYS);
    if (child) {
      additions.push({ parent_id: parentId, ...child });
    }
  });

  if (issues.length) {
    throw new Error(`补目录返回格式无效：${issues.join('；')}`);
  }

  return { additions };
}

export function validateOutlineExpansionResponse(payload: unknown): void {
  if (!payload || !Array.isArray((payload as { additions?: unknown[] }).additions)) {
    throw new Error('补目录结果缺少 additions 数组');
  }
}

export function buildOutlineExpansionRepairMessages(
  repairCtx: { invalidContent?: string; issues?: string[] },
  outlineItems: OutlineItem[] | null | undefined,
  restoredNodeIds: Set<string> = new Set(),
): ChatMessage[] {
  const issueLines = (repairCtx.issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格 JSON 修复器。请把模型输出修复为“最低字数补目录”JSON。

必须满足：
1. 顶层只能有 additions 数组。
2. 每条 additions 必须包含 parent_id、title、description，可以包含 children。
3. parent_id 只能使用目录上下文中标记为 add:* 的节点 ID，必须逐字复制；locked 和 locked-restored 节点不能作为 parent_id。
4. 只能新增二级、三级、四级目录；四级目录不能包含 children。
5. 禁止输出完整 outline、正文、图片、表格或解释文字。
6. 如果没有可补充目录，返回 {"additions":[]}。
7. locked-restored 节点已经承载用户原方案正文，严禁新增子节点。

目录上下文（每行：id | 层级 | 可挂载状态 | 标题）：
${formatOutlineExpansionContext(outlineItems || [], 1, [], restoredNodeIds)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(repairCtx.invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

// ---- 正文扩写 prompt / 归一化（cjs:1463-1562） ----

export interface ContentExpansionContext {
  outlineData: OutlinePayload;
  context: LeafContext;
  projectOverview?: string;
  selectedFactsText?: string;
  currentContent: string;
  currentWords: number;
  targetWords: number;
  mode?: 'expand' | 'shrink';
}

export function buildContentExpansionMessages(ctx: ContentExpansionContext): ChatMessage[] {
  const { outlineData, context, projectOverview, selectedFactsText, currentContent, currentWords, targetWords } = ctx;
  const mode = ctx.mode === 'shrink' ? 'shrink' : 'expand';
  const { item, parentChapters, siblingChapters } = context;
  const chapterPath = [...(parentChapters || []), item]
    .map((chapter) => `${chapter.id || 'unknown'} ${chapter.title || '未命名章节'}`)
    .join(' > ');
  const siblingLines = (siblingChapters || [])
    .filter((chapter) => chapter.id !== item.id)
    .map((chapter) => `- ${chapter.id || 'unknown'} ${chapter.title || '未命名章节'}：${chapter.description || ''}`)
    .join('\n');

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文${mode === 'shrink' ? '精简' : '扩写'}助手。请只针对指定章节进行${mode === 'shrink' ? '精简压缩' : '扩写'}，避免与其他章节重复。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 不要返回完整正文，只返回一次局部${mode === 'shrink' ? '精简' : '扩写'}操作。
3. operation ${mode === 'shrink' ? '必须' : '只能'}是 "replace"${mode === 'shrink' ? '，不得使用 insert。' : ' 或 "insert"。'}
${mode === 'shrink' ? '4. replace 表示重写并压缩某个完整 Markdown 原文块，target_text 必须逐字复制当前章节原正文中的完整待替换块。\n5. content 只写压缩后的替换片段，不要删除关键承诺、参数、时间、人员、验收、售后、风险控制等实质信息。' : '4. insert 表示新增一个或多个段落，anchor 填写建议插入在哪个原段落之后；如果适合放末尾，anchor 写 "end"。\n5. replace 表示重写并扩写某个完整 Markdown 原文块，target_text 必须逐字复制当前章节原正文中的完整待替换块。\n6. content 只写新增或替换后的正文片段，不要包含章节标题。'}
7. 禁止输出图片 Markdown、Mermaid、代码块或其他图表代码。
8. 扩写内容必须服务当前章节，不要写其他目录应承载的内容。
9. 严禁使用 Markdown 标题语法（#、##、###、####、#####、######），也不要新增伪目录标题；需要分层时使用普通段落、无编号列表或无编号加粗引导语。
10. 加粗引导语禁止使用任何形式的编号。
11. 只有步骤、流程、时间顺序、操作顺序等连续性非常强的内容，才可以使用有序列表；其他分段禁止使用任何形式的编号。
12. 如果本章节需要使用的全局事实变量中包含相关内容，扩写必须优先使用变量值，不得新增前后不一致的时间、地点、人员、设备、标准或服务承诺。
13. 使用 replace 时，如果目标块是 Markdown 列表、表格、引用、加粗引导块或连续多行结构，target_text 必须包含完整结构，不得只返回第一项、表头、关键句或摘要。
14. 使用 replace 时，target_text 不得改写标点、空格、换行、列表符号、表格分隔线或 Markdown 标记，也不得选择图片 Markdown、Mermaid 或代码块作为替换目标。

返回格式：
{
  "operation": "insert",
  "anchor": "end",
  "target_text": "replace 时填写逐字复制的完整待替换 Markdown 原文块，insert 时留空",
  "content": "扩写后的新增段落或替换段落"
}`,
    },
    { role: 'user', content: `项目概述：\n${projectOverview || '未提供'}` },
    { role: 'user', content: `完整目录：\n${formatOutlineForPrompt(outlineData.outline || [])}` },
    ...(String(selectedFactsText || '').trim() ? [{ role: 'user' as const, content: `本章节需要使用的全局事实变量（扩写涉及这些内容时必须参考）：\n${selectedFactsText}` }] : []),
    { role: 'user', content: `当前章节路径：${chapterPath}\n当前章节描述：${item.description || ''}` },
    { role: 'user', content: `同级章节（扩写时避免重复）：\n${siblingLines || '无'}` },
    { role: 'user', content: `当前章节原正文：\n${currentContent}` },
    { role: 'user', content: mode === 'shrink'
      ? `当前章节统计字数：${currentWords}\n期望本章节精简后接近或不超过：${targetWords}\n请返回一次局部精简 JSON。`
      : `当前章节统计字数：${currentWords}\n期望本章节扩写后至少达到：${targetWords}\n请返回一次局部扩写 JSON。` },
  ];
}

export function normalizeContentExpansionPatch(value: unknown): ContentExpansionPatch {
  const v = value as { result?: unknown } | undefined;
  const source: unknown = v?.result && typeof v.result === 'object' ? v.result : value || {};
  const s = source as Record<string, unknown>;
  const rawPatchArray = Array.isArray(s.operations) ? s.operations : Array.isArray(s.patches) ? s.patches : null;
  const rawPatch: Record<string, unknown> = rawPatchArray ? (rawPatchArray[0] as Record<string, unknown>) || {} : s;
  const operation = String(rawPatch.operation || rawPatch.type || '').trim().toLowerCase();
  const anchor = singleLine(rawPatch.anchor || rawPatch.position || rawPatch.after || rawPatch.target || rawPatch.replace_target || 'end') || 'end';
  const targetText = normalizeNewlines(rawPatch.target_text ?? rawPatch.targetText ?? rawPatch.old_text ?? rawPatch.oldText ?? '').trim();
  const content = normalizeGeneratedMarkdown(String(rawPatch.content || rawPatch.paragraph || rawPatch.text || rawPatch.new_content || ''))
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .trim();
  return { operation, anchor, target_text: targetText, content };
}

export function validateContentExpansionPatch(patch: ContentExpansionPatch | null | undefined): void {
  if (!patch || !['insert', 'replace'].includes(patch.operation)) {
    throw new Error(`扩写结果 operation 无效：${patch?.operation || '空'}，只能是 insert 或 replace`);
  }
  if (patch.operation === 'replace' && !String(patch.target_text || '').trim()) {
    throw new Error('扩写 replace 结果缺少 target_text');
  }
  if (!String(patch.content || '').trim()) {
    throw new Error('扩写结果缺少 content');
  }
}

export function buildContentExpansionRepairMessages(
  repairCtx: { invalidContent?: string; issues?: string[] },
  currentContent: string = '',
): ChatMessage[] {
  const issueLines = (repairCtx.issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const currentContentBlock: ChatMessage[] = String(currentContent || '').trim()
    ? [{ role: 'user', content: `当前正文，用于 replace 时逐字复制 target_text：\n${String(currentContent || '').slice(0, 60000)}` }]
    : [];
  return [
    {
      role: 'user',
      content: `你是严格 JSON 修复器。请把模型输出修复为“正文局部扩写”JSON。

必须满足：
1. 顶层只能包含 operation、anchor、target_text、content。
2. operation 只能是 "insert" 或 "replace"。
3. 严禁使用 delete、rewrite_full、rewrite、append、update 或其他 operation。
4. insert 表示新增段落；anchor 写建议插入在哪个原段落之后，无法确定时写 "end"。
5. replace 表示重写并扩写一个完整 Markdown 原文块；target_text 必须逐字复制完整待替换块，不得摘要、改写或只返回其中一句。
6. content 只能是新增或替换后的正文片段，不要返回完整章节正文。
7. content 不得包含章节标题、Markdown 标题、图片 Markdown、Mermaid、代码块或解释文字。
8. insert 时 target_text 留空；replace 时 anchor 可留空，但 target_text 必须非空。
9. 只返回 JSON，不要输出 Markdown 代码围栏或解释。`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    ...currentContentBlock,
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(repairCtx.invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

// ---- JSON 解析 / 行号 / 一致性 patch（cjs:1564-1850） ----

export function normalizeNewlines(text: unknown): string {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function extractFencedAgentJsonBlocks(content: unknown): string[] {
  const blocks: string[] = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(content || '')))) {
    blocks.push(match[1]);
  }
  return blocks;
}

export function extractBalancedAgentJsonCandidate(content: unknown): string {
  const source = String(content || '');
  const start = source.search(/[\[{]/);
  if (start < 0) return '';

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack[stack.length - 1] !== char) return '';
      stack.pop();
      if (!stack.length) return source.slice(start, index + 1);
    }
  }

  return '';
}

export function parseAgentJsonContent(content: unknown): unknown {
  const normalized = String(content || '').replace(/^﻿/, '').trim();
  const candidates = [
    normalized,
    ...extractFencedAgentJsonBlocks(normalized),
    extractBalancedAgentJsonCandidate(normalized),
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];
  let lastError: unknown = null;

  for (const candidate of uniqueCandidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Agent 未返回可解析的 JSON：${(lastError as { message?: string })?.message || '内容为空'}`);
}

export function stripPromptLineNumbers(text: unknown): string {
  return normalizeNewlines(text)
    .split('\n')
    .map((line) => line.replace(/^\[\d{1,6}\]\s?/, ''))
    .join('\n');
}

export function normalizeConsistencyPatchText(text: unknown): string {
  return stripPromptLineNumbers(text).trim();
}

export function formatChapterPath(context: LeafContext | null | undefined): string {
  return [...(context?.parentChapters || []), context?.item]
    .filter((chapter) => chapter)
    .map((chapter) => `${chapter?.id || 'unknown'} ${chapter?.title || '未命名章节'}`)
    .join(' > ');
}

export function formatContentWithLineNumbers(content: unknown): string {
  const lines = normalizeNewlines(content).split('\n');
  const width = Math.max(3, String(lines.length).length);
  return lines
    .map((line, index) => `[${String(index + 1).padStart(width, '0')}] ${line}`)
    .join('\n');
}

export function escapeSectionAttribute(value: unknown): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function parseAgentSectionMarkdown(markdown: unknown): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = normalizeNewlines(markdown).split('\n');
  let currentId = '';
  let buffer: string[] = [];

  for (const line of lines) {
    const startMatch = /^\s*<!--\s*yibiao-section-start\s+id="([^"]+)"[^>]*-->\s*$/.exec(line);
    if (startMatch) {
      if (currentId) {
        throw new Error(`Agent 输出的小节标记嵌套：${currentId} 内出现 ${startMatch[1]}`);
      }
      currentId = String(startMatch[1] || '').trim();
      buffer = [];
      continue;
    }

    const endMatch = /^\s*<!--\s*yibiao-section-end\s+id="([^"]+)"\s*-->\s*$/.exec(line);
    if (endMatch) {
      const endId = String(endMatch[1] || '').trim();
      if (!currentId) {
        throw new Error(`Agent 输出存在未配对的小节结束标记：${endId}`);
      }
      if (endId !== currentId) {
        throw new Error(`Agent 输出小节标记不匹配：${currentId} / ${endId}`);
      }
      if (sections.has(currentId)) {
        throw new Error(`Agent 输出重复小节：${currentId}`);
      }
      sections.set(currentId, buffer.join('\n').trim());
      currentId = '';
      buffer = [];
      continue;
    }

    if (currentId) {
      buffer.push(line);
    }
  }

  if (currentId) {
    throw new Error(`Agent 输出小节未闭合：${currentId}`);
  }
  return sections;
}

export function findExactOccurrences(content: string, search: string): number[] {
  const indexes: number[] = [];
  if (!search) return indexes;
  let startIndex = 0;
  while (startIndex <= content.length) {
    const index = content.indexOf(search, startIndex);
    if (index < 0) break;
    indexes.push(index);
    startIndex = index + search.length;
  }
  return indexes;
}

export function extractLineRangeText(content: unknown, startLine: unknown, endLine: unknown): string | null {
  const lines = normalizeNewlines(content).split('\n');
  const start = Math.max(1, Math.round(Number(startLine) || 0));
  const end = Math.max(start, Math.round(Number(endLine) || 0));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > lines.length) {
    return null;
  }
  return lines.slice(start - 1, end).join('\n');
}

export function replaceLineRange(content: unknown, startLine: unknown, endLine: unknown, replacement: unknown): string {
  const lines = normalizeNewlines(content).split('\n');
  const start = Math.max(1, Math.round(Number(startLine) || 0));
  const end = Math.max(start, Math.round(Number(endLine) || 0));
  const nextLines = [
    ...lines.slice(0, start - 1),
    ...normalizeNewlines(replacement).split('\n'),
    ...lines.slice(end),
  ];
  return nextLines.join('\n');
}

export interface ConsistencyPatchDetail {
  section_id: string;
  start_line: number;
  end_line: number;
  old_text: string;
  new_text: string;
  old_text_metrics: { chars: number; hash: string };
  new_text_metrics: { chars: number; hash: string };
  before_content_metrics: { chars: number; hash: string };
  line_range: { exists: boolean; matches_old_text: boolean; candidate_metrics: { chars: number; hash: string } | null } | null;
  exact_match_count: number;
}

export function describeConsistencyPatchMatch(content: unknown, patch: ConsistencyPatch): ConsistencyPatchDetail {
  const currentContent = normalizeNewlines(content);
  const oldText = normalizeConsistencyPatchText(patch.old_text);
  const newText = normalizeConsistencyPatchText(patch.new_text);
  const startLine = Number(patch.start_line);
  const endLine = Number(patch.end_line);
  const detail: ConsistencyPatchDetail = {
    section_id: singleLine(patch.section_id),
    start_line: Number.isFinite(startLine) ? startLine : 0,
    end_line: Number.isFinite(endLine) ? endLine : 0,
    old_text: oldText,
    new_text: newText,
    old_text_metrics: textMetrics(oldText),
    new_text_metrics: textMetrics(newText),
    before_content_metrics: textMetrics(currentContent),
    line_range: null,
    exact_match_count: 0,
  };

  if (Number.isFinite(startLine) && Number.isFinite(endLine) && startLine > 0 && endLine >= startLine) {
    const candidate = extractLineRangeText(currentContent, startLine, endLine);
    detail.line_range = {
      exists: candidate !== null,
      matches_old_text: candidate === oldText,
      candidate_metrics: candidate === null ? null : textMetrics(candidate),
    };
  }

  detail.exact_match_count = findExactOccurrences(currentContent, oldText).length;
  return detail;
}

export function applyExactConsistencyPatch(content: unknown, patch: ConsistencyPatch): string {
  const currentContent = normalizeNewlines(content);
  const oldText = normalizeConsistencyPatchText(patch.old_text);
  const newText = normalizeConsistencyPatchText(patch.new_text);
  if (!oldText) {
    throw new Error('old_text 为空');
  }
  if (!newText) {
    throw new Error('new_text 为空');
  }
  if (oldText === newText) {
    throw new Error('old_text 与 new_text 相同');
  }

  const startLine = Number(patch.start_line);
  const endLine = Number(patch.end_line);
  if (Number.isFinite(startLine) && Number.isFinite(endLine) && startLine > 0 && endLine >= startLine) {
    const candidate = extractLineRangeText(currentContent, startLine, endLine);
    if (candidate === oldText) {
      return replaceLineRange(currentContent, startLine, endLine, newText);
    }
  }

  const matches = findExactOccurrences(currentContent, oldText);
  if (!matches.length) {
    throw new Error('old_text 未在当前小节正文中找到');
  }
  if (matches.length > 1) {
    throw new Error('old_text 在当前小节正文中出现多次，请提供更多上下文确保唯一定位');
  }
  const index = matches[0];
  return `${currentContent.slice(0, index)}${newText}${currentContent.slice(index + oldText.length)}`;
}

export interface ConsistencyRepairResult {
  content: string;
  appliedCount: number;
  errors: string[];
  patchResults: Array<ConsistencyPatchDetail & { applied: boolean; after_content_metrics?: { chars: number; hash: string }; error?: string }>;
}

export function applyConsistencyRepairPatches(content: unknown, patches: ConsistencyPatch[] | null | undefined): ConsistencyRepairResult {
  let nextContent = normalizeNewlines(content);
  const errors: string[] = [];
  const patchResults: ConsistencyRepairResult['patchResults'] = [];
  let appliedCount = 0;

  for (const [index, patch] of (patches || []).entries()) {
    const detail = { index, ...describeConsistencyPatchMatch(nextContent, patch) };
    try {
      nextContent = applyExactConsistencyPatch(nextContent, patch);
      appliedCount += 1;
      patchResults.push({
        ...detail,
        applied: true,
        after_content_metrics: textMetrics(nextContent),
      });
    } catch (error) {
      errors.push(`patch[${index}] ${(error as { message?: string }).message || '应用失败'}`);
      patchResults.push({
        ...detail,
        applied: false,
        error: (error as { message?: string }).message || '应用失败',
        after_content_metrics: textMetrics(nextContent),
      });
    }
  }

  return { content: nextContent, appliedCount, errors, patchResults };
}

// ---- 一致性审计 / 修复（cjs:1852-2078） ----

export function formatConsistencyAuditGroupContent(group: ConsistencyAuditGroup): string {
  return (group.items || []).map((entry) => `<section>
编号：${entry.item.id || 'unknown'}
标题：${entry.item.title || '未命名章节'}
路径：${formatChapterPath(entry)}
正文：
${entry.content || ''}
</section>`).join('\n\n');
}

export function buildConsistencyAuditMessages(ctx: { group: ConsistencyAuditGroup; globalFactsText?: string; bidAnalysisFactsText?: string; bidderName?: string }): ChatMessage[] {
  const { group, globalFactsText, bidAnalysisFactsText, bidderName } = ctx;
  const allowedIds = (group.items || []).map(({ item }) => item.id).filter(Boolean) as string[];
  const voiceEnabled = Boolean(String(bidderName || '').trim());
  const styleRule = voiceEnabled
    ? '4. 不报告文风、质量、重复、篇幅、表达优化等问题；但投标方（我方）义务处出现规定性措辞（须、应、应当、必须、不得，且非描述采购人职责）属语气冲突，需报告。'
    : '4. 不报告文风、质量、重复、篇幅、表达优化等问题。';
  const voiceRule = voiceEnabled
    ? '\n7. 若发现上述语气冲突，fact_title 填“投标响应语气”，evidence 摘录原句，reason 说明应改为承诺口吻（将/承诺），severity 用 medium。'
    : '';
  return [
    {
      role: 'user',
      content: `你是投标技术方案全文一致性审计助手。请审计本组正文是否与给定事实冲突。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 只找正文中已经明确写出、且与事实相违背的内容。
3. 正文没有涉及某条事实时，不要报告缺失，不要建议补充。
${styleRule}
5. section_id 必须来自允许的目录编号清单，禁止编造编号。
6. 只筛选冲突目录编号和冲突证据，不要重写正文。${voiceRule}

返回格式：
{
  "conflicts": [
    {
      "section_id": "1.2.3",
      "fact_title": "相关事实变量标题",
      "evidence": "正文中的冲突原文摘录",
      "reason": "为什么与事实冲突",
      "severity": "high"
    }
  ]
}`,
    },
    { role: 'user', content: `Step04 全局事实变量：\n${globalFactsText || '未提供'}` },
    { role: 'user', content: `Step02 关键解析结果（项目信息、甲方信息、交货和服务要求）：\n${bidAnalysisFactsText || '未提供'}` },
    { role: 'user', content: `允许返回的目录编号清单：\n${JSON.stringify(allowedIds, null, 2)}` },
    { role: 'user', content: `待审计正文分组：\n${formatConsistencyAuditGroupContent(group)}` },
  ];
}

export function normalizeConsistencyAuditResponse(value: unknown, allowedSectionIds?: Set<string> | string[] | null): { conflicts: ConsistencyConflict[] } {
  const v = value as { result?: unknown } | undefined;
  const source: unknown = v?.result && typeof v.result === 'object' ? v.result : value || {};
  const rawConflicts = Array.isArray(source)
    ? source
    : Array.isArray((source as Record<string, unknown>)?.conflicts)
      ? (source as Record<string, unknown>).conflicts as unknown[]
      : Array.isArray((source as Record<string, unknown>)?.items)
        ? (source as Record<string, unknown>).items as unknown[]
        : [];
  const allowed = allowedSectionIds instanceof Set ? allowedSectionIds : new Set(allowedSectionIds || []);
  const issues: string[] = [];
  const conflicts: ConsistencyConflict[] = [];

  rawConflicts.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`conflicts[${index}] 必须是对象`);
      return;
    }
    const i = item as Record<string, unknown>;
    const sectionId = singleLine(i.section_id || i.sectionId || i.id || i.chapter_id || i.chapterId);
    if (!sectionId || !allowed.has(sectionId)) {
      issues.push(`conflicts[${index}].section_id 无效：${sectionId || '空'}`);
      return;
    }
    conflicts.push({
      section_id: sectionId,
      fact_title: singleLine(i.fact_title || i.factTitle || i.fact || i.title),
      evidence: String(i.evidence || i.quote || i.source || '').trim(),
      reason: String(i.reason || i.description || i.issue || '').trim(),
      severity: singleLine(i.severity || 'medium') || 'medium',
    });
  });

  if (issues.length) {
    throw new Error(`审计结果格式无效：${issues.join('；')}`);
  }
  return { conflicts };
}

export function validateConsistencyAuditResponse(value: unknown): void {
  if (!value || !Array.isArray((value as { conflicts?: unknown[] }).conflicts)) {
    throw new Error('一致性审计结果缺少 conflicts 数组');
  }
}

export function buildConsistencyAuditRepairMessages(
  repairCtx: { invalidContent?: string; issues?: string[] },
  allowedSectionIds: Set<string> | string[],
): ChatMessage[] {
  const issueLines = (repairCtx.issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格 JSON 修复器。请把模型输出修复为“全文一致性审计”JSON。

必须满足：
1. 顶层只能包含 conflicts 数组。
2. conflicts 可以为空数组。
3. 每条 conflict 必须包含 section_id、fact_title、evidence、reason、severity。
4. section_id 只能来自允许清单。
5. 禁止输出正文、修复方案、Markdown 或解释文字。

允许的 section_id：
${JSON.stringify(Array.from(allowedSectionIds || []), null, 2)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(repairCtx.invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

export interface ConsistencyRepairContext {
  context: LeafContext;
  conflicts: ConsistencyConflict[];
  globalFactsText?: string;
  bidAnalysisFactsText?: string;
  currentContent: string;
  attempt: number;
  failures?: string[];
  tableRequirement?: unknown;
}

export function buildConsistencyRepairMessages(ctx: ConsistencyRepairContext): ChatMessage[] {
  const { context, conflicts, globalFactsText, bidAnalysisFactsText, currentContent, attempt, failures, tableRequirement } = ctx;
  const { item } = context;
  const tableAllowed = normalizeTableRequirement(tableRequirement) !== 'none';
  const failureBlock = (failures || []).length
    ? `\n上次修复应用失败原因：\n${(failures || []).map((failure, index) => `${index + 1}. ${failure}`).join('\n')}\n请重新返回能够在当前正文中唯一定位的 old_text。`
    : '';

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文一致性修复助手。请只针对当前小节返回局部精确替换 patch。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 不要返回完整正文，只返回需要局部替换的 patches。
3. 事实输入比当前小节实际需要的更多；正文没有涉及的事实必须忽略。
4. 目标只修正正文中与事实冲突的内容，不要参照事实重写或扩充正文。
5. 不要优化文风，不要新增无关事实，不要新增新的承诺；但 fact_title 为“投标响应语气”的冲突，需把该句规定性词（须/应/应当/必须/不得）改写为承诺口吻（将/承诺），仅改该语气点，不得改动其他内容。
6. old_text 必须是当前小节正文中逐字存在的原文块，建议包含足够前后上下文，确保只出现一次。
7. ${tableAllowed ? '如果修改表格，old_text 必须包含完整表格行或完整表格块，不要只返回单元格碎片。' : '本次配置为不要表格；如果冲突位于表格中，new_text 必须把相关内容改为普通文字或普通列表，不得继续返回 Markdown 表格或 HTML 表格。'}
8. new_text 是替换后的正文块，不要包含章节标题，不要包含行号。
9. ${tableAllowed ? '保留 Markdown 表格、列表、代码块、图片和 Mermaid 块结构。' : '保留普通列表、代码块、图片和 Mermaid 块结构；不得新增或保留 Markdown 表格、HTML 表格。'}
10. start_line/end_line 使用下方带行号正文中的 1-based 行号；如果不确定也必须提供可唯一匹配的 old_text。

返回格式：
{
  "patches": [
    {
      "section_id": "当前小节编号",
      "start_line": 2,
      "end_line": 4,
      "old_text": "当前正文中逐字存在且唯一的原文块，不包含行号",
      "new_text": "替换后的正文块，不包含行号",
      "reason": "修复了哪个事实冲突"
    }
  ]
}`,
    },
    { role: 'user', content: `Step04 全局事实变量：\n${globalFactsText || '未提供'}` },
    { role: 'user', content: `Step02 关键解析结果（项目信息、甲方信息、交货和服务要求）：\n${bidAnalysisFactsText || '未提供'}` },
    { role: 'user', content: `当前小节：${item.id || 'unknown'} ${item.title || '未命名章节'}\n路径：${formatChapterPath(context)}\n描述：${item.description || ''}` },
    { role: 'user', content: `审计发现的冲突：\n${JSON.stringify(conflicts || [], null, 2)}` },
    { role: 'user', content: `当前小节正文（带行号；patch 的 old_text/new_text 不要包含这些行号）：\n${formatContentWithLineNumbers(currentContent)}` },
    { role: 'user', content: `patches[*].section_id 必须是 ${item.id || 'unknown'}。修复尝试次数：${attempt}/${CONSISTENCY_REPAIR_MAX_ATTEMPTS}${failureBlock}\n请只返回 JSON。` },
  ];
}

export function normalizeConsistencyRepairResponse(value: unknown, expectedSectionId: string): { patches: ConsistencyPatch[] } {
  const v = value as { result?: unknown } | undefined;
  const source: unknown = v?.result && typeof v.result === 'object' ? v.result : value || {};
  const s = source as Record<string, unknown>;
  const rawPatches = Array.isArray(s)
    ? s
    : Array.isArray(s.patches)
      ? s.patches as unknown[]
      : Array.isArray(s.operations)
        ? s.operations as unknown[]
        : (s.old_text || s.oldText || s.new_text || s.newText)
          ? [s]
          : [];
  const patches: ConsistencyPatch[] = rawPatches.map((patch) => {
    const p = (patch || {}) as Record<string, unknown>;
    const rawSectionId = singleLine(p.section_id || p.sectionId || p.id || '');
    const sectionId = rawSectionId && rawSectionId !== '当前小节编号' ? rawSectionId : expectedSectionId;
    return {
      section_id: sectionId,
      start_line: Number(p.start_line ?? p.startLine ?? p.line_start ?? p.lineStart ?? 0) || 0,
      end_line: Number(p.end_line ?? p.endLine ?? p.line_end ?? p.lineEnd ?? 0) || 0,
      old_text: normalizeConsistencyPatchText(p.old_text ?? p.oldText ?? p.original ?? p.before ?? ''),
      new_text: normalizeConsistencyPatchText(p.new_text ?? p.newText ?? p.replacement ?? p.after ?? ''),
      reason: String(p.reason || p.description || '').trim(),
    };
  });
  const invalidSection = patches.find((patch) => expectedSectionId && patch.section_id !== expectedSectionId);
  if (invalidSection) {
    throw new Error(`一致性修复结果 section_id 无效：${invalidSection.section_id || '空'}`);
  }
  return { patches };
}

export function validateConsistencyRepairResponse(value: unknown): void {
  if (!value || !Array.isArray((value as { patches?: unknown[] }).patches)) {
    throw new Error('一致性修复结果缺少 patches 数组');
  }
  (value as { patches: ConsistencyPatch[] }).patches.forEach((patch, index) => {
    if (!patch.section_id) {
      throw new Error(`patches[${index}].section_id 缺失`);
    }
    if (!patch.old_text) {
      throw new Error(`patches[${index}].old_text 缺失`);
    }
    if (!patch.new_text) {
      throw new Error(`patches[${index}].new_text 缺失`);
    }
    if (patch.old_text === patch.new_text) {
      throw new Error(`patches[${index}].old_text 与 new_text 相同`);
    }
  });
}

export function buildConsistencyRepairJsonRepairMessages(
  repairCtx: { invalidContent?: string; issues?: string[] },
  expectedSectionId: string,
): ChatMessage[] {
  const issueLines = (repairCtx.issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格 JSON 修复器。请把模型输出修复为“正文一致性局部修复”JSON。

必须满足：
1. 顶层只能包含 patches 数组。
2. 每条 patch 必须包含 section_id、start_line、end_line、old_text、new_text、reason。
3. section_id 必须是 ${expectedSectionId}。
4. old_text 和 new_text 都不能包含行号，不能相同，不能为空。
5. 不要返回完整正文，不要输出 Markdown 或解释文字。
6. 如果无法修复，返回 {"patches":[]}。`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(repairCtx.invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

// ---- 原方案覆盖审计（cjs:2082-2278） ----

export function normalizeOriginalCoverageStatus(value: unknown): string {
  const text = String(value || '').trim().toLowerCase();
  if (ORIGINAL_COVERAGE_STATUSES.has(text)) return text;
  if (['已覆盖', '覆盖', '完整', '保留', '保留完整'].includes(text)) return 'covered';
  if (['部分', '部分覆盖', '部分保留', 'partial_covered'].includes(text)) return 'partial';
  if (['缺失', '未覆盖', '未保留', '遗漏'].includes(text)) return 'missing';
  if (['冲突', '矛盾', '不一致'].includes(text)) return 'conflict';
  return text;
}

export function formatOriginalCoverageSources(sources: OriginalSegment[] | null | undefined): string {
  return (sources || []).map((segment) => `<source id="${segment.id}">
标题路径：${segment.title_path?.length ? segment.title_path.join(' > ') : '未识别标题'}
字符数：${segment.chars || String(segment.content || '').length}
原文：
${segment.content || ''}
</source>`).join('\n\n');
}

export interface OriginalCoverageTarget {
  item: OutlineItem;
  parentChapters?: OutlineItem[];
  siblingChapters?: OutlineItem[];
  sources: OriginalSegment[];
  content?: string;
}

export function buildOriginalCoverageAuditMessages(ctx: { target: OriginalCoverageTarget }): ChatMessage[] {
  const { target } = ctx;
  const allowedSourceIds = (target.sources || []).map((segment) => segment.id).filter(Boolean);
  return [
    {
      role: 'user',
      content: `你是投标技术方案原方案覆盖审计助手。请检查当前小节正文是否保留了原方案来源段中的实质内容。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 必须对每个 source_id 返回一条 items 记录，covered 也必须返回。
3. 可接受改写、扩写、调序、合并和专业化表达；不要因为不是逐字一致就判为缺失。
4. 重点检查原方案中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后、实施方法是否仍然保留。
5. status 只能是 covered、partial、missing、conflict。
6. covered 表示核心内容已经保留；partial 表示部分核心信息缺失；missing 表示该来源段核心内容基本没有体现；conflict 表示正文与来源段核心事实明显相反或矛盾。
7. conflict 只报告，不要求修复；partial/missing 请给出 missing_points 和 repair_suggestion。
8. node_id 必须是当前小节编号，source_id 必须来自允许清单。

返回格式：
{
  "items": [
    {
      "source_id": "P001",
      "node_id": "当前小节编号",
      "status": "covered",
      "missing_points": [],
      "repair_suggestion": ""
    }
  ]
}`,
    },
    { role: 'user', content: `当前小节：${target.item.id || 'unknown'} ${target.item.title || '未命名章节'}\n路径：${formatChapterPath(target as unknown as LeafContext)}\n描述：${target.item.description || ''}` },
    { role: 'user', content: `允许的 source_id：\n${JSON.stringify(allowedSourceIds, null, 2)}` },
    { role: 'user', content: `原方案来源段：\n${formatOriginalCoverageSources(target.sources)}` },
    { role: 'user', content: `当前小节正文：\n${target.content || ''}` },
    { role: 'user', content: '请只返回覆盖审计 JSON。' },
  ];
}

export function normalizeOriginalCoverageAuditResponse(
  value: unknown,
  context: { allowedSourceIds?: Set<string> | string[]; expectedNodeId?: string } = {},
): { items: OriginalCoverageItem[] } {
  const v = value as { result?: unknown } | undefined;
  const source: unknown = v?.result && typeof v.result === 'object' ? v.result : value || {};
  const s = source as Record<string, unknown>;
  const rawItems = Array.isArray(source)
    ? source
    : Array.isArray(s.items)
      ? s.items as unknown[]
      : Array.isArray(s.results)
        ? s.results as unknown[]
        : Array.isArray(s.coverage)
          ? s.coverage as unknown[]
          : [];
  const allowedSourceIds = context.allowedSourceIds instanceof Set ? context.allowedSourceIds : new Set(context.allowedSourceIds || []);
  const expectedNodeId = String(context.expectedNodeId || '').trim();
  const issues: string[] = [];
  const items: OriginalCoverageItem[] = [];
  const seenSourceIds = new Set<string>();

  rawItems.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`items[${index}] 必须是对象`);
      return;
    }
    const i = item as Record<string, unknown>;
    const sourceId = String(i.source_id || i.sourceId || i.id || '').trim();
    if (!sourceId || !allowedSourceIds.has(sourceId)) {
      issues.push(`items[${index}].source_id 无效：${sourceId || '空'}`);
      return;
    }
    if (seenSourceIds.has(sourceId)) {
      issues.push(`items[${index}].source_id 重复：${sourceId}`);
      return;
    }
    const rawNodeId = singleLine(i.node_id || i.nodeId || i.section_id || i.sectionId || '');
    const nodeId = rawNodeId && rawNodeId !== '当前小节编号' ? rawNodeId : expectedNodeId;
    if (!nodeId || (expectedNodeId && nodeId !== expectedNodeId)) {
      issues.push(`items[${index}].node_id 无效：${nodeId || '空'}`);
      return;
    }
    const status = normalizeOriginalCoverageStatus(i.status || i.coverage_status || i.coverageStatus);
    if (!ORIGINAL_COVERAGE_STATUSES.has(status)) {
      issues.push(`items[${index}].status 无效：${status || '空'}`);
      return;
    }
    const rawMissingPointsUnknown = i.missing_points || i.missingPoints;
    const rawMissingPoints = Array.isArray(rawMissingPointsUnknown)
      ? rawMissingPointsUnknown as unknown[]
      : i.missing_point || i.missingPoint || i.reason
        ? [i.missing_point || i.missingPoint || i.reason]
        : [];
    seenSourceIds.add(sourceId);
    items.push({
      source_id: sourceId,
      node_id: nodeId,
      status,
      missing_points: rawMissingPoints.map((point) => String(point || '').trim()).filter(Boolean),
      repair_suggestion: String(i.repair_suggestion || i.repairSuggestion || i.suggestion || '').trim(),
    });
  });

  if (issues.length) {
    throw new Error(`原方案覆盖审计结果格式无效：${issues.join('；')}`);
  }
  return { items };
}

export function validateOriginalCoverageAuditResponse(value: unknown, allowedSourceIds?: Set<string> | string[]): void {
  if (!value || !Array.isArray((value as { items?: unknown[] }).items)) {
    throw new Error('原方案覆盖审计结果缺少 items 数组');
  }
  const allowed = allowedSourceIds instanceof Set ? allowedSourceIds : new Set(allowedSourceIds || []);
  const seen = new Set((value as { items: OriginalCoverageItem[] }).items.map((item) => item.source_id).filter(Boolean));
  const missing = Array.from(allowed).filter((sourceId) => !seen.has(sourceId));
  if (missing.length) {
    throw new Error(`原方案覆盖审计缺少 source_id：${missing.join('、')}`);
  }
}

export function buildOriginalCoverageAuditJsonRepairMessages(
  repairCtx: { invalidContent?: string; issues?: string[] },
  target: OriginalCoverageTarget,
): ChatMessage[] {
  const issueLines = (repairCtx.issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const allowedSourceIds = (target.sources || []).map((segment) => segment.id).filter(Boolean);
  return [
    {
      role: 'user',
      content: `你是严格 JSON 修复器。请把模型输出修复为“原方案覆盖审计”JSON。

必须满足：
1. 顶层只能包含 items 数组。
2. 必须为每个 source_id 返回一条 item，不能遗漏，不能重复。
3. 每条 item 必须包含 source_id、node_id、status、missing_points、repair_suggestion。
4. node_id 必须是 ${target.item.id || 'unknown'}。
5. status 只能是 covered、partial、missing、conflict。
6. 禁止输出正文、修复 patch、Markdown 或解释文字。

允许的 source_id：
${JSON.stringify(allowedSourceIds, null, 2)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(repairCtx.invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

export function buildOriginalCoverageRepairMessages(ctx: {
  target: OriginalCoverageTarget;
  coverageItems: OriginalCoverageItem[];
  currentContent: string;
  attempt: number;
  failures?: string[];
}): ChatMessage[] {
  const { target, coverageItems, currentContent, attempt, failures } = ctx;
  const failureBlock = (failures || []).length
    ? `\n上次补写应用失败原因：\n${(failures || []).map((failure, index) => `${index + 1}. ${failure}`).join('\n')}\n请重新返回可应用的 insert/replace patch。`
    : '';
  const sourceById = new Map((target.sources || []).map((segment) => [segment.id, segment]));
  const issueSourceIds = [...new Set((coverageItems || []).map((item) => item.source_id).filter(Boolean))];
  const issueSources = issueSourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean) as OriginalSegment[];

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文原方案覆盖修复助手。请只针对当前小节返回一次局部补写 patch，用于补回原方案中缺失的实质内容。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 不要返回完整正文，只返回一次 insert 或 replace 操作。
3. operation 只能是 "insert" 或 "replace"。
4. 优先使用 insert 在合适段落后补充缺失内容；如果正文已有同主题但内容不完整，可使用 replace 扩写该段。
5. insert 时 anchor 填写建议插入在哪个当前正文段落之后；适合放末尾时写 "end"。
6. replace 时 target_text 必须逐字复制当前小节正文中的完整待替换 Markdown 原文块，不得摘要、改写或只返回其中一句。
7. replace 目标块如为 Markdown 列表、表格、引用、加粗引导块或连续多行结构，target_text 必须包含完整结构。
8. content 只写新增或替换后的正文片段，不要包含章节标题。
9. 必须补回审计指出的 partial/missing 核心信息，但不要提到“原方案”“来源段”“用户原文”。
10. 不要新增图片 Markdown、Mermaid、代码块或伪目录标题，也不要选择图片 Markdown、Mermaid 或代码块作为 replace 的 target_text。
11. 保持与当前小节职责一致，不要写其他章节内容。

返回格式：
{
  "operation": "insert",
  "anchor": "end",
  "target_text": "replace 时填写逐字复制的完整待替换 Markdown 原文块，insert 时留空",
  "content": "补写后的正文片段"
}`,
    },
    { role: 'user', content: `当前小节：${target.item.id || 'unknown'} ${target.item.title || '未命名章节'}\n路径：${formatChapterPath(target as unknown as LeafContext)}\n描述：${target.item.description || ''}` },
    { role: 'user', content: `需要补回的原方案来源段：\n${formatOriginalCoverageSources(issueSources)}` },
    { role: 'user', content: `覆盖审计问题：\n${JSON.stringify(coverageItems || [], null, 2)}` },
    { role: 'user', content: `当前小节正文：\n${currentContent || ''}` },
    { role: 'user', content: `补写尝试次数：${attempt}/${ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS}${failureBlock}\n请只返回 JSON。` },
  ];
}

// ---- 目录叶子节点 / 知识库（cjs:2280-2375） ----

export function normalizeChildren(item: OutlineItem | null | undefined): OutlineItem[] {
  return Array.isArray(item?.children) ? item.children! : [];
}

export function collectLeafContexts(items: OutlineItem[] | null | undefined, parents: OutlineItem[] = []): LeafContext[] {
  const results: LeafContext[] = [];
  for (const item of items || []) {
    const children = normalizeChildren(item);
    if (!children.length) {
      results.push({ item, parentChapters: parents, siblingChapters: items || [] });
      continue;
    }
    results.push(...collectLeafContexts(children, [...parents, item]));
  }
  return results;
}

export function normalizeReferenceDocumentIds(storedPlan: Record<string, unknown> | null | undefined): string[] {
  const raw = storedPlan?.referenceKnowledgeDocumentIds ?? [];
  return Array.isArray(raw)
    ? [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
}

export function loadContentKnowledgeItems(
  knowledgeBaseService: ContentKnowledgeBaseService | null | undefined,
  documentIds: string[],
  log: LogFn,
): ContentKnowledgeItem[] {
  if (!documentIds.length) {
    log('本次正文编排未选择参考知识库。');
    return [];
  }
  if (!knowledgeBaseService?.getOutlineReferences) {
    log('未找到知识库读取服务，正文编排不使用知识库。');
    return [];
  }

  try {
    const result = knowledgeBaseService.getOutlineReferences(documentIds);
    const items = Array.isArray(result?.items) ? result.items.map((item) => ({
      id: String(item?.id || '').trim(),
      title: String(item?.title || '').trim(),
      resume: String(item?.resume || '').trim(),
    })).filter((item) => item.id && item.title && item.resume) : [];
    log(items.length ? `正文编排已读取 ${items.length} 条知识库轻量条目。` : '未读取到可用知识库轻量条目，正文编排不使用知识库。');
    return items;
  } catch (error) {
    log(`读取正文编排参考知识库失败，已跳过：${(error as { message?: string }).message || String(error)}`);
    return [];
  }
}

export function loadContentKnowledgeContentMap(
  knowledgeBaseService: ContentKnowledgeBaseService | null | undefined,
  documentIds: string[],
  log: LogFn,
): Map<string, { content: string }> {
  const map = new Map<string, { content: string }>();
  if (!documentIds.length || !knowledgeBaseService?.readItems) {
    return map;
  }

  for (const documentId of documentIds) {
    try {
      const items = knowledgeBaseService.readItems(documentId);
      for (const item of Array.isArray(items) ? items : []) {
        const i = item as { id?: string; content?: string };
        const itemId = String(i?.id || '').trim();
        const content = String(i?.content || '').trim();
        if (!itemId || !content) {
          continue;
        }
        map.set(`${documentId}::${itemId}`, { content });
      }
    } catch (error) {
      log(`读取知识库正文素材失败，已跳过文档 ${documentId}：${(error as { message?: string }).message || String(error)}`);
    }
  }

  if (map.size) {
    log(`正文生成可用知识库正文素材 ${map.size} 条。`);
  }
  return map;
}

export function resolveKnowledgeContents(itemIds: unknown, knowledgeContentMap: Map<string, { content: string }>): string[] {
  const selected = new Set(normalizeKnowledgeItemIds(itemIds));
  if (!selected.size || !(knowledgeContentMap instanceof Map) || !knowledgeContentMap.size) {
    return [];
  }

  const contents: string[] = [];
  for (const [id, item] of knowledgeContentMap.entries()) {
    if (selected.has(id) && item?.content) {
      contents.push(item.content);
    }
  }
  return contents;
}

export function resolveSelectedFactsText(contentPlan: ContentPlan | null | undefined, globalFacts: unknown): string {
  const selectedFacts = resolveGlobalFactsByTitles(contentPlan?.facts?.titles, globalFacts);
  return formatSelectedGlobalFactsForPrompt(selectedFacts);
}

// ---- 目录树操作（cjs:2377-2580） ----

export function updateOutlineItemContent(items: OutlineItem[] | null | undefined, targetId: string, content: string): OutlineItem[] {
  return (items || []).map((item) => {
    if (item.id === targetId) {
      return { ...item, content };
    }

    const children = normalizeChildren(item);
    if (!children.length) {
      return item;
    }

    return { ...item, children: updateOutlineItemContent(children, targetId, content) };
  });
}

export function clearOutlineContent(items: OutlineItem[] | null | undefined): OutlineItem[] {
  return (items || []).map((item) => {
    const { content, children, ...rest } = item;
    const normalizedChildren = normalizeChildren(item);
    return normalizedChildren.length
      ? { ...rest, children: clearOutlineContent(normalizedChildren) }
      : rest;
  });
}

export function cloneOutlineItems(items: OutlineItem[] | null | undefined): OutlineItem[] {
  return (items || []).map((item) => ({
    ...item,
    ...(item.knowledge_item_ids?.length ? { knowledge_item_ids: [...item.knowledge_item_ids] } : {}),
    ...(item.children?.length ? { children: cloneOutlineItems(item.children) } : {}),
  }));
}

export function outlineDepth(items: OutlineItem[] | null | undefined): number {
  return items?.length ? 1 + Math.max(...items.map((item) => outlineDepth(item.children || []))) : 0;
}

export interface OutlineRow {
  item: OutlineItem;
  id: string;
  title: string;
  description: string;
  level: number;
  parent: OutlineRow | null;
  path: string;
}

export function flattenOutlineRows(
  items: OutlineItem[] | null | undefined,
  level = 1,
  parent: OutlineRow | null = null,
  rows: OutlineRow[] = [],
): OutlineRow[] {
  (items || []).forEach((item, index) => {
    const id = String(item?.id || '').trim();
    const row: OutlineRow = {
      item,
      id,
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim(),
      level,
      parent,
      path: parent ? `${parent.path}.children[${index}]` : `outline[${index}]`,
    };
    rows.push(row);
    flattenOutlineRows(normalizeChildren(item), level + 1, row, rows);
  });
  return rows;
}

export function validateOutlineTree(rows: OutlineRow[]): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();

  for (const row of rows) {
    const children = normalizeChildren(row.item);
    if (!row.id) {
      issues.push(`${row.path}.id 缺失`);
    } else if (seenIds.has(row.id)) {
      issues.push(`${row.path}.id 重复：${row.id}`);
    } else {
      seenIds.add(row.id);
    }
    if (!row.title) {
      issues.push(`${row.path}.title 缺失`);
    }
    if (!row.description) {
      issues.push(`${row.path}.description 缺失`);
    }
    if (row.level > 4) {
      issues.push(`${row.path} 目录层级不能超过四级`);
    }
    if (row.parent?.id && row.id && !row.id.startsWith(`${row.parent.id}.`)) {
      issues.push(`${row.path}.id 必须挂在父级 ${row.parent.id} 下`);
    }
    if (children.length && Object.prototype.hasOwnProperty.call(row.item || {}, 'content') && String(row.item.content || '').trim()) {
      issues.push(`${row.path} 是非叶子节点，不能保留正文 content`);
    }
  }

  return issues;
}

export function validateOutlineExpansionApplied(beforeItems: OutlineItem[] | null | undefined, afterItems: OutlineItem[] | null | undefined): void {
  if (!(afterItems || []).length) {
    throw new Error('补目录后完整目录不能为空');
  }
  if (outlineDepth(afterItems) > 4) {
    throw new Error('补目录后目录层级不能超过四级');
  }
  if ((beforeItems || []).length !== (afterItems || []).length) {
    throw new Error('补目录不允许改变一级目录数量');
  }

  const beforeRows = flattenOutlineRows(beforeItems || []);
  const afterRows = flattenOutlineRows(afterItems || []);
  const beforeById = new Map(beforeRows.filter((row) => row.id).map((row) => [row.id, row]));
  const afterById = new Map(afterRows.filter((row) => row.id).map((row) => [row.id, row]));
  const treeIssues = validateOutlineTree(afterRows);
  if (treeIssues.length) {
    throw new Error(`补目录后完整目录结构无效：${treeIssues.join('；')}`);
  }

  (beforeItems || []).forEach((beforeItem, index) => {
    const afterItem = afterItems![index];
    if (String(beforeItem.id || '').trim() !== String(afterItem?.id || '').trim()) {
      throw new Error('补目录不允许修改一级目录 ID 或顺序');
    }
    if (String(beforeItem.title || '').trim() !== String(afterItem?.title || '').trim()) {
      throw new Error('补目录不允许修改一级目录标题');
    }
  });

  for (const beforeRow of beforeRows) {
    const afterRow = beforeRow.id ? afterById.get(beforeRow.id) : null;
    if (!afterRow) {
      throw new Error(`补目录不允许删除既有目录节点：${beforeRow.id || beforeRow.path}`);
    }
    if (beforeRow.level !== afterRow.level) {
      throw new Error(`补目录不允许改变既有目录层级：${beforeRow.id}`);
    }
    if (beforeRow.title !== afterRow.title) {
      throw new Error(`补目录不允许修改既有目录标题：${beforeRow.id}`);
    }
    if (beforeRow.description !== afterRow.description) {
      throw new Error(`补目录不允许修改既有目录说明：${beforeRow.id}`);
    }
  }

  for (const afterRow of afterRows) {
    if (!beforeById.has(afterRow.id) && (afterRow.level < 2 || afterRow.level > 4)) {
      throw new Error(`新增目录只能出现在二级、三级、四级：${afterRow.id}`);
    }
  }
}

export function nextChildId(parent: OutlineItem, existingIds: Set<string>): string {
  const prefix = `${parent.id}.`;
  const childIndexes = normalizeChildren(parent)
    .map((child) => String(child.id || ''))
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length).split('.')[0]))
    .filter((value) => Number.isFinite(value));
  let nextIndex = childIndexes.length ? Math.max(...childIndexes) + 1 : 1;
  let id = `${prefix}${nextIndex}`;
  while (existingIds.has(id)) {
    nextIndex += 1;
    id = `${prefix}${nextIndex}`;
  }
  existingIds.add(id);
  return id;
}

export function createOutlineItemFromExpansion(
  addition: { title?: string; description?: string; children?: unknown[] },
  parent: OutlineItem,
  existingIds: Set<string>,
  invalidatedItemIds: Set<string>,
): OutlineItem {
  const item: OutlineItem = {
    id: nextChildId(parent, existingIds),
    title: addition.title,
    description: addition.description || addition.title,
  };
  const children = Array.isArray(addition.children) ? addition.children : [];
  if (children.length) {
    item.children = [];
    for (const child of children) {
      item.children.push(createOutlineItemFromExpansion(child as { title?: string; description?: string; children?: unknown[] }, item, existingIds, invalidatedItemIds));
    }
  }
  return item;
}

export function applyOutlineExpansionAdditions(
  outlineItems: OutlineItem[] | null | undefined,
  patch: OutlineExpansionPatch,
): { outline: OutlineItem[]; invalidatedItemIds: Set<string>; addedCount: number } {
  const beforeOutline = outlineItems || [];
  const outline = cloneOutlineItems(beforeOutline);
  const nodeMap = createOutlineNodeMap(outline);
  const existingIds = new Set<string>(Array.from(nodeMap.keys()));
  const invalidatedItemIds = new Set<string>();
  let addedCount = 0;

  for (const addition of patch.additions || []) {
    const parent = nodeMap.get(addition.parent_id);
    if (!parent || parent.level < 1 || parent.level > 3) {
      continue;
    }
    const parentItem = parent.item;
    if (!parentItem.children?.length) {
      invalidatedItemIds.add(parentItem.id || '');
    }
    const nextItem = createOutlineItemFromExpansion(addition, parentItem, existingIds, invalidatedItemIds);
    parentItem.children = [...(parentItem.children || []), nextItem];
    delete parentItem.content;
    function register(node: OutlineItem, level: number): void {
      if (node.id) nodeMap.set(node.id, { item: node, level, parent: parentItem });
      addedCount += 1;
      if (node.children?.length) node.children.forEach((child) => register(child, level + 1));
    }
    register(nextItem, parent.level + 1);
  }

  validateOutlineExpansionApplied(beforeOutline, outline);
  return { outline, invalidatedItemIds, addedCount };
}

// ---- 正文扩写 patch 应用 / 章节清理（cjs:2582-2753） ----

export function normalizeParagraphs(content: unknown): string[] {
  return String(content || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

export function findContentExpansionNeedleRanges(content: unknown, targetText: unknown): Array<{ start: number; end: number; strategy: string }> {
  const source = normalizeNewlines(content);
  const target = normalizeNewlines(targetText).trim();
  const matches: Array<{ start: number; end: number; strategy: string }> = [];
  if (!target) {
    return matches;
  }

  let index = 0;
  while ((index = source.indexOf(target, index)) >= 0) {
    matches.push({ start: index, end: index + target.length, strategy: 'target_text-exact' });
    index += Math.max(1, target.length);
  }
  return matches;
}

export interface ContentExpansionMatch {
  found: boolean;
  unique: boolean;
  count: number;
  strategy: string;
  match: { start: number; end: number; strategy: string } | null;
  error: string;
}

export function findContentExpansionTargetTextMatch(content: unknown, targetText: unknown): ContentExpansionMatch {
  const source = normalizeNewlines(content).trim();
  const target = normalizeNewlines(targetText).trim();
  if (!target) {
    return { found: false, unique: false, count: 0, strategy: '', match: null, error: 'replace patch 缺少 target_text' };
  }

  const exactMatches = findContentExpansionNeedleRanges(source, target);
  if (exactMatches.length === 1) {
    return { found: true, unique: true, count: 1, strategy: exactMatches[0].strategy, match: exactMatches[0], error: '' };
  }
  if (exactMatches.length > 1) {
    return { found: true, unique: false, count: exactMatches.length, strategy: 'target_text-exact', match: null, error: `replace target_text 精确命中 ${exactMatches.length} 处，拒绝替换` };
  }

  const sourceLines = splitLinesWithRanges(source);
  const targetLines = target.split('\n').map((line) => line.trim());
  const lineMatches: Array<{ start: number; end: number; strategy: string }> = [];
  if (targetLines.length <= sourceLines.length) {
    for (let startIndex = 0; startIndex <= sourceLines.length - targetLines.length; startIndex += 1) {
      const matched = targetLines.every((line, offset) => sourceLines[startIndex + offset].text.trim() === line);
      if (!matched) {
        continue;
      }
      const firstLine = sourceLines[startIndex];
      const lastLine = sourceLines[startIndex + targetLines.length - 1];
      lineMatches.push({ start: firstLine.start, end: lastLine.end, strategy: 'target_text-line-trimmed' });
    }
  }

  if (lineMatches.length === 1) {
    return { found: true, unique: true, count: 1, strategy: lineMatches[0].strategy, match: lineMatches[0], error: '' };
  }
  if (lineMatches.length > 1) {
    return { found: true, unique: false, count: lineMatches.length, strategy: 'target_text-line-trimmed', match: null, error: `replace target_text 逐行匹配命中 ${lineMatches.length} 处，拒绝替换` };
  }

  return { found: false, unique: false, count: 0, strategy: '', match: null, error: 'replace target_text 未在当前章节正文中唯一命中' };
}

export function applyContentExpansionPatch(content: unknown, patch: ContentExpansionPatch): string {
  const normalizedContent = normalizeNewlines(String(content || '')).trim();
  const patchContent = normalizeGeneratedMarkdown(patch.content).trim();
  if (!normalizedContent) {
    if (patch.operation === 'replace') {
      throw new Error('当前章节正文为空，replace target_text 无法执行替换');
    }
    return patchContent;
  }

  if (patch.operation === 'replace') {
    const targetMatch = findContentExpansionTargetTextMatch(normalizedContent, patch.target_text);
    if (!targetMatch.unique || !targetMatch.match) {
      throw new Error(targetMatch.error || 'replace target_text 未命中');
    }
    return `${normalizedContent.slice(0, targetMatch.match.start)}${patchContent}${normalizedContent.slice(targetMatch.match.end)}`;
  }

  const paragraphs = normalizeParagraphs(normalizedContent);
  const anchor = String(patch.anchor || '').trim();
  const anchorKey = anchor.replace(/\s+/g, ' ').trim();
  const anchorIndex = anchorKey && !/^end$/i.test(anchorKey)
    ? paragraphs.findIndex((paragraph) => paragraph.replace(/\s+/g, ' ').includes(anchorKey) || anchorKey.includes(paragraph.replace(/\s+/g, ' ')))
    : -1;

  if (/^start$/i.test(anchorKey)) {
    return [patchContent, ...paragraphs].join('\n\n');
  }

  if (anchorIndex >= 0) {
    const next = [...paragraphs];
    next.splice(anchorIndex + 1, 0, patchContent);
    return next.join('\n\n');
  }

  return `${normalizedContent}\n\n${patchContent}`;
}

export function escapeRegExp(value: unknown): string {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function unwrapMarkdownTitle(line: unknown): string {
  let normalized = String(line || '').trim();
  normalized = normalized.replace(/^#{1,6}\s+/, '').trim();
  normalized = normalized.replace(/^\*\*(.+)\*\*$/, '$1').trim();
  normalized = normalized.replace(/^__(.+)__$/, '$1').trim();
  return normalized.replace(/[：:：。\s]+$/, '').trim();
}

export function stripRepeatedChapterTitle(content: unknown, chapter: OutlineItem | null | undefined): string {
  const title = String(chapter?.title || '').trim();
  if (!title) {
    return String(content || '');
  }

  const rawLines = String(content || '').replace(/^﻿/, '').split(/\r?\n/);
  let firstContentLine = rawLines.findIndex((line) => line.trim());
  if (firstContentLine < 0) {
    return String(content || '');
  }

  const chapterId = String(chapter?.id || '').trim();
  const firstLine = unwrapMarkdownTitle(rawLines[firstContentLine]);
  let comparable = firstLine;

  if (chapterId) {
    comparable = comparable.replace(new RegExp(`^${escapeRegExp(chapterId)}\\s+`), '').trim();
  }
  comparable = comparable.replace(/^[一二三四五六七八九十]+[、.．]\s*/, '').trim();

  if (comparable !== title && firstLine !== `${chapterId} ${title}`.trim()) {
    return String(content || '');
  }

  const nextLines = rawLines.slice(firstContentLine + 1);
  while (nextLines.length && !nextLines[0].trim()) {
    nextLines.shift();
  }
  if (!nextLines.some((line) => line.trim())) {
    return String(content || '');
  }
  return [...rawLines.slice(0, firstContentLine), ...nextLines].join('\n').trimStart();
}

export function stripMarkdownHeadingsFromLeafContent(content: unknown): string {
  let inFence = false;
  return String(content || '').split(/\r?\n/).map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) {
      return line;
    }

    const match = /^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      return line;
    }

    const text = match[2].trim();
    const unwrapped = text
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^__(.+)__$/, '$1')
      .trim();
    return `${match[1]}**${unwrapped || text}**`;
  }).join('\n');
}

export function normalizeLeafContentForSave(content: unknown, chapter: OutlineItem | null | undefined): string {
  return stripMarkdownHeadingsFromLeafContent(
    stripRepeatedChapterTitle(normalizeGeneratedMarkdown(content), chapter),
  );
}

// ---- 表格计划分发 / 编排 runtime（cjs:2755-2808） ----

export function pickDistributedTableTargets(plannedItems: LeafContext[], limit: number): Set<string> {
  if (limit <= 0 || !plannedItems.length) {
    return new Set<string>();
  }

  if (plannedItems.length <= limit) {
    return new Set(plannedItems.map(({ item }) => item.id).filter(Boolean) as string[]);
  }

  const selected = new Map<string, LeafContext>();
  for (let slot = 0; slot < limit; slot += 1) {
    const start = Math.floor((slot * plannedItems.length) / limit);
    const end = Math.floor(((slot + 1) * plannedItems.length) / limit);
    const group = plannedItems.slice(start, Math.max(start + 1, end));
    const candidate = group[Math.floor(group.length / 2)] || group[0];
    if (candidate?.item.id) {
      selected.set(candidate.item.id, candidate);
    }
  }

  return new Set(selected.keys());
}

export function countRetainedTablePlans(
  plans: Record<string, unknown> | null | undefined,
  excludedItemIds?: Set<string> | null,
): number {
  let count = 0;
  for (const [itemId, value] of Object.entries(plans || {})) {
    if (excludedItemIds?.has(itemId)) {
      continue;
    }
    const storedPlan = normalizeStoredContentPlan(value);
    if (storedPlan?.plan?.table?.needed) {
      count += 1;
    }
  }
  return count;
}

export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))] : [];
}

export function normalizeContentGenerationRuntime(value: unknown): ContentGenerationRuntime {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    phase: String(source.phase || ''),
    touched_item_ids: normalizeStringArray(source.touched_item_ids || source.touchedItemIds),
    outline_expansion_completed: Math.max(0, Math.round(Number(source.outline_expansion_completed ?? source.outlineExpansionCompleted) || 0)),
    expansion_cycle_item_ids: normalizeStringArray(source.expansion_cycle_item_ids || source.expansionCycleItemIds),
    expansion_attempted_item_ids: normalizeStringArray(source.expansion_attempted_item_ids || source.expansionAttemptedItemIds),
    expansion_cycle_start_words: Math.max(0, Math.round(Number(source.expansion_cycle_start_words ?? source.expansionCycleStartWords) || 0)),
    target_item_id: String(source.target_item_id || source.targetItemId || '').trim(),
    regenerate_requirement: String(source.regenerate_requirement || source.regenerateRequirement || '').trim(),
    updated_at: (source.updated_at as string) || (source.updatedAt as string) || now(),
  };
}

export function orderExpansionCandidates<T>(candidates: T[]): T[] {
  if (!candidates.length) return [];

  const middle = Math.floor(candidates.length / 2);
  const ordered: T[] = [candidates[middle]];
  const maxOffset = Math.max(middle, candidates.length - 1 - middle);
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    if (middle - offset >= 0) {
      ordered.push(candidates[middle - offset]);
    }
    if (middle + offset < candidates.length) {
      ordered.push(candidates[middle + offset]);
    }
  }
  return ordered;
}

// ---- Section map 助手（cjs:2882-2944） ----

export function createInitialSections(leaves: LeafContext[], existingSections?: ContentSectionMap | null): ContentSectionMap {
  const next: ContentSectionMap = { ...(existingSections || {}) };
  const leafIds = new Set(leaves.map(({ item }) => item.id).filter(Boolean) as string[]);

  for (const key of Object.keys(next)) {
    if (!leafIds.has(key)) {
      delete next[key];
    }
  }

  for (const { item } of leaves) {
    const id = item.id as string;
    const existing = next[id];
    const interrupted = existing?.status === 'running';
    const content = interrupted ? '' : existing?.content || item.content || '';
    const existingStatus = interrupted ? 'error' : existing?.status;
    next[id] = {
      id,
      title: item.title || '未命名章节',
      status: existingStatus || (content.trim() ? 'success' : 'idle'),
      content,
      error: interrupted ? INTERRUPTED_SECTION_ERROR : existing?.error,
      updated_at: existing?.updated_at,
    };
  }

  return next;
}

export function progressFor(leaves: LeafContext[], sections: ContentSectionMap): number {
  if (!leaves.length) {
    return 0;
  }

  const done = leaves.filter(({ item }) => ['success', 'error'].includes(sections[item.id as string]?.status || '')).length;
  return Math.round((done / leaves.length) * 100);
}

export function taskStatusFor(leaves: LeafContext[], sections: ContentSectionMap): string {
  if (leaves.some(({ item }) => sections[item.id as string]?.status === 'error')) {
    return 'error';
  }

  return 'success';
}

export function now(): string {
  return new Date().toISOString();
}

export function withSection(
  sections: ContentSectionMap | null | undefined,
  item: OutlineItem,
  partial: Partial<ContentSection>,
): ContentSectionMap {
  const defaults: ContentSection = {
    id: item.id as string,
    title: item.title || '未命名章节',
    status: 'idle',
    content: '',
  };
  const existing = (sections || {})[item.id as string];
  const section = {
    ...defaults,
    ...(existing as Record<string, unknown>),
    ...partial,
    updated_at: now(),
  } as ContentSection;
  return {
    ...(sections || {}),
    [item.id as string]: section,
  };
}
