import { createHash } from 'node:crypto';
import type {
  ExtractedRequirementRow,
  ExtractionResult,
  RequirementAggregation,
  TenderBlock,
} from './types';

const MAJOR_HEADING_RE = /^([一二三四五六七八九十百]+、)\s*(.+)$/;
const PRINCIPLE_TITLE_RE = /(?:项目|实施|服务|工作|总体|基本)原则$/;
const ASSESSMENT_OBJECT_TITLE_RE = /(?:测评(?:服务)?对象(?:清单|表)?|测评范围(?:与对象)?|被测系统(?:清单)?|测评系统清单)$/;
const METHOD_CONTENT_TITLE_RE = /(?:测评|测试|评估|服务|实施|工作|项目|整体|网络安全等级保护)?(?:内容和方法|方法和内容|内容与方法|方法与内容)$/;
const REFERENCE_TITLE_RE = /(?:参考文件|参考资料|参考依据|编制依据|标准和规范|标准规范|适用标准|规范依据|政策文件|法规文件)$/;
const IMAGE_REFERENCE_RE = /(?:如下图所示|如图所示|见下图|见图|流程图|示意图)/;
const INLINE_TITLE_BODY_RE = /^(.{1,40}?)[：:]\s*(?:\*\*)?(.+)$/s;

export interface RequirementScope {
  blockIds: string[];
  sourceChapterTitle: string;
  templateTitle?: string;
}

function stripClauseNo(text: string, clauseNo: string): string {
  return clauseNo ? text.trim().slice(clauseNo.length).trim() : text.trim();
}

function cleanBlockText(text: string): string {
  return text.trim().replace(/^\*\*|\*\*$/g, '').trim();
}

function cleanTitle(title: string): string {
  const raw = title.trim().replace(/\*\*/g, '').trim();
  const inline = INLINE_TITLE_BODY_RE.exec(raw);
  return (inline ? inline[1] : raw).trim().replace(/[：:]\s*$/, '').trim();
}

function titleParts(block: TenderBlock): { clauseNo: string; title: string } {
  const text = cleanBlockText(block.text);
  const major = MAJOR_HEADING_RE.exec(text);
  if (major) return { clauseNo: major[1], title: cleanTitle(major[2]) };
  if (!block.clauseNo) {
    const numeric = /^(\d{1,3}[.．、)]\s*)(.+)$/u.exec(text);
    if (numeric) return { clauseNo: numeric[1].trim(), title: cleanTitle(numeric[2]) };
  }
  return { clauseNo: block.clauseNo, title: cleanTitle(stripClauseNo(text, block.clauseNo)) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLeadingTitleFromRaw(raw: string, parts: { clauseNo: string; title: string }): string {
  const clauseNo = parts.clauseNo.trim();
  const title = parts.title.trim();
  if (!clauseNo && !title) return raw.trim();
  const headingPrefix = '^\\s*(?:#{1,6}\\s*)?';
  const boldOpen = '(?:\\*\\*\\s*)?';
  const boldClose = '(?:\\s*\\*\\*)?';
  const clausePattern = clauseNo ? `${escapeRegExp(clauseNo)}\\s*` : '';
  const titlePattern = title ? `${escapeRegExp(title)}\\s*` : '';
  const prefixRe = new RegExp(`${headingPrefix}${boldOpen}${clausePattern}${titlePattern}[：:]?${boldClose}\\s*`, 'u');
  return raw.replace(prefixRe, '').replace(/^\s+/, '').trim();
}

function normalizeSourceChapterTitle(title: string): string {
  return cleanBlockText(title)
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s*[（(]L\d+\s*-\s*L\d+[）)]\s*$/i, '')
    .replace(/\s*(?:包|分包|标段)\s*[一二三四五六七八九十百千万0-9]+(?:号)?\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(第[一二三四五六七八九十百千万0-9]+章)\s*(.+)$/u, '$1 $2')
    .trim();
}

function joinClauseTitle(parts: { clauseNo: string; title: string }): string {
  const clauseNo = parts.clauseNo.trim();
  const title = parts.title.trim();
  if (!clauseNo) return title;
  if (!title) return clauseNo;
  const separator = /[.．、）)]$/.test(clauseNo) ? '' : ' ';
  return `${clauseNo}${separator}${title}`.trim();
}

function displayClauseNo(sourceChapterTitle: string, parts: { clauseNo: string; title: string }): string {
  return [normalizeSourceChapterTitle(sourceChapterTitle), joinClauseTitle(parts)]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function isSourceRoot(block: TenderBlock, sourceChapterTitle: string): boolean {
  const normalized = (value: string) => value.replace(/^第?[一二三四五六七八九十百0-9]+章\s*/, '').replace(/\s+/g, '');
  return normalized(cleanBlockText(block.text)) === normalized(cleanBlockText(sourceChapterTitle));
}

function isPlainMajorHeading(block: TenderBlock): boolean {
  return MAJOR_HEADING_RE.test(cleanBlockText(block.text));
}

function isPackageMarker(block: TenderBlock): boolean {
  return /^(?:包|分包|标段)\s*[一二三四五六七八九十百千万0-9]+(?:号)?[：:]?$/u.test(cleanBlockText(block.text));
}

function specialKind(block: TenderBlock): RequirementAggregation | null {
  const { title } = titleParts(block);
  if (PRINCIPLE_TITLE_RE.test(title)) return 'principles';
  if (ASSESSMENT_OBJECT_TITLE_RE.test(title)) return 'assessment-objects';
  if (METHOD_CONTENT_TITLE_RE.test(title)) return 'method-content';
  return null;
}

function specialGroupEnd(blocks: TenderBlock[], start: number): number {
  const startBlock = blocks[start];
  for (let index = start + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (startBlock.type === 'heading' && block.type === 'heading' && block.level > 0 && block.level <= startBlock.level) {
      return index;
    }
    if (startBlock.type !== 'heading' && isPlainMajorHeading(block)) return index;
  }
  return blocks.length;
}

function plainText(blocks: TenderBlock[]): string {
  return blocks.map((block) => block.text).filter(Boolean).join('\n').trim();
}

function requirementMarkdown(blocks: TenderBlock[], parts: { clauseNo: string; title: string }, stripTitle: boolean): string {
  return blocks
    .map((block, index) => (index === 0 && stripTitle ? stripLeadingTitleFromRaw(block.raw, parts) : block.raw.trim()))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function restoreReferenceBullets(markdown: string, title: string): string {
  if (!REFERENCE_TITLE_RE.test(title.trim())) return markdown;
  return markdown.replace(/(^|\n)([ \t]*)[-*+][ \t]+/g, '$1$2◆ ');
}

function hasImageMarkdown(markdown: string): boolean {
  return /!\[[^\]]*]\([^)]+\)|<img\b/i.test(markdown);
}

function appendMissingImageNotice(markdown: string): string {
  const trimmed = markdown.trim();
  if (!IMAGE_REFERENCE_RE.test(trimmed) || hasImageMarkdown(trimmed) || /图片未保留/.test(trimmed)) return markdown;
  return `${trimmed}\n\n【图片未保留：招标文件原文此处疑似包含图片，当前解析结果未保存图片，请人工核对原文件并补充。】`;
}

function stripMarkdownEmphasis(markdown: string): string {
  return markdown.replace(/\*\*/g, '').replace(/__/g, '');
}

function normalizeRequirementMarkdown(markdown: string, parts: { title: string }): string {
  return stripMarkdownEmphasis(appendMissingImageNotice(restoreReferenceBullets(markdown, parts.title))).trim();
}

function sourceFingerprint(clauseNo: string, markdown: string): string {
  const normalized = markdown.replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(`${clauseNo}\n${normalized}`).digest('hex');
}

function makeRow(
  blocks: TenderBlock[],
  aggregation: RequirementAggregation,
  fallbackTitle: string,
  sourceChapterTitle: string,
): ExtractedRequirementRow {
  const first = blocks[0];
  const parts = titleParts(first);
  const clauseNo = displayClauseNo(sourceChapterTitle, parts);
  const rawMarkdown = requirementMarkdown(blocks, parts, Boolean(parts.clauseNo) || first.type === 'heading' || isPlainMajorHeading(first));
  const markdown = normalizeRequirementMarkdown(rawMarkdown, parts);
  return {
    clauseNo,
    requirementTitle: parts.title || fallbackTitle,
    requirementMarkdown: markdown,
    requirementPlainText: plainText(blocks),
    sourceBlockIds: blocks.map((block) => block.id),
    aggregation,
    sourceFingerprint: sourceFingerprint(clauseNo, markdown),
    confidence: 'high',
  };
}

function isIndependentClause(block: TenderBlock): boolean {
  return Boolean(block.clauseNo || isPlainMajorHeading(block));
}

function isTechnicalSpecPointByPointTemplate(scope: RequirementScope): boolean {
  const title = `${scope.templateTitle || ''} ${scope.sourceChapterTitle || ''}`.replace(/\s+/g, '');
  return /技术(?:规范|需求|规格)书.*(?:应答|响应).*偏离表/u.test(title)
    || /技术(?:规范|需求|规格)书.*点对点/u.test(title);
}

function isTopLevelNumericClause(block: TenderBlock): boolean {
  const parts = titleParts(block);
  return /^\d{1,3}[.．、)]$/u.test(parts.clauseNo.trim()) && Boolean(parts.title.trim());
}

function collectRows(rows: ExtractedRequirementRow[]): ExtractionResult {
  const occurrences = new Map<string, number>();
  for (const row of rows) {
    for (const id of row.sourceBlockIds) occurrences.set(id, (occurrences.get(id) || 0) + 1);
  }
  return {
    rows,
    coveredBlockIds: [...new Set(rows.flatMap((row) => row.sourceBlockIds))],
    uncoveredBlockIds: [],
    duplicateBlockIds: [...occurrences.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  };
}

function extractTechnicalSpecPointByPointRequirements(blocks: TenderBlock[], scope: RequirementScope): ExtractionResult {
  const rows: ExtractedRequirementRow[] = [];
  const covered = new Set<string>();
  let pending: TenderBlock[] = [];

  const flushPending = () => {
    if (!pending.length) return;
    rows.push(makeRow(
      pending,
      isIndependentClause(pending[0]) ? 'numbered-clause' : 'unnumbered-section',
      scope.sourceChapterTitle,
      scope.sourceChapterTitle,
    ));
    pending.forEach((block) => covered.add(block.id));
    pending = [];
  };

  for (const block of blocks) {
    if (isSourceRoot(block, scope.sourceChapterTitle) || isPackageMarker(block)) {
      covered.add(block.id);
      continue;
    }
    if (isTopLevelNumericClause(block) || isPlainMajorHeading(block)) {
      flushPending();
      pending = [block];
      continue;
    }
    pending.push(block);
  }
  flushPending();

  const result = collectRows(rows);
  return {
    ...result,
    uncoveredBlockIds: blocks.map((block) => block.id).filter((id) => !covered.has(id)),
  };
}

export function extractRequirements(allBlocks: TenderBlock[], scope: RequirementScope): ExtractionResult {
  const allowed = new Set(scope.blockIds);
  const blocks = allBlocks.filter((block) => allowed.has(block.id));
  if (isTechnicalSpecPointByPointTemplate(scope)) {
    return extractTechnicalSpecPointByPointRequirements(blocks, scope);
  }
  const rows: ExtractedRequirementRow[] = [];
  const covered = new Set<string>();
  let pending: TenderBlock[] = [];

  const flushPending = () => {
    if (!pending.length) return;
    rows.push(makeRow(
      pending,
      isIndependentClause(pending[0]) ? 'numbered-clause' : 'unnumbered-section',
      scope.sourceChapterTitle,
      scope.sourceChapterTitle,
    ));
    pending.forEach((block) => covered.add(block.id));
    pending = [];
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (isSourceRoot(block, scope.sourceChapterTitle) || isPackageMarker(block)) {
      covered.add(block.id);
      continue;
    }

    const aggregation = specialKind(block);
    if (aggregation) {
      flushPending();
      const end = specialGroupEnd(blocks, index);
      const group = blocks.slice(index, end);
      rows.push(makeRow(group, aggregation, titleParts(block).title, scope.sourceChapterTitle));
      group.forEach((item) => covered.add(item.id));
      index = end - 1;
      continue;
    }

    if (isIndependentClause(block) || block.type === 'heading') {
      flushPending();
      pending = [block];
      continue;
    }

    pending.push(block);
  }
  flushPending();

  const occurrences = new Map<string, number>();
  for (const row of rows) {
    for (const id of row.sourceBlockIds) occurrences.set(id, (occurrences.get(id) || 0) + 1);
  }
  const duplicateBlockIds = [...occurrences.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const uncoveredBlockIds = blocks.map((block) => block.id).filter((id) => !covered.has(id));

  return {
    rows,
    coveredBlockIds: [...covered],
    uncoveredBlockIds,
    duplicateBlockIds,
  };
}
