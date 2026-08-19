// STEP03 技术/响应方案章节要求提取器。
// 目的：在“技术评分表优先”的目录生成主线之外，确定性识别招标文件里
// “响应方案/技术方案/服务方案”等章节清单，作为二级/三级目录覆盖约束。

export type TechnicalProposalStructureMode = 'none' | 'self_defined' | 'explicit_checklist';

export interface TechnicalProposalStructureItem {
  title: string;
  evidence?: string;
}

export interface TechnicalProposalStructureRequirement {
  title: string;
  mode: TechnicalProposalStructureMode;
  aliasesMatched: string[];
  items: TechnicalProposalStructureItem[];
  evidence: string;
}

export const TECHNICAL_PROPOSAL_ALIASES = [
  '响应方案',
  '技术方案',
  '服务方案',
  '技术服务方案',
  '技术响应方案',
  '技术说明书',
  '技术文件',
  '技术标',
  '技术投标文件',
  '技术响应文件',
  '项目实施方案',
  '实施方案',
  '组织实施方案',
  '项目管理方案',
  '施工组织设计',
  '施工方案与技术措施',
  '运维服务方案',
  '售后服务方案',
  '质保期服务方案',
  '安装和售后服务方案',
  '解决方案',
  '建设方案',
  '供货方案',
  '整体供货方案',
] as const;

const SELF_DEFINED_RE = /(格式|目录|内容)?\s*(自拟|自行编制|自行拟定|自行设计|自行组织|自行安排|不作统一格式要求|无固定格式|格式不限|目录不限)/;
const INCLUDE_RE = /(参考内容如下|主要内容如下|应包括|应包含|须包括|须包含|至少包括|至少包含|包括但不限于|内容包括|方案包括|应从以下|按照以下|包含以下)/;
const SCORING_CONTEXT_RE = /(评审因素和标准|评分细则|评分标准|评分因素|评标标准|分值|得分|扣分|满分|磋商小组|评审小组|评标委员会|推荐成交候选人|综合得分|算术平均值|四舍五入|无效投标|投标无效)/;
const LIST_MARKER_RE = /(?:^|[\s\r\n:：；;])(?:（\s*\d{1,2}\s*）|\(\s*\d{1,2}\s*\)|\d{1,2}[、.)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/g;
const CHINESE_NUMERAL = '零〇一二三四五六七八九十百千万两';
const CLEAR_CHAPTER_HEADING_RE = new RegExp(
  `^(?:第\\s*(?:[${CHINESE_NUMERAL}]+|\\d{1,3})\\s*[章节篇部分条]\\s*|[${CHINESE_NUMERAL}]+\\s*[、.．]\\s*|[（(]\\s*[${CHINESE_NUMERAL}]+\\s*[）)]\\s*)`,
);
const ARABIC_CHAPTER_HEADING_RE = /^\d{1,3}\s*[、．]\s*/;
const PARENTHESIZED_ARABIC_LIST_RE = /^(?:（\s*\d{1,2}\s*）|\(\s*\d{1,2}\s*\))/;

type CandidateBlock = {
  title: string;
  block: string;
  aliasesMatched: string[];
  kind: 'heading' | 'alias-context';
};

function normalizeText(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAliases(text: string): string[] {
  return TECHNICAL_PROPOSAL_ALIASES.filter((alias) => text.includes(alias));
}

function cleanHeading(line: string): string {
  return normalizeText(line)
    .replace(/^#{1,6}\s*/, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function cleanItemTitle(value: string): string {
  let title = normalizeText(value)
    .replace(/^[-—、,，:：；;。.]+/, '')
    .replace(/^[（(]?\d{1,2}[）).、]\s*/, '')
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
    .replace(/[；;。.\s]+$/, '')
    .trim();
  const sentenceBreak = title.search(/[。；;]\s*/);
  if (sentenceBreak > 0 && sentenceBreak < 80) {
    title = title.slice(0, sentenceBreak).trim();
  }
  return title;
}

function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(normalizeText(line)) || /^\*\*.+\*\*$/.test(normalizeText(line));
}

function isParenthesizedArabicListLine(line: string): boolean {
  return PARENTHESIZED_ARABIC_LIST_RE.test(cleanHeading(line));
}

function lineLooksLikeStructuralHeading(line: string): boolean {
  const raw = normalizeText(line);
  const trimmed = cleanHeading(raw);
  if (!trimmed || trimmed.length > 80) return false;
  if (isMarkdownHeading(raw)) return true;
  if (isParenthesizedArabicListLine(trimmed)) return false;
  return CLEAR_CHAPTER_HEADING_RE.test(trimmed) || ARABIC_CHAPTER_HEADING_RE.test(trimmed);
}

function isScoringLikeBlock(block: string): boolean {
  const normalized = normalizeText(block);
  if (!SCORING_CONTEXT_RE.test(normalized)) return false;
  if (/(响应方案参考内容如下|服务方案参考内容如下|技术方案参考内容如下|服务类项目供应商应根据|服务大纲|响应文件组成)/.test(normalized)) {
    return false;
  }
  return true;
}

function extractChecklistItems(block: string): TechnicalProposalStructureItem[] {
  const normalized = normalizeText(block);
  if (!normalized) return [];

  const marked = normalized.replace(LIST_MARKER_RE, '\n@@ITEM@@');
  const chunks = marked.split('@@ITEM@@').slice(1);
  const items = chunks
    .map((chunk) => {
      const title = cleanItemTitle(chunk);
      if (!title || title.length < 2 || title.length > 90) return null;
      if (/^(如下|包括|包含|参考内容如下)$/.test(title)) return null;
      return { title, evidence: chunk.trim().slice(0, 180) };
    })
    .filter((item): item is TechnicalProposalStructureItem => Boolean(item));

  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title.replace(/\s+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function headingLooksRelevant(line: string): boolean {
  const trimmed = cleanHeading(line);
  if (!trimmed || trimmed.length > 40) return false;
  if (!TECHNICAL_PROPOSAL_ALIASES.some((alias) => trimmed.includes(alias))) return false;
  if (!lineLooksLikeStructuralHeading(line)) return false;
  return !(/[；;]\s*$/.test(trimmed) && !isMarkdownHeading(line));
}

function collectCandidateBlocks(text: string): CandidateBlock[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const candidates: CandidateBlock[] = [];
  const lines = normalized.split('\n');
  let offset = 0;
  const lineStarts = lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });

  lines.forEach((line, index) => {
    if (!headingLooksRelevant(line)) return;
    const start = lineStarts[index];
    const nextHeadingIndex = lines.findIndex((nextLine, nextIndex) => (
      nextIndex > index
      && nextIndex <= index + 120
      && lineLooksLikeStructuralHeading(nextLine)
    ));
    const hardEnd = nextHeadingIndex > index ? lineStarts[nextHeadingIndex] : start + 5000;
    const block = normalized.slice(start, Math.min(normalized.length, hardEnd));
    candidates.push({
      title: cleanHeading(line),
      block,
      aliasesMatched: findAliases(block),
      kind: 'heading',
    });
  });

  for (const alias of TECHNICAL_PROPOSAL_ALIASES) {
    const index = normalized.indexOf(alias);
    if (index < 0) continue;
    const start = Math.max(0, index - 160);
    const block = normalized.slice(start, Math.min(normalized.length, index + 2200));
    candidates.push({
      title: alias,
      block,
      aliasesMatched: findAliases(block),
      kind: 'alias-context',
    });
  }

  return candidates;
}

function pickExplicitChecklistCandidate(text: string): TechnicalProposalStructureRequirement | null {
  const candidates = collectCandidateBlocks(text);
  const hasHeadingCandidate = candidates.some((candidate) => candidate.kind === 'heading');
  let best: TechnicalProposalStructureRequirement | null = null;
  for (const candidate of candidates) {
    if (hasHeadingCandidate && candidate.kind === 'alias-context') continue;
    if (candidate.kind === 'alias-context' && !INCLUDE_RE.test(candidate.block)) continue;
    if (isScoringLikeBlock(candidate.block)) continue;
    const focusedBlock = INCLUDE_RE.test(candidate.block)
      ? candidate.block.slice(Math.max(0, candidate.block.search(INCLUDE_RE)))
      : candidate.block;
    const items = extractChecklistItems(focusedBlock);
    if (items.length < 2) continue;
    const next: TechnicalProposalStructureRequirement = {
      title: candidate.title || candidate.aliasesMatched[0] || '技术/响应方案',
      mode: 'explicit_checklist',
      aliasesMatched: uniq(candidate.aliasesMatched),
      items,
      evidence: candidate.block.slice(0, 1800),
    };
    if (!best || next.items.length > best.items.length) {
      best = next;
    }
  }
  return best;
}

export function extractTechnicalProposalStructureRequirement(markdown: string): TechnicalProposalStructureRequirement {
  const text = normalizeText(markdown);
  if (!text) {
    return { title: '', mode: 'none', aliasesMatched: [], items: [], evidence: '' };
  }

  const explicit = pickExplicitChecklistCandidate(text);
  if (explicit) return explicit;

  const aliasesMatched = findAliases(text);
  if (aliasesMatched.length && SELF_DEFINED_RE.test(text)) {
    const firstAlias = aliasesMatched[0] || '技术/响应方案';
    const index = text.indexOf(firstAlias);
    return {
      title: firstAlias,
      mode: 'self_defined',
      aliasesMatched,
      items: [],
      evidence: text.slice(Math.max(0, index - 160), Math.min(text.length, index + 700)),
    };
  }

  return {
    title: aliasesMatched[0] || '',
    mode: 'none',
    aliasesMatched,
    items: [],
    evidence: aliasesMatched.length ? text.slice(0, 700) : '',
  };
}

export function formatTechnicalProposalStructureForPrompt(requirement: TechnicalProposalStructureRequirement | null | undefined): string {
  if (!requirement || requirement.mode === 'none') return '';
  if (requirement.mode === 'self_defined') {
    return [
      '技术/响应方案章节要求：',
      `- 识别到招标文件对“${requirement.title || '技术/响应方案'}”允许格式自拟或投标人自行编制，未发现硬性章节清单。`,
      '- 本次目录生成仍以技术评分表为主线，不要因为“格式自拟”额外虚构固定章节。',
    ].join('\n');
  }
  const itemLines = requirement.items.map((item, index) => `${index + 1}. ${item.title}`).join('\n');
  return [
    '技术/响应方案章节要求：',
    `- 来源标题：${requirement.title || '技术/响应方案'}`,
    `- 已识别明确章节/参考内容清单 ${requirement.items.length} 项。`,
    '- 目录融合规则：评分表决定一级目录主线；以下清单项必须作为二级/三级目录或章节描述并入最匹配的评分章节。',
    '- 不要用该清单替换技术评分大类，也不要把该清单整体另起一个重复的顶级目录。',
    itemLines,
  ].join('\n');
}
