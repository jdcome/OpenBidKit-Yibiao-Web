import type { ProjectTenderSourceSnapshot, TenderBlock } from './types';

export interface ProjectFieldEvidence {
  value: string;
  evidence: string;
  source: 'step02' | 'markdown' | 'package' | 'manual' | 'empty';
}

export interface ResponseDeviationProjectFields {
  projectName: ProjectFieldEvidence;
  projectNumber: ProjectFieldEvidence;
  procurementNumber: ProjectFieldEvidence;
  packageName: ProjectFieldEvidence;
  packageNumber: ProjectFieldEvidence;
}

export interface ResponseDeviationTemplateSchema {
  detected: boolean;
  columns: string[];
  title: string;
  source?: 'markdown-table' | 'html-table' | 'fallback';
  prefixMarkdown?: string;
  suffixMarkdown?: string;
}

function flattenStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flattenStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => flattenStrings(item, out));
  return out;
}

export function unescapeMarkdownText(value: string): string {
  return value.replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, '$1').trim();
}

function isHtmlFragment(value: string): boolean {
  return /<\/?(?:table|tbody|thead|tr|td|th|p|div|span|strong)\b/i.test(value);
}

function isFieldLabelOnly(value: string): boolean {
  return /^(?:项目名称|采购项目名称|采购标的名称|项目编号|采购代理编号|招标编号|磋商编号|政府采购编号|采购计划编号|采购编号|包名称|包件名称|标段名称|包号|包件号|标段号)\s*[：:]?$/.test(value);
}

function isTemplatePlaceholderLeak(value: string): boolean {
  return /^[）)\]】}；;、，,。]/u.test(value)
    || /(?:全部内容|知悉参加|我方承诺|接受(?:磋商|招标|采购)文件的全部条款|无任何异议)/u.test(value);
}

export function cleanFieldValue(value: string): string {
  const cleaned = unescapeMarkdownText(value).replace(/\*\*/g, '').replace(/__/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned || isHtmlFragment(cleaned) || isFieldLabelOnly(cleaned) || isTemplatePlaceholderLeak(cleaned)) return '';
  return cleaned;
}

function findField(texts: Array<{ text: string; source: ProjectFieldEvidence['source'] }>, labels: string[]): ProjectFieldEvidence {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?:${escaped})\\s*[：:]\\s*([^\\n\\r|；;]{1,160})`, 'i');
  for (const item of texts) {
    const match = item.text.match(pattern);
    if (match?.[1]?.trim()) {
      const value = cleanFieldValue(match[1]);
      if (!value) continue;
      const evidence = unescapeMarkdownText(match[0]).trim();
      return { value, evidence: evidence.slice(0, 180), source: item.source };
    }
  }
  return { value: '', evidence: '', source: 'empty' };
}

function packageNameFromTitle(title: string): string {
  return cleanFieldValue(title.replace(/^(?:第?[一二三四五六七八九十百千万0-9]+(?:包|标段)|包件?\s*[一二三四五六七八九十百千万0-9]+)[：:\s、.-]*/u, ''));
}

function packageNumberFromTitle(title: string): string {
  const match = title.match(/(?:第?\s*([一二三四五六七八九十百千万0-9]+)\s*(?:包|标段)|包件?\s*([一二三四五六七八九十百千万0-9]+))/u);
  if (!match) return '';
  const raw = String(match[1] || match[2] || '').trim();
  const chineseDigits: Record<string, string> = {
    一: '1',
    二: '2',
    三: '3',
    四: '4',
    五: '5',
    六: '6',
    七: '7',
    八: '8',
    九: '9',
    十: '10',
  };
  return chineseDigits[raw] || raw;
}

export function extractProjectFields(source: ProjectTenderSourceSnapshot): ResponseDeviationProjectFields {
  const step02 = flattenStrings(source.analysis).map((text) => ({ text, source: 'step02' as const }));
  const markdown = [{ text: source.markdown, source: 'markdown' as const }];
  const texts = [...step02, ...markdown];
  const packageNumber = findField(texts, ['包号', '包件号', '标段号']);
  const packageName = findField(texts, ['包名称', '包件名称', '标段名称']);
  if (!packageNumber.value && source.selectedSectionTitle) {
    const value = packageNumberFromTitle(source.selectedSectionTitle);
    if (value) Object.assign(packageNumber, { value, evidence: source.selectedSectionTitle, source: 'package' as const });
  }
  if (!packageName.value && source.selectedSectionTitle) {
    const value = packageNameFromTitle(source.selectedSectionTitle);
    if (value) Object.assign(packageName, { value, evidence: source.selectedSectionTitle, source: 'package' as const });
  }
  return {
    projectName: findField(texts, ['项目名称', '采购项目名称', '采购标的名称']),
    projectNumber: findField(texts, ['项目编号', '采购代理编号', '招标编号', '磋商编号']),
    procurementNumber: findField(texts, ['政府采购编号', '采购计划编号', '采购编号']),
    packageName,
    packageNumber,
  };
}

export function sanitizeProjectFieldPatch(fields: unknown): Record<string, unknown> {
  const patch = fields && typeof fields === 'object' ? fields as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!raw || typeof raw !== 'object') {
      result[key] = raw;
      continue;
    }
    const field = raw as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(field, 'value')) {
      result[key] = raw;
      continue;
    }
    result[key] = {
      ...field,
      value: cleanFieldValue(String(field.value ?? '')),
    };
  }
  return result;
}

function splitMarkdownCells(raw: string): string[] {
  const first = raw.split(/\r?\n/).find((line) => line.trim().startsWith('|')) || '';
  return first.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cleanTemplateCell(cell)).filter(Boolean);
}

function htmlText(value: string): string {
  return value
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|span|strong|b)\s*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function cleanTemplateCell(value: string): string {
  return unescapeMarkdownText(htmlText(value)
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/\s+/g, ' '));
}

function normalizeTemplateTitle(value: string): string {
  return cleanTemplateCell(value)
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, '')
    .replace(/[，,。；;：:、（）()\[\]【】《》<>]/g, '')
    .toLowerCase();
}

function isResponseDeviationColumns(columns: string[]): boolean {
  const text = columns.join('|');
  const hasClauseColumn = /(?:条目号|条款号|文件条款|磋商文件|比选文件|招标文件)/u.test(text);
  const hasRequirementColumn = /(?:采购规格|商务条款|招标文件要求|磋商文件要求|比选文件要求|采购要求|对应的?内容|技术规范书?条款|技术要求)/u.test(text);
  const hasDeviationColumn = /(?:响应与偏离|应答偏离|偏离情况|偏离说明|偏离)/u.test(text);
  return hasClauseColumn && hasRequirementColumn && hasDeviationColumn;
}

function splitHtmlHeaderCells(raw: string): string[] {
  const firstRow = raw.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)?.[1] || '';
  return [...firstRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map((match) => cleanTemplateCell(match[1]))
    .filter(Boolean);
}

function blockMarkdown(block: TenderBlock): string {
  return block.raw.trim();
}

function cleanBlockText(block: TenderBlock): string {
  return cleanTemplateCell(block.raw || block.text);
}

function isTemplateTitleBlock(block: TenderBlock, normalizedTitle: string): boolean {
  const normalizedBlockTitle = normalizeTemplateTitle(block.text || block.raw);
  return Boolean(normalizedBlockTitle)
    && (normalizedBlockTitle.includes(normalizedTitle) || normalizedTitle.includes(normalizedBlockTitle));
}

function isFormBoundaryBlock(block: TenderBlock, titleLevel: number): boolean {
  if (block.type === 'heading' && (!titleLevel || block.level <= titleLevel)) return true;
  if (block.type === 'markdown-table' || block.type === 'html-table') return true;
  const text = cleanBlockText(block);
  if (text.length > 90) return false;
  return /^(?:第?[一二三四五六七八九十百千万0-9]+[、.．]\s*)?.{0,50}(?:表|函|证明材料|清单|格式)$/u.test(text)
    || /^附件\s*[0-9一二三四五六七八九十百千万]+(?:[-－—][0-9一二三四五六七八九十百千万]+)?\s*$/u.test(text);
}

function collectTemplateText(blocks: TenderBlock[], from: number, to: number): string {
  return blocks.slice(from, to)
    .filter((block) => block.type !== 'heading' && block.type !== 'markdown-table' && block.type !== 'html-table')
    .map(blockMarkdown)
    .map((text) => text.replace(/\*\*/g, '').replace(/__/g, ''))
    .filter(Boolean)
    .join('\n');
}

function findSuffixEnd(blocks: TenderBlock[], from: number, titleLevel: number): number {
  const max = Math.min(blocks.length, from + 16);
  for (let index = from; index < max; index += 1) {
    const block = blocks[index];
    if (isFormBoundaryBlock(block, titleLevel)) return index;
  }
  return max;
}

function findTemplateHeadingBefore(blocks: TenderBlock[], tableIndex: number, normalizedTitle: string, fallbackStart: number): number {
  for (let cursor = tableIndex - 1; cursor >= 0 && cursor >= tableIndex - 12; cursor -= 1) {
    if (blocks[cursor].type === 'heading' || isTemplateTitleBlock(blocks[cursor], normalizedTitle)) return cursor;
  }
  return fallbackStart;
}

export function extractTemplateSchema(blocks: TenderBlock[], templateTitle: string): ResponseDeviationTemplateSchema {
  const title = templateTitle.replace(/^#{1,6}\s+/, '').trim();
  const normalizedTitle = normalizeTemplateTitle(title);
  const titleIndexes = blocks.reduce<number[]>((indexes, block, index) => {
    const normalizedBlockTitle = normalizeTemplateTitle(block.text);
    if (normalizedBlockTitle && (normalizedBlockTitle.includes(normalizedTitle) || normalizedTitle.includes(normalizedBlockTitle))) {
      indexes.push(index);
    }
    return indexes;
  }, []);
  const start = titleIndexes[0] ?? -1;
  const titleBlock = start >= 0 ? blocks[start] : null;

  const buildSchema = (
    index: number,
    columns: string[],
    source: ResponseDeviationTemplateSchema['source'],
    headingIndex = start,
    headingBlock = titleBlock,
  ): ResponseDeviationTemplateSchema => {
    const effectiveHeadingIndex = headingIndex >= 0
      ? headingIndex
      : findTemplateHeadingBefore(blocks, index, normalizedTitle, -1);
    const suffixEnd = findSuffixEnd(blocks, index + 1, headingBlock?.level || 0);
    return {
      detected: true,
      columns,
      title,
      source,
      prefixMarkdown: collectTemplateText(blocks, effectiveHeadingIndex >= 0 ? effectiveHeadingIndex + 1 : Math.max(0, index - 4), index),
      suffixMarkdown: collectTemplateText(blocks, index + 1, suffixEnd),
    };
  };

  const semanticTableAt = (index: number): {
    columns: string[];
    source: Extract<ResponseDeviationTemplateSchema['source'], 'markdown-table' | 'html-table'>;
  } | null => {
    const block = blocks[index];
    const columns = block.type === 'markdown-table'
      ? splitMarkdownCells(block.raw)
      : block.type === 'html-table'
        ? splitHtmlHeaderCells(block.raw)
        : [];
    if (columns.length < 3 || !isResponseDeviationColumns(columns)) return null;
    return {
      columns,
      source: block.type === 'html-table' ? 'html-table' : 'markdown-table',
    };
  };

  for (const headingIndex of titleIndexes) {
    const headingBlock = blocks[headingIndex] || null;
    const searchEnd = Math.min(blocks.length - 1, headingIndex + 40);
    for (let index = headingIndex; index <= searchEnd; index += 1) {
      const table = semanticTableAt(index);
      if (table) {
        return buildSchema(index, table.columns, table.source, headingIndex, headingBlock);
      }
    }
  }

  const searchStart = start >= 0 ? start : 0;
  const searchEnd = start >= 0 ? Math.min(blocks.length - 1, searchStart + 24) : blocks.length - 1;
  for (let index = searchStart; index < blocks.length && index <= searchEnd; index += 1) {
    const block = blocks[index];
    if (block.type === 'markdown-table') {
      const columns = splitMarkdownCells(block.raw);
      if (columns.length >= 3) {
        return buildSchema(index, columns, 'markdown-table');
      }
    }
    if (block.type === 'html-table') {
      const columns = splitHtmlHeaderCells(block.raw);
      if (columns.length >= 3) {
        return buildSchema(index, columns, 'html-table');
      }
    }
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const table = semanticTableAt(index);
    if (!table) continue;
    const headingIndex = findTemplateHeadingBefore(blocks, index, normalizedTitle, -1);
    return buildSchema(index, table.columns, table.source, headingIndex, headingIndex >= 0 ? blocks[headingIndex] : null);
  }

  return {
    detected: false,
    title,
    source: 'fallback',
    columns: ['序号', '招标文件条目号', '招标文件要求', '投标文件应答', '响应与偏离', '偏离说明'],
  };
}
