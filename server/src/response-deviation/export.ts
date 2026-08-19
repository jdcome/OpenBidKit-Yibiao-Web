import {
  AlignmentType, BorderStyle, CommentRangeEnd, CommentRangeStart, CommentReference, Document, Packer, Paragraph, Table, TableCell, TableRow,
  TextRun, VerticalAlign, VerticalMergeType, WidthType, type ICommentsOptions, type ParagraphChild,
} from 'docx';
import { cleanFieldValue, unescapeMarkdownText, type ResponseDeviationTemplateSchema } from './metadata';

type LooseRow = Record<string, unknown>;
type LooseWorkspace = Record<string, unknown> & { rows?: LooseRow[] };

export interface ResponseDeviationExportIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  evidence?: string;
}

export interface ResponseDeviationExportValidation {
  status: 'ok' | 'warning' | 'error';
  issues: ResponseDeviationExportIssue[];
  columns: string[];
  summary: {
    columnsCount: number;
    autoFilledCount: number;
    retainedPrefix: boolean;
    retainedSuffix: boolean;
  };
}

const DEFAULT_COLUMNS = ['序号', '招标文件条目号', '招标文件要求', '投标文件应答', '响应与偏离', '偏离说明'];

type ResponseDeviationColumnRole = 'sequence' | 'clause' | 'requirement' | 'response' | 'deviation' | 'explanation' | 'notes';

const FIELD_LABELS: Record<string, string[]> = {
  procurementNumber: ['政府采购编号', '采购计划编号', '采购编号'],
  projectName: ['项目名称', '采购项目名称', '采购标的名称'],
  projectNumber: ['项目编号', '采购代理编号', '招标编号', '磋商编号'],
  packageNumber: ['包号', '包件号', '标段号'],
  packageName: ['包名称', '包件名称', '标段名称'],
};

const ALL_FIELD_LABELS = Object.values(FIELD_LABELS).flat().map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

function valueOf(field: unknown): string {
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object' && typeof (field as Record<string, unknown>).value === 'string') {
    return String((field as Record<string, unknown>).value);
  }
  return '';
}

function plainMarkdown(text: string): string {
  return unescapeMarkdownText(text
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim());
}

function plainPrefixText(text: string): string {
  return unescapeMarkdownText(text
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim());
}

function htmlAttr(attrs: string, name: string): number {
  const match = new RegExp(`${name}\\s*=\\s*["']?(\\d+)["']?`, 'i').exec(attrs);
  const parsed = Number.parseInt(match?.[1] || '', 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
}

function htmlTableCell(text: string, bold: boolean, colSpan = 1, rowSpan = 1, mergeContinue = false): TableCell {
  return new TableCell({
    columnSpan: colSpan > 1 ? colSpan : undefined,
    verticalMerge: mergeContinue ? VerticalMergeType.CONTINUE : rowSpan > 1 ? VerticalMergeType.RESTART : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold })] })],
  });
}

function parseHtmlTable(html: string): Table | null {
  const rowMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (!rowMatches.length) return null;
  const pendingRowSpans = new Map<number, number>();
  const rows = rowMatches.map((rowMatch, rowIndex) => {
    const cells: TableCell[] = [];
    let columnIndex = 0;
    const appendPending = () => {
      while ((pendingRowSpans.get(columnIndex) || 0) > 0) {
        const remaining = pendingRowSpans.get(columnIndex) || 0;
        cells.push(htmlTableCell('', rowIndex === 0, 1, 1, true));
        if (remaining <= 1) pendingRowSpans.delete(columnIndex);
        else pendingRowSpans.set(columnIndex, remaining - 1);
        columnIndex += 1;
      }
    };
    for (const cell of rowMatch[1].matchAll(/<(t[hd])([^>]*)>([\s\S]*?)<\/t[hd]>/gi)) {
      appendPending();
      const colSpan = htmlAttr(cell[2], 'colspan');
      const rowSpan = htmlAttr(cell[2], 'rowspan');
      cells.push(htmlTableCell(plainMarkdown(cell[3]), rowIndex === 0 || cell[1].toLowerCase() === 'th', colSpan, rowSpan));
      if (rowSpan > 1) {
        for (let offset = 0; offset < colSpan; offset += 1) pendingRowSpans.set(columnIndex + offset, rowSpan - 1);
      }
      columnIndex += colSpan;
    }
    appendPending();
    return new TableRow({
      tableHeader: rowIndex === 0,
      cantSplit: true,
      children: cells,
    });
  });
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

function requirementChildren(markdown: string): Array<Paragraph | Table> {
  const children: Array<Paragraph | Table> = [];
  let cursor = 0;
  for (const match of markdown.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const index = match.index || 0;
    const before = markdown.slice(cursor, index);
    for (const line of plainMarkdown(before).split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(line)], spacing: { after: 100 } }));
    }
    const table = parseHtmlTable(match[0]);
    if (table) children.push(table);
    cursor = index + match[0].length;
  }
  const rest = markdown.slice(cursor);
  for (const line of plainMarkdown(rest).split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(line)], spacing: { after: 100 } }));
  }
  return children.length ? children : [new Paragraph({ alignment: AlignmentType.CENTER })];
}

function cell(text: string, bold = false, width?: number): TableCell {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold })] })],
  });
}

function textParagraph(text: string, alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT): Paragraph {
  return new Paragraph({ alignment, spacing: { after: 80 }, children: [new TextRun({ text: plainMarkdown(text) })] });
}

function paragraphsFromMarkdown(markdown: string): Paragraph[] {
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => textParagraph(line));
}

class ExportCommentRegistry {
  private nextId = 0;
  private readonly comments: ICommentsOptions['children'] = [];

  add(text: string): number {
    const id = this.nextId;
    this.nextId += 1;
    this.comments.push({
      id,
      author: '金盾标书编制系统',
      initials: 'AI',
      date: new Date(),
      children: [new Paragraph({ children: [new TextRun({ text })] })],
    });
    return id;
  }

  toOptions(): ICommentsOptions | undefined {
    return this.comments.length ? { children: this.comments } : undefined;
  }
}

type ProjectFieldKey = keyof typeof FIELD_LABELS;

function fieldKeyForLabel(label: string): ProjectFieldKey | null {
  for (const [key, labels] of Object.entries(FIELD_LABELS) as Array<[ProjectFieldKey, string[]]>) {
    if (labels.includes(label)) return key;
  }
  return null;
}

function fieldComment(label: string, field: unknown): string | null {
  const value = cleanFieldValue(valueOf(field));
  const source = field && typeof field === 'object' ? String((field as Record<string, unknown>).source || '') : '';
  if (!value || source === 'empty') return `请人工补充/审核${label}。`;
  if (source === 'package') return `系统根据当前选择标段自动填充${label}，请人工审核。`;
  return null;
}

function commentedTextRun(text: string, comment: string | null, comments: ExportCommentRegistry): ParagraphChild[] {
  if (!text) return [];
  if (!comment) return [new TextRun({ text })];
  const id = comments.add(comment);
  return [
    new CommentRangeStart(id),
    new TextRun({ text }),
    new CommentRangeEnd(id),
    new CommentReference(id),
  ];
}

function prefixParagraph(line: string, fields: Record<string, unknown>, comments: ExportCommentRegistry): Paragraph {
  const text = plainPrefixText(line);
  const labelRe = new RegExp(`(${ALL_FIELD_LABELS})\\s*[：:]`, 'gu');
  const matches = [...text.matchAll(labelRe)];
  if (!matches.length) return textParagraph(text);

  const children: ParagraphChild[] = [];
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index || 0;
    const labelText = match[1];
    const fieldKey = fieldKeyForLabel(labelText);
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length;
    if (start > cursor) children.push(new TextRun({ text: text.slice(cursor, start) }));

    const segment = text.slice(start, end);
    const labelEnd = match[0].length;
    const labelPart = segment.slice(0, labelEnd);
    const slot = segment.slice(labelEnd);
    const field = fieldKey ? fields[fieldKey] : undefined;
    const value = cleanFieldValue(valueOf(field));
    const rendered = value && isPlaceholderSlot(slot) ? `${labelPart}${value}` : segment;
    children.push(...commentedTextRun(rendered, fieldKey ? fieldComment(labelText, field) : null, comments));
    cursor = end;
  }
  if (cursor < text.length) children.push(new TextRun({ text: text.slice(cursor) }));
  return new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 80 }, children });
}

function paragraphsFromPrefixMarkdown(markdown: string, fields: Record<string, unknown>, comments: ExportCommentRegistry): Paragraph[] {
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => prefixParagraph(line, fields, comments));
}

function schemaOf(workspace: LooseWorkspace): ResponseDeviationTemplateSchema {
  const raw = workspace.templateSchemaJson;
  const schema = raw && typeof raw === 'object' ? raw as Partial<ResponseDeviationTemplateSchema> : {};
  const columns = Array.isArray(schema.columns) ? schema.columns.map((item) => plainMarkdown(String(item))).filter(Boolean) : [];
  return {
    detected: schema.detected === true,
    title: String(schema.title || workspace.templateTitle || '技术响应与偏离表'),
    source: schema.source || 'fallback',
    columns: columns.length ? columns : DEFAULT_COLUMNS,
    prefixMarkdown: typeof schema.prefixMarkdown === 'string' ? schema.prefixMarkdown : '',
    suffixMarkdown: typeof schema.suffixMarkdown === 'string' ? schema.suffixMarkdown : '',
  };
}

function isPlaceholderSlot(value: string): boolean {
  const cleaned = unescapeMarkdownText(value)
    .replace(/[＿_—－\-–—]{2,}/g, '')
    .replace(/[()（）【】[\]{}]/g, '')
    .replace(/\s+/g, '')
    .trim();
  return cleaned.length === 0;
}

function replaceFieldPlaceholders(markdown: string, fields: Record<string, unknown>): { markdown: string; filledCount: number } {
  let filledCount = 0;
  let result = String(markdown || '');
  for (const [fieldKey, labels] of Object.entries(FIELD_LABELS)) {
    const value = cleanFieldValue(valueOf(fields[fieldKey]));
    if (!value) continue;
    const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const pattern = new RegExp(`(${labelPattern}\\s*[：:])([^\\n：:]*?)(?=\\s*(?:${ALL_FIELD_LABELS})\\s*[：:]|$)`, 'gu');
    result = result.replace(pattern, (full, label, slot) => {
      if (!isPlaceholderSlot(String(slot))) return full;
      filledCount += 1;
      return `${label}${value}`;
    });
  }
  return { markdown: result, filledCount };
}

function normalizedColumns(schema: ResponseDeviationTemplateSchema): string[] {
  const columns = schema.columns.map((item) => plainMarkdown(String(item))).filter(Boolean);
  return columns.length ? columns : DEFAULT_COLUMNS;
}

function columnRole(column: string): ResponseDeviationColumnRole {
  const text = plainMarkdown(column).replace(/\s+/g, '');
  if (/^(序号|编号)$/u.test(text) || /序号/u.test(text)) return 'sequence';
  if (/条目号|条款号|章节号|依据条款/u.test(text)) return 'clause';
  if (/偏离|偏差/u.test(text)) return 'deviation';
  if (/说明|备注/u.test(text)) return 'explanation';
  if (/响应文件|投标文件|参选文件|应答|响应内容|响应条款/u.test(text)) return 'response';
  if (/招标文件|磋商文件|比选文件|采购文件|采购规格|商务条款|技术要求|对应的?内容|要求|内容/u.test(text)) return 'requirement';
  return 'notes';
}

function roleWeight(role: ResponseDeviationColumnRole): number {
  if (role === 'sequence') return 6;
  if (role === 'clause') return 15;
  if (role === 'requirement') return 42;
  if (role === 'response') return 18;
  if (role === 'deviation') return 12;
  if (role === 'explanation') return 14;
  return 10;
}

function columnWidths(columns: string[]): number[] {
  const weights = columns.map((column) => roleWeight(columnRole(column)));
  const total = weights.reduce((sum, item) => sum + item, 0) || 1;
  return weights.map((item) => Math.max(5, Math.round((item / total) * 100)));
}

function rowValueForRole(row: LooseRow, role: ResponseDeviationColumnRole, index: number): string {
  if (role === 'sequence') return String(row.sequenceNo || index + 1);
  if (role === 'clause') return plainMarkdown(String(row.clauseNo || ''));
  if (role === 'response') return plainMarkdown(String(row.responseText || ''));
  if (role === 'deviation') return plainMarkdown(String(row.deviationStatus || ''));
  if (role === 'explanation') return plainMarkdown(String(row.deviationExplanation || ''));
  return plainMarkdown(String(row.notes || ''));
}

function tableCellForRole(row: LooseRow, role: ResponseDeviationColumnRole, width: number, index: number): TableCell {
  if (role !== 'requirement') return cell(rowValueForRole(row, role, index), false, width);
  return new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: requirementChildren(String(row.requirementMarkdown || '')),
  });
}

function dirtyText(value: string): string {
  return String(value || '');
}

function selectedPackageNumber(title: string): string {
  const match = String(title || '').match(/(?:第?\s*([一二三四五六七八九十百千万0-9]+)\s*(?:包|标段)|包件?\s*([一二三四五六七八九十百千万0-9]+))/u);
  const raw = String(match?.[1] || match?.[2] || '').trim();
  const map: Record<string, string> = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
  return map[raw] || raw;
}

export function validateResponseDeviationExport(workspace: LooseWorkspace): ResponseDeviationExportValidation {
  const issues: ResponseDeviationExportIssue[] = [];
  const schema = schemaOf(workspace);
  const columns = normalizedColumns(schema);
  const fields = (workspace.projectFieldsJson || {}) as Record<string, unknown>;
  const rows = workspace.rows || [];

  if (columns.length < 5) {
    issues.push({ level: 'error', code: 'template_columns_too_few', message: '模板表头列数不足，无法按原格式导出。' });
  }
  if (!columns.some((column) => /响应.*偏离|偏离.*响应|偏离情况/u.test(column))) {
    issues.push({ level: 'error', code: 'missing_deviation_column', message: '模板表头缺少“响应与偏离”语义列。' });
  }
  if (!schema.prefixMarkdown?.trim()) {
    issues.push({ level: 'warning', code: 'missing_template_prefix', message: '未识别到偏离表上方项目字段区，导出将不额外生成项目信息表。' });
  }
  if (!schema.suffixMarkdown?.trim()) {
    issues.push({ level: 'warning', code: 'missing_template_suffix', message: '未识别到偏离表下方说明/签章区，请导出后核对。' });
  }
  if (!cleanFieldValue(valueOf(fields.packageName))) {
    issues.push({ level: 'warning', code: 'package_name_empty', message: '包名称未明确识别，将按模板位置留空。' });
  }
  if (!cleanFieldValue(valueOf(fields.projectNumber))) {
    issues.push({ level: 'warning', code: 'project_number_empty', message: '项目编号未明确识别，将按模板位置留空。' });
  }

  const selectedNumber = selectedPackageNumber(String(workspace.selectedSectionTitle || ''));
  const packageNumber = cleanFieldValue(valueOf(fields.packageNumber));
  if (selectedNumber && packageNumber && selectedNumber !== packageNumber) {
    issues.push({ level: 'error', code: 'package_number_conflict', message: `当前标段为包${selectedNumber}，但项目字段包号为 ${packageNumber}。` });
  }

  const rawFieldText = Object.values(fields).map(valueOf).join('\n');
  if (/<\s*\/?\s*(?:table|tbody|thead|tr|td|th)\b|<\/td>/i.test(rawFieldText)) {
    issues.push({ level: 'error', code: 'dirty_markup', message: '项目字段存在 HTML 表格残留，请清理后再导出。', evidence: rawFieldText.match(/<\s*\/?\s*(?:table|tbody|thead|tr|td|th)\b|<\/td>/i)?.[0] });
  }

  const nonRequirementText = [
    schema.prefixMarkdown || '',
    schema.suffixMarkdown || '',
    ...columns,
    ...Object.values(fields).map((field) => cleanFieldValue(valueOf(field))),
    ...rows.flatMap((row) => [row.clauseNo, row.responseText, row.deviationStatus, row.deviationExplanation, row.notes].map((value) => String(value || ''))),
  ].map(dirtyText).join('\n');
  const dirtyMatch = nonRequirementText.match(/<\s*\/?\s*(?:table|tbody|thead|tr|td|th)\b|<\/td>|\*\*/i);
  if (dirtyMatch) {
    issues.push({ level: 'error', code: 'dirty_markup', message: '导出内容存在 Markdown/HTML 残留，请先清理后再导出。', evidence: dirtyMatch[0] });
  }

  rows.forEach((row, index) => {
    const clauseNo = plainMarkdown(String(row.clauseNo || ''));
    if (clauseNo.length > 80 || /合同签订|采购人付款|供应商应|我方承诺|付款至合同|全部内容/u.test(clauseNo)) {
      issues.push({ level: 'error', code: 'clause_no_contains_body', message: `第 ${index + 1} 行条目号过长，疑似混入招标正文。`, evidence: clauseNo.slice(0, 120) });
    }
    const requirementText = plainMarkdown(String(row.requirementMarkdown || row.requirementPlainText || row.requirementTitle || ''));
    if (!requirementText) {
      issues.push({ level: 'error', code: 'empty_requirement', message: `第 ${index + 1} 行招标文件要求为空。` });
    } else if (!plainMarkdown(String(row.requirementMarkdown || ''))) {
      issues.push({ level: 'warning', code: 'title_only_requirement', message: `第 ${index + 1} 行为标题行，请导出后核对是否需要保留。` });
    }
  });

  const filled = replaceFieldPlaceholders(schema.prefixMarkdown || '', fields);
  const hasError = issues.some((issue) => issue.level === 'error');
  const hasWarning = issues.some((issue) => issue.level === 'warning');
  return {
    status: hasError ? 'error' : hasWarning ? 'warning' : 'ok',
    issues,
    columns,
    summary: {
      columnsCount: columns.length,
      autoFilledCount: filled.filledCount,
      retainedPrefix: Boolean(schema.prefixMarkdown?.trim()),
      retainedSuffix: Boolean(schema.suffixMarkdown?.trim()),
    },
  };
}

function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '技术响应与偏离表';
}

export async function buildResponseDeviationDocx(workspace: LooseWorkspace): Promise<{ buffer: Buffer; filename: string }> {
  if (workspace.status !== 'confirmed') throw new Error('请先确认招标侧内容，再导出正式 Word');
  const fields = (workspace.projectFieldsJson || {}) as Record<string, unknown>;
  const projectName = valueOf(fields.projectName);
  const projectNumber = valueOf(fields.projectNumber);
  const title = String(workspace.templateTitle || '技术响应与偏离表');
  const schema = schemaOf(workspace);
  const validation = validateResponseDeviationExport(workspace);
  const errors = validation.issues.filter((issue) => issue.level === 'error');
  if (errors.length) throw new Error(`偏离表模板校验未通过：${errors.map((issue) => issue.message).join('；')}`);
  const columns = normalizedColumns(schema);
  const widths = columnWidths(columns);
  const renderedPrefix = replaceFieldPlaceholders(schema.prefixMarkdown || '', fields);
  const commentRegistry = new ExportCommentRegistry();

  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: columns.map((column, index) => cell(column, true, widths[index])),
  });
  const dataRows = (workspace.rows || []).map((row, index) => new TableRow({
    cantSplit: false,
    children: columns.map((column, columnIndex) => tableCellForRole(row, columnRole(column), widths[columnIndex], index)),
  }));

  const border = { style: BorderStyle.SINGLE, size: 4, color: 'B7C5D9' };
  const prefixParagraphs = paragraphsFromPrefixMarkdown(schema.prefixMarkdown || '', fields, commentRegistry);
  const comments = commentRegistry.toOptions();
  const document = new Document({
    ...(comments ? { comments } : {}),
    styles: { default: { document: { run: { font: '宋体', size: 21 }, paragraph: { spacing: { line: 360, after: 0 } } } } },
    sections: [{
      properties: { page: { margin: { top: 900, right: 700, bottom: 900, left: 700 } } },
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 260 }, children: [new TextRun({ text: title, bold: true, size: 32, font: '黑体' })] }),
        ...prefixParagraphs,
        ...(renderedPrefix.markdown.trim() ? [new Paragraph({ spacing: { after: 120 } })] : []),
        new Table({ rows: [header, ...dataRows], width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border } }),
        ...(schema.suffixMarkdown?.trim() ? [new Paragraph({ spacing: { after: 160 } }), ...paragraphsFromMarkdown(schema.suffixMarkdown)] : []),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(document);
  return { buffer, filename: `${safeFilename(projectName || projectNumber)}-${safeFilename(title)}.docx` };
}
