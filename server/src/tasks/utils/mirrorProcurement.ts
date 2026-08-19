// 镜像采购需求章节生成（mirror-procurement-requirement）。
//
// 设计见 docs/superpowers/specs/2026-08-10-mirror-procurement-requirement-design.md。
// 本模块是「半 prompt + 半代码」中的代码半边：
//  - 结构提取 prompt 默认常量（本文件）→ 经提示词管理（runnerKey='mirror-procurement'）可被 admin 编辑。
//  - 结构提取 LLM 调用 / 标题树构造 / 大纲插入（Phase 2 加）。
//  - 确定性语气改写 applyMirrorToneRewrite（Phase 3 加）。
//
// 与既有「AI 分散改写采购需求进各章」并存：本模块只负责「逐条原文响应」的独立镜像章。
import type { OutlineAiService, OutlineItem } from './outlineGenerationHelpers';
import { collectJson } from './outlineGenerationHelpers';

// 提示词管理 itemKey（与 store.ts 常量保持一致）。
export const MIRROR_STRUCTURE_EXTRACT_KEY = 'structure_extract';
export const MIRROR_TONE_REWRITE_KEY = 'tone_rewrite';

// 「需求类」章节标题变体名（结构提取 prompt 内列举，LLM 按标题语义识别，非硬匹配）。
export const PROCUREMENT_CHAPTER_VARIANTS = [
  '采购需求',
  '服务需求',
  '服务要求',
  '服务内容',
  '项目需求',
  '采购内容',
  '技术需求',
  '项目概述与需求',
  '需求与技术要求',
  '货物与服务需求',
];

// 结构提取默认 prompt（runnerKey='mirror-procurement', itemKey='structure_extract' 的 seed/reset 源）。
// 输出强制 JSON。任务：定位需求章 → 产出标题树（采购→服务改名、扁平段落提升分级、叶子带逐字原文 sourceText）。
export function buildMirrorStructureExtractPromptDefault(): string {
  return `你是招标文件结构分析专家。你的任务是：从招标文件原文中定位「采购需求」类章节，并把它结构化为一棵标题树，供技术方案「逐条原文响应」镜像章节使用。

# 任务

1. 在下方「招标原文」中，定位描述采购/服务/项目需求或要求的章节。这类章节的常见标题包括但不限于：${PROCUREMENT_CHAPTER_VARIANTS.join('、')}。按标题语义识别，不要拘泥于字面——叫「第四章 服务内容」「三、项目技术要求」等都算。若原文中无明显需求/要求类章节，返回 found=false。
2. 把定位到的需求章内容组织成一棵标题树：
   - 标题里的「采购」整词改为「服务」（如「采购需求」→「服务需求」、「采购内容」→「服务内容」）；但「采购人」不改（那是主体代称，留给后续处理）。
   - 招标原文中确实具有独立主题且后续有成段正文支撑的小节，可以提升为显式子节点标题（去掉原编号，只留标题文字，编号由系统自动补）。深层嵌套保持招标原有层级，不要强行压平。
   - 不要把短条目、原则清单、标准规范清单、整体要求条款逐条提升为四/五级标题。比如「保密原则：……」「标准性原则：……」应保留在「实施原则」正文里；多个《GB/T ……》标准应保留在「标准和规范」正文里逐项换行。
   - 如果某个候选标题与它的正文开头或全文基本一致（标题=正文内容），不要为它单独建子节点，应并入父节点 sourceText。
   - 招标里已经是标题（有明确层级）的，照搬其标题文字（同样做「采购」→「服务」改名），保持层级。
3. 树的每个叶子节点必须带 sourceText：该叶子对应的招标原文片段，逐字搬运、不做任何改写。原文里的表格，以原始 HTML <table> 标签原样保留在 sourceText 中（含 colspan/rowspan 合并单元格）。原文里的图片可省略。sourceText 只覆盖到该叶子直接对应的段落/小节正文，不要把兄弟节点的正文也卷进来。

# 输出格式（严格 JSON，不要 markdown 代码块包裹，不要任何解释文字）

{
  "found": true,
  "chapterTitle": "在招标原文中识别到的需求章原标题（不改名，原样）",
  "tree": {
    "title": "服务需求",
    "children": [
      {
        "title": "服务内容",
        "children": [
          { "title": "重要数据安全风险评估（第三方评估）", "sourceText": "原文片段 markdown，含 <table>...</table>" }
        ]
      }
    ]
  }
}

规则：
- tree 顶层 title 你可以按需求章主题命名（已做采购→服务改名）。
- 每个节点要么有 children（非叶子，容器章），要么有 sourceText（叶子），不同时有。
- 若 found=false，tree 字段可省略或为 null。
- 只输出 JSON 本身，首个字符必须是 { 。`;
}

// 语气改写 prompt 预留默认（runnerKey='mirror-procurement', itemKey='tone_rewrite'）。
// 本期镜像语气走确定性代码替换（applyMirrorToneRewrite，Phase 3），不走 LLM；此 prompt 为后期可选的 LLM 语气微调占位。
export function buildMirrorToneRewritePromptDefault(): string {
  return `# 镜像章节语气改写（预留，本期未启用）

本期镜像章节的语气改写（「须」→「将」、「需+动词」→「将+动词」、代称→全称）由确定性代码完成，不调用 LLM。

本提示词为后续可选增强预留：若希望镜像正文经 LLM 做更自然的语气润色（而非纯字面替换），可在提示词管理启用此 item 并在搬运管线接入。默认不启用。`;
}

// ====================================================================
// 结构提取（LLM）+ 大纲子树构造 + 合并
// ====================================================================

export interface MirrorTreeNode {
  title: string;
  children?: MirrorTreeNode[];
  sourceText?: string;
}

export interface MirrorExtractResult {
  found: boolean;
  chapterTitle?: string;
  tree?: MirrorTreeNode;
}

// 从 storedPlan.bidAnalysisTasks.procurementList 抽取采购清单 fact 文本，作为结构提取的辅助锚定。
export function extractProcurementListText(storedPlan: Record<string, unknown> | null | undefined): string {
  if (!storedPlan) return '';
  const tasks = storedPlan.bidAnalysisTasks as Record<string, { content?: string; status?: string }> | undefined;
  const node = tasks?.procurementList;
  if (!node || node.status !== 'success') return '';
  return String(node.content || '').trim();
}

// 「采购」整词改「服务」，保护「采购人」（主体代称，留给全局代称替换层处理）。
export function applyServiceRename(title: string): string {
  if (!title) return title;
  return title.replace(/采购(?!人)/g, '服务');
}

// 确定性语气改写：招标原文的「规定性语气」（须/需）→ 投标响应的「承诺语气」（将）。
// 仅做字面替换，与全局主体替换层（供应商→我方全称、采购人→采购人全称，由 saveSection 内
// applySubjectReplacement 自动叠加）正交，互不干扰。
//
// 规则：
//  - 须 → 将（保护「无须」：无 preceding 时不替换，避免「无须」→「无将」）。
//    「必须」→「必将」属可接受的承诺语气，故不额外保护。
//  - 需 → 将，仅当后接动词且不构成非规定性词时。保护下列「需」的常见非规定性用法：
//    需要、需求、必需、无需、急需、按需、所需、供需、亟需（前缀查表 + 后缀 要/求）。
//    「应/应当」本期不处理（spec 范围仅 须/需）。
export function applyMirrorToneRewrite(text: string): string {
  if (!text) return text;
  let out = text.replace(/(?<!无)须/g, '将');
  out = out.replace(/(?<![必无急按所供亟])需(?!要|求)/g, '将');
  return out;
}

function compactInlineWhitespace(value: string): string {
  return String(value || '').replace(/[ \t　]+/g, ' ').trim();
}

function splitBookTitleListLine(line: string): string {
  const source = String(line || '');
  const matches = [...source.matchAll(/《[^》]+》/g)];
  if (matches.length < 2) return source;

  const firstIndex = matches[0].index ?? 0;
  const prefix = compactInlineWhitespace(source.slice(0, firstIndex));
  const items: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? source.length) : source.length;
    const item = compactInlineWhitespace(source.slice(start, end));
    if (item) items.push(item);
  }
  return [prefix, ...items].filter(Boolean).join('\n\n');
}

export function normalizeMirrorTextForCarry(text: string): string {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => splitBookTitleListLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtmlTags(value: string): string {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, '')
    .trim();
}

function extractHtmlCells(rowHtml: string): Array<{
  tag: string;
  attrs: string;
  inner: string;
  start: number;
  end: number;
}> {
  const cells: Array<{ tag: string; attrs: string; inner: string; start: number; end: number }> = [];
  const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = cellRe.exec(rowHtml))) {
    cells.push({
      tag: match[1].toLowerCase(),
      attrs: match[2] || '',
      inner: match[3] || '',
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return cells;
}

function repairSequenceTable(tableHtml: string): string {
  const rows = [...String(tableHtml || '').matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)]
    .map((match) => ({
      html: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      cells: extractHtmlCells(match[0]),
    }));
  if (!rows.length) return tableHtml;

  const headerIndex = rows.findIndex((row) => {
    const firstCell = row.cells[0];
    if (!firstCell) return false;
    const text = stripHtmlTags(firstCell.inner);
    return /^(序号|编号)$/.test(text);
  });
  if (headerIndex < 0) return tableHtml;

  const headerCellCount = rows[headerIndex].cells.length;
  if (headerCellCount < 2) return tableHtml;

  let repaired = tableHtml;
  let offset = 0;
  let ordinal = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    const cells = row.cells;
    if (cells.length !== headerCellCount) continue;
    if (!cells.slice(1).some((cell) => stripHtmlTags(cell.inner))) continue;

    ordinal += 1;
    const firstCell = cells[0];
    const firstText = stripHtmlTags(firstCell.inner);
    if (firstText) {
      const parsed = Number.parseInt(firstText, 10);
      if (Number.isFinite(parsed) && parsed > 0) ordinal = parsed;
      continue;
    }
    if (/\b(?:rowspan|colspan)\s*=/i.test(firstCell.attrs)) continue;

    const replacement = `<${firstCell.tag}${firstCell.attrs}><p>${ordinal}</p></${firstCell.tag}>`;
    const start = row.start + firstCell.start + offset;
    const end = row.start + firstCell.end + offset;
    repaired = repaired.slice(0, start) + replacement + repaired.slice(end);
    offset += replacement.length - (firstCell.end - firstCell.start);
  }
  return repaired;
}

export function repairMirrorSourceTextTables(text: string): string {
  return String(text || '').replace(/<table\b[\s\S]*?<\/table>/gi, (table) => repairSequenceTable(table));
}

function normalizeInlineLabel(value: string): string {
  return String(value || '')
    .replace(/^[\s\d一二三四五六七八九十百千万]+[.．、）)]\s*/, '')
    .replace(/^[（(][\d一二三四五六七八九十]+[）)]\s*/, '')
    .replace(/[：:。；;，,\s《》“”"']/g, '')
    .trim();
}

function startsWithInlineLabel(sourceText: string, title: string): boolean {
  const source = normalizeInlineLabel(sourceText).slice(0, Math.max(24, normalizeInlineLabel(title).length + 12));
  const label = normalizeInlineLabel(title);
  return Boolean(label && (source.startsWith(label) || source.includes(label)));
}

function isInlineMirrorLeaf(node: MirrorTreeNode): boolean {
  const sourceText = String(node.sourceText || '').trim();
  if (!sourceText || (node.children || []).length) return false;
  if (/^《[^》]+》/.test(sourceText)) return true;
  if (sourceText.length > 800) return false;
  return startsWithInlineLabel(sourceText, node.title);
}

function shouldCompressLeafChildren(parent: MirrorTreeNode, children: MirrorTreeNode[]): boolean {
  if (children.length < 2) return false;
  if (!children.every((child) => !(child.children || []).length && String(child.sourceText || '').trim())) return false;
  const parentTitle = String(parent.title || '');
  const parentLooksLikeList = /(原则|要求|标准|规范|承诺|清单|依据|条款|内容)$/.test(parentTitle)
    || /(原则|要求|标准|规范|承诺|清单|依据|条款)/.test(parentTitle);
  return parentLooksLikeList && children.every(isInlineMirrorLeaf);
}

function joinCompressedLeafText(children: MirrorTreeNode[]): string {
  const normalized = children
    .map((child) => normalizeMirrorTextForCarry(String(child.sourceText || '').trim()))
    .filter(Boolean);
  return normalized.join('\n\n');
}

export function refineMirrorTreeForOutline(tree: MirrorTreeNode): MirrorTreeNode {
  const children = (tree.children || []).map(refineMirrorTreeForOutline);
  if (children.length && shouldCompressLeafChildren(tree, children)) {
    return {
      title: tree.title,
      sourceText: joinCompressedLeafText(children),
    };
  }
  return {
    ...tree,
    children: children.length ? children : undefined,
  };
}

function normalizeMirrorNode(node: unknown): MirrorTreeNode | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const title = String(obj.title || '').trim();
  if (!title) return null;
  const result: MirrorTreeNode = { title };
  if (Array.isArray(obj.children)) {
    const children = obj.children.map(normalizeMirrorNode).filter((n): n is MirrorTreeNode => n !== null);
    if (children.length) result.children = children;
  }
  if (typeof obj.sourceText === 'string' && obj.sourceText.trim()) {
    result.sourceText = obj.sourceText;
  }
  return result;
}

function normalizeMirrorExtract(value: unknown): MirrorExtractResult {
  if (!value || typeof value !== 'object') return { found: false };
  const obj = value as Record<string, unknown>;
  const found = obj.found !== false;
  const tree = normalizeMirrorNode(obj.tree);
  if (!found || !tree) return { found: false };
  return {
    found: true,
    chapterTitle: obj.chapterTitle ? String(obj.chapterTitle) : undefined,
    tree,
  };
}

function validateMirrorExtract(value: unknown): void {
  const normalized = normalizeMirrorExtract(value);
  if (!normalized.found || !normalized.tree) {
    throw new Error('镜像结构提取未返回有效标题树');
  }
}

// 结构提取 LLM 调用：定位需求章 → 产出标题树（采购→服务改名、扁平段落提升分级、叶子带逐字 sourceText）。
export async function extractMirrorOutline(params: {
  aiService: OutlineAiService;
  tenderMarkdown: string;
  procurementListText: string;
  prompt: string;
}): Promise<MirrorExtractResult> {
  const { aiService, tenderMarkdown, procurementListText, prompt } = params;
  const userContent = `# 招标原文\n\n${tenderMarkdown}\n\n# 采购清单摘要（辅助锚定，可能为空）\n\n${procurementListText || '（无）'}`;
  const raw = (await collectJson(aiService, {
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    normalizer: normalizeMirrorExtract,
    validator: validateMirrorExtract,
    failureMessage: '镜像采购需求结构提取返回数据格式无效',
  })) as MirrorExtractResult;
  return raw;
}

// 把镜像标题树包装成顶级章 OutlineItem 子树。
// nodeId 前缀 mirror-，DFS 递增；非叶子为容器（无正文），叶子带 mirrorSourceText + content=''（待搬运填充）。
// 所有节点 isMirror=true（容器与叶子都标记，便于编辑页识别整棵镜像子树）。
export function buildMirrorOutlineSubtree(tree: MirrorTreeNode, topChapterTitle: string): OutlineItem {
  let counter = 0;
  const nextId = (): string => `mirror-${(counter += 1)}`;
  const buildNode = (node: MirrorTreeNode): OutlineItem => {
    const item: OutlineItem = {
      id: nextId(),
      title: applyServiceRename(node.title),
      isMirror: true,
    };
    const children = node.children || [];
    if (children.length) {
      item.children = children.map(buildNode);
    } else if (node.sourceText) {
      item.mirrorSourceText = repairMirrorSourceTextTables(node.sourceText);
      item.content = '';
    }
    return item;
  };
  return {
    id: nextId(),
    title: topChapterTitle,
    isMirror: true,
    children: (tree.children || []).map(buildNode),
  };
}

// 镜像顶级章插到既有大纲最前（sortOrder 由 flattenOutlineItems 按数组下标分配，前置插入即生效）。
export function mergeMirrorProcurementOutline(existingOutline: OutlineItem[], mirrorTopChapter: OutlineItem): OutlineItem[] {
  return [mirrorTopChapter, ...existingOutline];
}

// 一步编排：提取 → 构造 → 合并。失败/未命中返回原大纲不动（matched=false），由调用方决定日志。
export async function buildAndMergeMirrorOutline(params: {
  aiService: OutlineAiService;
  tenderMarkdown: string;
  procurementListText: string;
  structureExtractPrompt: string;
  existingOutline: OutlineItem[];
  topChapterTitle?: string;
}): Promise<{ outline: OutlineItem[]; matched: boolean }> {
  const { aiService, tenderMarkdown, procurementListText, structureExtractPrompt, existingOutline, topChapterTitle } = params;
  if (!tenderMarkdown.trim()) return { outline: existingOutline, matched: false };
  const result = await extractMirrorOutline({ aiService, tenderMarkdown, procurementListText, prompt: structureExtractPrompt });
  if (!result.found || !result.tree || !(result.tree.children || []).length) {
    return { outline: existingOutline, matched: false };
  }
  const refinedTree = refineMirrorTreeForOutline(result.tree);
  const topChapter = buildMirrorOutlineSubtree(refinedTree, topChapterTitle || '项目概述');
  return { outline: mergeMirrorProcurementOutline(existingOutline, topChapter), matched: true };
}
