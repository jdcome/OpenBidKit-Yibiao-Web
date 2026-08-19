// L4 runner #59 helpers：bid-section-extraction（多标段识别）纯函数 + prompt 构造。
// 逐字移植自 client/electron/services/bidSectionExtractionTask.cjs:1-197（lines 1-197 全部纯逻辑）。
// 无编排（编排层在 runners/bid-section-extraction.ts）。
//
// 算法：带行号切分招标文本 → 按上下文长度分段 → 每段 LLM 抽 sections 候选 →
// 多段时再过一次 LLM 合并去重 → 校验≥2 段。所有 LLM 调用 response_format=json_object。
// 行号归一化 + 标段去重（同标段跨段合并 includeRanges/evidence）+ 按 includeRanges 首行排序。
import { splitUserTextByContextLimit } from '../../document/userTextSplitter';

export interface BidSectionLineRange {
  startLine: number;
  endLine: number;
  reason?: string;
}

export interface BidSection {
  id: string;
  index: number;
  unit: string;
  title: string;
  headLine: string;
  description: string;
  includeRanges: BidSectionLineRange[];
  evidence: string[];
}

export interface SectionsResponse {
  sections: BidSection[];
}

export interface CollectJsonOptions {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  response_format?: { type: string };
  logTitle?: string;
  progressLabel?: string;
  normalizer?: (value: unknown) => unknown;
  validator?: (value: unknown) => void;
  progressCallback?: (message: string) => void | Promise<void>;
  repairMessagesBuilder?: (ctx: Record<string, unknown>) => Array<{ role: string; content: string }>;
}

export interface BidSectionAiService {
  collectJsonResponse(options: CollectJsonOptions): Promise<unknown>;
  getConfig(): Record<string, unknown>;
}

export function pushLog(logs: string[], message: string): string[] {
  logs.push(message);
  return logs.slice(-80);
}

export function numberMarkdownLines(markdown: string): string {
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line, index) => `L${String(index + 1).padStart(6, '0')} | ${line}`)
    .join('\n');
}

export function normalizeLineRange(range: unknown, totalLines: number): BidSectionLineRange | null {
  const r = (range || {}) as Record<string, unknown>;
  const startLine = Math.floor(Number(r.startLine ?? r.start_line ?? 0));
  const endLine = Math.floor(Number(r.endLine ?? r.end_line ?? 0));
  if (
    !Number.isFinite(startLine) ||
    !Number.isFinite(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    startLine > totalLines ||
    endLine > totalLines
  ) {
    return null;
  }
  return {
    startLine,
    endLine,
    reason: r.reason ? String(r.reason).trim() : undefined,
  };
}

export function normalizeSectionTitle(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^第([一二三四五六七八九十壹贰叁肆伍\d]+)(标段|标包|分包|包)$/, '$1$2')
    .toLowerCase();
}

export function getSectionMergeKey(section: BidSection): string {
  const titleKey = normalizeSectionTitle(section.title);
  if (titleKey) {
    return `${section.unit || '标段'}:${titleKey}`;
  }
  return `${section.unit || '标段'}:${section.index}`;
}

export function mergeRanges(ranges: BidSectionLineRange[]): BidSectionLineRange[] {
  const seen = new Set<string>();
  return (ranges || [])
    .filter((range) => {
      const key = `${range.startLine}-${range.endLine}-${range.reason || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

export function getFirstRangeStart(section: BidSection): number {
  const ranges = mergeRanges(section.includeRanges || []);
  return ranges[0]?.startLine || Number.MAX_SAFE_INTEGER;
}

export function normalizeSection(section: unknown, index: number, totalLines: number): BidSection | null {
  const s = (section || {}) as Record<string, unknown>;
  const title = String(s.title || '').trim();
  if (!title) return null;
  const sectionIndex = Math.floor(Number(s.index || index + 1));
  const ranges = (Array.isArray(s.includeRanges) ? (s.includeRanges as unknown[]) : (s.include_ranges as unknown[] | undefined)) || [];
  const includeRanges = ranges
    .map((range) => normalizeLineRange(range, totalLines))
    .filter(Boolean) as BidSectionLineRange[];
  return {
    id: String(s.id || `section-${sectionIndex || index + 1}`).trim(),
    index: Number.isFinite(sectionIndex) && sectionIndex > 0 ? sectionIndex : index + 1,
    unit: String(s.unit || '标段').trim() || '标段',
    title,
    headLine: String(s.headLine || s.head_line || '').trim(),
    description: String(s.description || '').trim(),
    includeRanges,
    evidence: (Array.isArray(s.evidence) ? s.evidence : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  };
}

export function dedupeSections(sections: BidSection[]): BidSection[] {
  const map = new Map<string, BidSection>();
  for (const section of sections) {
    const key = getSectionMergeKey(section);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...section });
      continue;
    }
    existing.includeRanges = mergeRanges([
      ...(existing.includeRanges || []),
      ...(section.includeRanges || []),
    ]);
    existing.evidence = [...new Set([...(existing.evidence || []), ...(section.evidence || [])])];
    if (!existing.headLine && section.headLine) existing.headLine = section.headLine;
    if (!existing.description && section.description) existing.description = section.description;
  }
  return Array.from(map.values())
    .map((section) => ({ ...section, includeRanges: mergeRanges(section.includeRanges) }))
    .filter((section) => section.includeRanges.length > 0)
    .sort((a, b) => getFirstRangeStart(a) - getFirstRangeStart(b) || a.index - b.index)
    .map((section, index) => ({ ...section, id: `section-${index + 1}` }));
}

export function normalizeSectionsResponse(value: unknown, totalLines: number): SectionsResponse {
  const v = (value || {}) as Record<string, unknown>;
  const sourceSections = Array.isArray(v.sections) ? (v.sections as unknown[]) : [];
  const sections = dedupeSections(
    sourceSections
      .map((section, index) => normalizeSection(section, index, totalLines))
      .filter(Boolean) as BidSection[],
  );
  return {
    sections,
  };
}

export function validateSectionsResponse(value: SectionsResponse): void {
  if (!Array.isArray(value?.sections) || value.sections.length < 2) {
    throw new Error('未识别到至少两个有效标段');
  }
}

export function buildExtractMessages(
  segment: string,
  segmentIndex: number,
  totalSegments: number,
): Array<{ role: string; content: string }> {
  return [
    {
      role: 'system',
      content: `你是严谨的招标文件多标段识别专家。你只能基于用户提供的带行号文本识别标段、标包、分包、采购包、包件或标的。`,
    },
    {
      role: 'user',
      content: `当前是招标文件第 ${segmentIndex}/${totalSegments} 段。每行格式为“L000001 | 原文”。

任务：识别本段中明确属于某个标段/标包/分包/采购包/包件/标的的内容，并返回结构化 JSON。

要求：
1. 只识别明确属于某个标段的内容范围。
2. 通用条款不要归入某个标段；不确定归属的内容不要输出范围。
3. includeRanges 必须使用输入中的真实行号，startLine 和 endLine 都是不带 L 前缀的数字。
4. 不要编造标段，不要补写原文没有的范围。
5. 无法提供有效 includeRanges 的候选不要输出到 sections。
6. 如果本段没有明确标段内容，返回 {"sections":[]}。
7. 只返回 JSON，不要输出 Markdown、代码块、解释或额外文字。

返回格式：
{
  "sections": [
    {
      "id": "section-1",
      "index": 1,
      "unit": "标段",
      "title": "一标段",
      "headLine": "一标段：设备采购及安装",
      "description": "设备采购、安装、调试及售后服务。",
      "includeRanges": [
        { "startLine": 120, "endLine": 180, "reason": "一标段采购清单" }
      ],
      "evidence": ["一标段：设备采购及安装"]
    }
  ]
}

带行号文本：
${segment}`,
    },
  ];
}

export function buildMergeMessages(
  segmentResults: SectionsResponse[],
): Array<{ role: string; content: string }> {
  return [
    {
      role: 'system',
      content: '你是严谨的招标文件多标段识别结果合并专家。你只能合并用户提供的分段识别结果，不得编造新标段或新行号。',
    },
    {
      role: 'user',
      content: `以下是同一份招标文件各分段识别出的标段候选。请合并重复标段，保留所有明确属于各标段的 includeRanges 和 evidence。

要求：
1. 同一标段跨多个分段出现时合并为一个 sections 项。
2. 不要把通用条款合并到任何标段。
3. 不要新增分段结果中没有的行号范围。
4. 如果最终少于两个标段，返回已有结果。
5. 只返回 JSON，不要输出 Markdown、代码块、解释或额外文字。

分段结果：
${JSON.stringify(segmentResults, null, 2)}`,
    },
  ];
}

// 对齐桌面 collectJson（bidSectionExtractionTask.cjs:189-197）。
// web aiService 经 wrapAiForRunner 暴露 collectJsonResponse(request) 单参签名（自动注入 config）。
export async function collectJson(
  aiService: BidSectionAiService,
  options: CollectJsonOptions,
): Promise<unknown> {
  if (aiService?.collectJsonResponse) {
    return aiService.collectJsonResponse(options);
  }
  throw new Error('AI 服务尚未初始化');
}
