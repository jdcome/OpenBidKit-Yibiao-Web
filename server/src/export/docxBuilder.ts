// docx 构造层（忠实移植自 client/electron/services/exportService.cjs 256-2111）。
// 与桌面差异：
//  - developerLogger → no-op stub（enabled=false，writeExportLog 全静默）。
//  - executeRequiredOnlineService（ping 域名 gate）→ 直接调用，失败由 loadImageWithRetry 兜底降级。
//  - nativeImage webp 转码 → images.normalizeImageForDocx 抛错，上游降级占位。
//  - mermaid 缓存目录 → <dataDir>/shared/mermaid-cache/（mermaid.ts）。
import {
  AlignmentType,
  BorderStyle,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeightRule,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LevelSuffix,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlignTable,
  WidthType,
  type ICommentsOptions,
  type ParagraphChild,
} from 'docx';
import type { CheerioAPI } from 'cheerio';
import { renderMarkdownHtml } from './markdown';
import {
  loadImageWithRetry,
  normalizeImageForDocx,
  measureImage,
  describeImageSourceForLog,
  type LoadedImage,
} from './images';
import { getMermaidCacheEntry, saveMermaidCacheImage, mermaidInkUrl } from './mermaid';
import {
  chineseSizeToHalfPt,
  charsToTwips,
  cmToTwips,
  mmToTwips,
  alignmentToWordType,
  TABLE_CELL_VERTICAL_CENTER_ALIGN,
  normalizeDocxColor,
  cleanText,
  compactText,
  sanitizeFilename,
  PAPER_DIMENSIONS_MM,
  DOCX_TABLE_WIDTH_TWIPS,
  CHAPTER_LEAF_TITLE_WIDTH_TWIPS,
  CHAPTER_LEAF_CONTENT_WIDTH_TWIPS,
  MAX_IMAGE_WIDTH,
  MAX_IMAGE_HEIGHT_PERCENT,
  DEFAULT_HEADING_BORDER_CELL_COLORS,
  DEFAULT_TABLE_STYLE,
  DEFAULT_IMAGE_STYLE,
  UNORDERED_LIST_MARKERS,
  NUMBERING_REFERENCE_PREFIX,
  HEADING_NUMBERING_REFERENCE,
  type OutlineItemLike,
} from './format';

// ── developerLogger no-op（服务端不落 JSONL 调试日志）──────────────────────
interface DeveloperLogger {
  enabled: boolean;
  write: (_event: string, _payload?: Record<string, unknown>) => void;
}
const NOOP_LOGGER: DeveloperLogger = { enabled: false, write: () => {} };

function textMetrics(contents: string): Record<string, number> {
  const text = String(contents || '');
  const characters = text.replace(/\s+/g, '').length;
  return { characters };
}

// ── build context（一次导出全过程的共享状态）──────────────────────────────
interface NumberingReferenceConfig {
  reference: string;
  ordered: boolean;
  unorderedListStyle: string;
  orderedListStyle: string;
  listIndentChars: number;
  bodyRunFont: string;
  bodyRunSize: number;
}

interface ExportContext {
  baseDir?: string;
  onProgress?: (p: BuildProgress) => void;
  warnings: string[];
  stats: { leafCount: number; mermaidCount: number };
  convertedLeafCount: number;
  convertedMermaidCount: number;
  imageCount: number;
  imageSuccessCount: number;
  numberingReferences: NumberingReferenceConfig[];
  numberingIndex: number;
  usesHeadingNumbering: boolean;
  unsupportedHtmlTags: Set<string>;
  developerLogger: DeveloperLogger;
  exportFormat: Record<string, unknown> | null;
  subjectReplacementCommentTerms: string[];
  comments: ExportCommentRegistry;
  // 正文样式注入（buildDocxResult 计算）
  bodyRunFont?: string;
  bodyRunSize?: number;
  bodyLineSpacing?: number;
  bodyAfterSpacing?: number;
  bodyListStyle?: string;
  bodyOrderedListStyle?: string;
  bodyListIndentChars?: number;
  bodyAlignment?: AlignmentType;
  bodyIndent?: Record<string, number>;
  bodyBeforeSpacing?: number;
}

interface BuildProgress {
  phase: string;
  progress: number;
  message: string;
  warnings: string[];
}

interface BuildResult {
  buffer: Buffer;
  warnings: string[];
  stats: { leafCount: number; mermaidCount: number };
}

const SUBJECT_REPLACEMENT_REVIEW_COMMENT = '请核对代称替换是否正确';

interface ExportFormatLike {
  page?: Record<string, unknown> | null;
  body_text?: Record<string, unknown> | null;
  headings?: Record<string, unknown>[] | null;
  table?: Record<string, unknown> | null;
  image?: Record<string, unknown> | null;
  heading_border?: Record<string, unknown> | null;
  heading_level1_page_break_before?: boolean;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(Math.round(Number(value) || 0), 100));
}

function reportProgress(context: ExportContext, progress: number, message: string, extra: Record<string, unknown> = {}): void {
  if (!context?.onProgress) return;
  try {
    context.onProgress({
      phase: (extra.phase as string) || 'running',
      progress: clampPercent(progress),
      message,
      warnings: [...(context.warnings || [])],
      ...extra,
    });
  } catch {
    /* ignore progress callback failure */
  }
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

function reportConversionProgress(context: ExportContext, message: string): void {
  const stats = context?.stats || { leafCount: 0, mermaidCount: 0 };
  const total = Math.max(1, (stats.leafCount || 0) + (stats.mermaidCount || 0));
  const done = Math.min(total, (context.convertedLeafCount || 0) + (context.convertedMermaidCount || 0));
  reportProgress(context, 10 + (done / total) * 78, message);
}

function writeExportLog(context: ExportContext, event: string, payload: Record<string, unknown> = {}): void {
  context?.developerLogger?.write(event, payload);
}

function addWarning(context: ExportContext, message: string): void {
  context.warnings.push(message);
  writeExportLog(context, 'export.warning', { message });
  console.warn(`[export-word] ${message}`);
}

function addUnsupportedHtmlWarning(context: ExportContext, tagName: string): void {
  const tag = String(tagName || '').toLowerCase();
  if (!tag) return;
  if (context.unsupportedHtmlTags.has(tag)) return;
  context.unsupportedHtmlTags.add(tag);
  addWarning(context, `HTML 标签 <${tag}> 导出时已降级，请核对 Word 内容。`);
}

// ── outline 统计 ────────────────────────────────────────────────────────────
function countMermaidBlocks(content: string): number {
  return (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
}

function countOutlineStats(items: OutlineItemLike[] = []): { leafCount: number; mermaidCount: number } {
  let leafCount = 0;
  let mermaidCount = 0;
  for (const item of items || []) {
    if (item.children?.length) {
      const childStats = countOutlineStats(item.children);
      leafCount += childStats.leafCount;
      mermaidCount += childStats.mermaidCount;
    } else {
      leafCount += 1;
      mermaidCount += countMermaidBlocks(String(item.content || ''));
    }
  }
  return { leafCount, mermaidCount };
}

function collectOutlineContents(items: OutlineItemLike[] = []): string[] {
  const contents: string[] = [];
  for (const item of items || []) {
    if (item.children?.length) {
      contents.push(...collectOutlineContents(item.children));
    } else {
      contents.push(String(item.content || ''));
    }
  }
  return contents;
}

function countOutlineContentMetrics(items: OutlineItemLike[] = []): Record<string, number> {
  const contents = collectOutlineContents(items);
  return {
    ...textMetrics(contents.join('\n\n')),
    leaf_content_count: contents.filter((c) => c.trim()).length,
  };
}

// ── ordered list → docx LevelFormat 映射 ────────────────────────────────────
const ORDERED_LIST_WORD_STYLES: Record<string, { format: (typeof LevelFormat)[keyof typeof LevelFormat]; text: (level: number) => string }> = {
  'decimal-dot': { format: LevelFormat.DECIMAL, text: (level) => `%${level + 1}.` },
  'decimal-paren': { format: LevelFormat.DECIMAL, text: (level) => `%${level + 1}）` },
  'decimal-full-paren': { format: LevelFormat.DECIMAL, text: (level) => `（%${level + 1}）` },
  'chinese-dot': { format: LevelFormat.CHINESE_COUNTING, text: (level) => `%${level + 1}、` },
  'chinese-paren': { format: LevelFormat.CHINESE_COUNTING, text: (level) => `（%${level + 1}）` },
  'lower-alpha': { format: LevelFormat.LOWER_LETTER, text: (level) => `%${level + 1}.` },
  'upper-alpha': { format: LevelFormat.UPPER_LETTER, text: (level) => `%${level + 1}.` },
  'lower-roman': { format: LevelFormat.LOWER_ROMAN, text: (level) => `%${level + 1}.` },
  'upper-roman': { format: LevelFormat.UPPER_ROMAN, text: (level) => `%${level + 1}.` },
};

function getOrderedListWordStyle(style: string): (typeof ORDERED_LIST_WORD_STYLES)[string] {
  return ORDERED_LIST_WORD_STYLES[style] || ORDERED_LIST_WORD_STYLES['decimal-dot'];
}

// ── 文本 run / 段落构造 ─────────────────────────────────────────────────────
interface RunOptions {
  font?: string;
  size?: number;
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  color?: string;
  underline?: boolean;
}

interface ParagraphOptions {
  heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel];
  pageBreakBefore?: boolean;
  alignment?: AlignmentType;
  bullet?: { level: number };
  numbering?: { reference: string; level: number };
  before?: number;
  after?: number;
  line?: number;
  indent?: Record<string, number>;
  border?: Record<string, unknown>;
  shading?: { type: (typeof ShadingType)[keyof typeof ShadingType]; fill: string };
}

function textRun(text: unknown, options: RunOptions = {}): TextRun {
  return new TextRun({
    text: cleanText(text),
    font: options.font || '宋体',
    size: options.size || 24,
    bold: options.bold,
    italics: options.italics,
    strike: options.strike,
    color: options.color,
    underline: options.underline ? { type: UnderlineType.SINGLE } : undefined,
  });
}

function lineBreakRun(): TextRun {
  return new TextRun({ break: 1 });
}

function textRunsWithBreaks(value: unknown, options: RunOptions = {}): ParagraphChild[] {
  const parts = String(value || '').split(/<br\s*\/?\s*>/gi);
  const runs: ParagraphChild[] = [];
  parts.forEach((part, index) => {
    if (index > 0) runs.push(lineBreakRun());
    if (part) runs.push(textRun(part, options));
  });
  return runs;
}

function paragraph(children: ParagraphChild[] | undefined, options: ParagraphOptions = {}): Paragraph {
  return new Paragraph({
    children: children?.length ? children : [textRun('')],
    heading: options.heading,
    pageBreakBefore: options.pageBreakBefore,
    alignment: options.alignment,
    bullet: options.bullet,
    numbering: options.numbering,
    spacing: { before: options.before || 0, after: options.after ?? 160, line: options.line || 360 },
    indent: options.indent as never,
    border: options.border as never,
    shading: options.shading as never,
  });
}

function normalizeCommentTerms(terms: unknown): string[] {
  if (!Array.isArray(terms)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of terms) {
    const term = cleanText(String(item || '')).trim();
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result.sort((a, b) => b.length - a.length);
}

function collectCommentRanges(text: string, terms: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  if (!text || !terms.length) return ranges;
  for (const term of terms) {
    let index = text.indexOf(term);
    while (index >= 0) {
      const range = { start: index, end: index + term.length };
      const conflict = ranges.some((item) => range.start < item.end && item.start < range.end);
      if (!conflict) ranges.push(range);
      index = text.indexOf(term, index + Math.max(1, term.length));
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function textRunsWithSubjectReplacementComments(value: unknown, options: RunOptions, context: ExportContext): ParagraphChild[] {
  const text = String(value || '');
  const ranges = collectCommentRanges(text, context.subjectReplacementCommentTerms);
  if (!ranges.length) return textRunsWithBreaks(text, options);

  const runs: ParagraphChild[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) runs.push(...textRunsWithBreaks(text.slice(cursor, range.start), options));
    const markedText = text.slice(range.start, range.end);
    const id = context.comments.add(SUBJECT_REPLACEMENT_REVIEW_COMMENT);
    runs.push(new CommentRangeStart(id));
    runs.push(...textRunsWithBreaks(markedText, options));
    runs.push(new CommentRangeEnd(id));
    runs.push(new CommentReference(id));
    cursor = range.end;
  }
  if (cursor < text.length) runs.push(...textRunsWithBreaks(text.slice(cursor), options));
  return runs;
}

function pageBreakParagraph(): Paragraph {
  return paragraph([new PageBreak()], { after: 0, line: 0 });
}

// ── 页面/章节边框配置 ───────────────────────────────────────────────────────
function isLevel1PageBreakEnabled(exportFormat: ExportFormatLike | null): boolean {
  return exportFormat?.heading_level1_page_break_before === true;
}

function isFooterEnabled(pageSetup: Record<string, unknown> | null | undefined): boolean {
  return pageSetup ? pageSetup.footer_enabled !== false : true;
}

function isPageNumberEnabled(pageSetup: Record<string, unknown> | null | undefined): boolean {
  return pageSetup ? pageSetup.page_number_enabled !== false : true;
}

function getChapterFrameConfig(exportFormat: ExportFormatLike | null) {
  const frame = exportFormat?.heading_border;
  if (!frame || frame.enabled !== true) return null;
  const color = normalizeDocxColor(frame.border_color as string | undefined || '#2174fd', '2174FD');
  const levelCellColors = Array.isArray(frame.level_cell_colors) ? (frame.level_cell_colors as string[]) : [];
  return {
    color,
    minHeadingLeftEnabled: frame.min_heading_left_enabled === true,
    fills: DEFAULT_HEADING_BORDER_CELL_COLORS.map((fill, index) => {
      const fallback = normalizeDocxColor(fill, 'FFFFFF');
      return normalizeDocxColor(levelCellColors[index] || fill, fallback);
    }),
  };
}

function chapterHeadingRowStyle(level: number) {
  const horizontal = 0;
  const table = [
    { height: 520, top: 120, bottom: 120, left: horizontal, right: horizontal },
    { height: 430, top: 100, bottom: 100, left: horizontal, right: horizontal },
    { height: 360, top: 80, bottom: 80, left: horizontal, right: horizontal },
    { height: 320, top: 70, bottom: 70, left: horizontal, right: horizontal },
    { height: 290, top: 60, bottom: 60, left: horizontal, right: horizontal },
    { height: 270, top: 55, bottom: 55, left: horizontal, right: horizontal },
  ];
  return table[Math.max(0, Math.min(level - 1, table.length - 1))];
}

function buildChapterHeadingRow(exportFormat: ExportFormatLike | null, headingParagraph: Paragraph, level: number): TableRow | undefined {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const rowStyle = chapterHeadingRowStyle(level);
  const columnSpan = frame.minHeadingLeftEnabled ? 2 : undefined;
  return new TableRow({
    cantSplit: true,
    height: { value: rowStyle.height, rule: HeightRule.ATLEAST },
    children: [new TableCell({
      children: [headingParagraph],
      shading: { type: ShadingType.CLEAR, fill: frame.fills[Math.max(0, Math.min(level - 1, 5))] || 'FFFFFF' },
      margins: { top: rowStyle.top, bottom: rowStyle.bottom, left: rowStyle.left, right: rowStyle.right },
      columnSpan,
      width: { size: DOCX_TABLE_WIDTH_TWIPS, type: WidthType.DXA },
      borders: { top: border, left: border, right: border, bottom: border },
    })],
  });
}

function buildChapterContentRow(exportFormat: ExportFormatLike | null, bodyChildren: Paragraph[]): TableRow | undefined {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const body = bodyChildren?.length ? bodyChildren : [paragraph([textRun('')], { after: 0 })];
  const columnSpan = frame.minHeadingLeftEnabled ? 2 : undefined;
  return new TableRow({
    children: [new TableCell({
      children: body,
      margins: { top: 200, bottom: 220, left: 260, right: 260 },
      columnSpan,
      width: { size: DOCX_TABLE_WIDTH_TWIPS, type: WidthType.DXA },
      borders: { top: { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' }, left: border, right: border, bottom: border },
    })],
  });
}

function buildChapterLeafRow(exportFormat: ExportFormatLike | null, titleParagraph: Paragraph, bodyChildren: Paragraph[], level: number): TableRow | undefined {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const body = bodyChildren?.length ? bodyChildren : [paragraph([textRun('')], { after: 0 })];
  const fill = frame.fills[Math.max(0, Math.min(level - 1, 5))] || 'FFFFFF';
  return new TableRow({
    children: [
      new TableCell({
        children: [titleParagraph],
        shading: { type: ShadingType.CLEAR, fill },
        margins: { top: 160, bottom: 160, left: 160, right: 160 },
        verticalAlign: VerticalAlignTable.CENTER,
        width: { size: CHAPTER_LEAF_TITLE_WIDTH_TWIPS, type: WidthType.DXA },
        borders: { top: border, left: border, right: border, bottom: border },
      }),
      new TableCell({
        children: body,
        margins: { top: 200, bottom: 220, left: 260, right: 260 },
        width: { size: CHAPTER_LEAF_CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
        borders: { top: border, left: border, right: border, bottom: border },
      }),
    ],
  });
}

function buildChapterFrameTable(exportFormat: ExportFormatLike | null, rows: TableRow[]): Table | undefined {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: frame.minHeadingLeftEnabled ? [CHAPTER_LEAF_TITLE_WIDTH_TWIPS, CHAPTER_LEAF_CONTENT_WIDTH_TWIPS] : [DOCX_TABLE_WIDTH_TWIPS],
    layout: TableLayoutType.FIXED,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: none },
  });
}

// ── 页眉 / 页脚 / 页码 ──────────────────────────────────────────────────────
function createPageNumberRuns(format: string, runOptions: RunOptions): TextRun[] {
  const parts = String(format || '第{page}页').split('{page}');
  const runs: TextRun[] = [];
  if (parts[0]) runs.push(new TextRun({ ...runOptions, text: cleanText(parts[0]) } as never));
  runs.push(new TextRun({ ...runOptions, children: [PageNumber.CURRENT] } as never));
  if (parts[1]) runs.push(new TextRun({ ...runOptions, text: cleanText(parts[1]) } as never));
  return runs;
}

function buildWordHeaders(pageSetup: Record<string, unknown> | null | undefined): { default: Header } | undefined {
  const enabled = pageSetup ? pageSetup.header_enabled === true : false;
  const headerText = cleanText((pageSetup?.header_text as string) || '').trim();
  if (!enabled || !headerText) return undefined;
  const runOptions: RunOptions = {
    font: (pageSetup?.header_font as string) || '宋体',
    size: chineseSizeToHalfPt((pageSetup?.header_size as string) || '小五'),
    color: normalizeDocxColor((pageSetup?.header_color as string) || '#536176'),
  };
  return {
    default: new Header({
      children: [new Paragraph({
        alignment: alignmentToWordType((pageSetup?.header_alignment as string) || '居中对齐'),
        children: [new TextRun({ ...runOptions, text: headerText } as never)],
      })],
    }),
  };
}

function buildWordFooters(pageSetup: Record<string, unknown> | null | undefined): { default: Footer } | undefined {
  const footerEnabled = isFooterEnabled(pageSetup);
  const footerText = footerEnabled ? cleanText((pageSetup?.footer_text as string) || '').trim() : '';
  const pageNumberEnabled = isPageNumberEnabled(pageSetup);
  if (!footerText && !pageNumberEnabled) return undefined;
  const runOptions: RunOptions = {
    font: (pageSetup?.footer_font as string) || '宋体',
    size: chineseSizeToHalfPt((pageSetup?.footer_size as string) || '小五'),
    color: normalizeDocxColor((pageSetup?.footer_color as string) || '#536176'),
  };
  const footerChildren: TextRun[] = [];
  if (footerText) footerChildren.push(new TextRun({ ...runOptions, text: footerText } as never));
  if (footerText && pageNumberEnabled) footerChildren.push(new TextRun({ ...runOptions, text: '    ' } as never));
  if (pageNumberEnabled) footerChildren.push(...createPageNumberRuns((pageSetup?.page_number_format as string) || '第{page}页', runOptions));
  return {
    default: new Footer({
      children: [new Paragraph({
        alignment: alignmentToWordType(footerEnabled ? ((pageSetup?.footer_alignment as string) || '居中对齐') : '居中对齐'),
        children: footerChildren,
      })],
    }),
  };
}

// ── 表格样式 ────────────────────────────────────────────────────────────────
function getTableStyle(context: ExportContext): typeof DEFAULT_TABLE_STYLE {
  return (context?.exportFormat?.table as typeof DEFAULT_TABLE_STYLE) || DEFAULT_TABLE_STYLE;
}

function getTableCellStyle(context: ExportContext, { isHeader = false, isFirstColumn = false } = {}): Record<string, unknown> {
  const table = getTableStyle(context);
  if (isHeader) return table.header_row as never;
  if (isFirstColumn) return table.first_column as never;
  return table.body_cell as never;
}

function tableBorderSize(context: ExportContext): number {
  const width = Number(getTableStyle(context).border_width) || 0;
  if (width <= 0) return 0;
  return Math.max(1, Math.round(width * 6));
}

function tableBorders(context: ExportContext): Record<string, { style: BorderStyle; size: number; color: string }> {
  const size = tableBorderSize(context);
  const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };
  if (size <= 0) {
    return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  }
  const border = { style: BorderStyle.SINGLE, size, color: normalizeDocxColor(getTableStyle(context).border_color, 'DCDFF6') };
  return { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
}

function tableCellMargins(context: ExportContext): Record<string, number> {
  const padding = Math.max(0, Number(getTableStyle(context).cell_padding_pt) || 0);
  const twips = Math.round(padding * 20);
  return { top: twips, bottom: twips, left: twips, right: twips };
}

function tableCellRunMarks(style: Record<string, unknown>): RunOptions {
  return {
    font: (style?.font as string) || DEFAULT_TABLE_STYLE.body_cell.font,
    size: chineseSizeToHalfPt((style?.size as string) || DEFAULT_TABLE_STYLE.body_cell.size),
    color: normalizeDocxColor((style?.text_color as string) || DEFAULT_TABLE_STYLE.body_cell.text_color, '243048'),
  };
}

function tableCellParagraphOptions(style: Record<string, unknown>): { after: number; alignment: AlignmentType } {
  return { after: 80, alignment: alignmentToWordType((style?.alignment as string) || DEFAULT_TABLE_STYLE.body_cell.alignment) };
}

function tableColumnWidths(columnCount: number): number[] {
  const safeCount = Math.max(1, columnCount || 1);
  const base = Math.floor(DOCX_TABLE_WIDTH_TWIPS / safeCount);
  const widths = Array.from({ length: safeCount }, () => base);
  widths[widths.length - 1] += DOCX_TABLE_WIDTH_TWIPS - base * safeCount;
  return widths;
}

function tableCellWidth(columnSpan: number, totalColumns: number): number {
  const safeTotal = Math.max(1, totalColumns || 1);
  const safeSpan = Math.max(1, columnSpan || 1);
  return Math.round((DOCX_TABLE_WIDTH_TWIPS * safeSpan) / safeTotal);
}

function createTableCell(opts: { children: Paragraph[]; context: ExportContext; isHeader?: boolean; isFirstColumn?: boolean; columnSpan?: number; totalColumns?: number }): TableCell {
  const safeSpan = Math.max(1, opts.columnSpan || 1);
  const table = getTableStyle(opts.context);
  const cellStyle = getTableCellStyle(opts.context, { isHeader: opts.isHeader, isFirstColumn: opts.isFirstColumn });
  const fullWidth = table.full_width !== false;
  const verticalAlign = (cellStyle?.alignment as string) === TABLE_CELL_VERTICAL_CENTER_ALIGN
    ? VerticalAlignTable.CENTER
    : undefined;
  return new TableCell({
    children: opts.children,
    shading: { type: ShadingType.CLEAR, fill: normalizeDocxColor(cellStyle?.background_color as string | undefined, 'FFFFFF') },
    margins: tableCellMargins(opts.context),
    columnSpan: safeSpan > 1 ? safeSpan : undefined,
    width: fullWidth ? { size: tableCellWidth(safeSpan, opts.totalColumns || 1), type: WidthType.DXA } : undefined,
    verticalAlign,
  });
}

function createDocxTable(rows: TableRow[], columnCount: number, context: ExportContext): Table {
  const table = getTableStyle(context);
  const fullWidth = table.full_width !== false;
  const options: ConstructorParameters<typeof Table>[0] = {
    rows,
    width: fullWidth ? { size: 100, type: WidthType.PERCENTAGE } : { size: 0, type: WidthType.AUTO },
    layout: fullWidth ? TableLayoutType.FIXED : TableLayoutType.AUTOFIT,
    borders: tableBorders(context) as never,
  };
  if (fullWidth) options.columnWidths = tableColumnWidths(columnCount);
  return new Table(options);
}

// ── 图片尺寸 / 样式 ─────────────────────────────────────────────────────────
function getImageStyle(context: ExportContext): typeof DEFAULT_IMAGE_STYLE {
  return (context?.exportFormat?.image as typeof DEFAULT_IMAGE_STYLE) || DEFAULT_IMAGE_STYLE;
}

function getPageSetup(context: ExportContext): Record<string, unknown> | null {
  return (context?.exportFormat?.page as Record<string, unknown>) || null;
}

function getPageContentWidthPx(context: ExportContext): number {
  const pageSetup = getPageSetup(context) || {};
  const dims = PAPER_DIMENSIONS_MM[(pageSetup.paper_size as string) || 'a4'] || PAPER_DIMENSIONS_MM.a4;
  const pageWidthMm = pageSetup.orientation === 'landscape' ? dims.height : dims.width;
  const pageWidthTwips = mmToTwips(pageWidthMm);
  const marginLeftTwips = cmToTwips((pageSetup.margin_left_cm as number) ?? 2);
  const marginRightTwips = cmToTwips((pageSetup.margin_right_cm as number) ?? 2);
  const contentWidthTwips = Math.max(1, pageWidthTwips - marginLeftTwips - marginRightTwips);
  return Math.round(contentWidthTwips / 15);
}

function getPageContentHeightPx(context: ExportContext): number {
  const pageSetup = getPageSetup(context) || {};
  const dims = PAPER_DIMENSIONS_MM[(pageSetup.paper_size as string) || 'a4'] || PAPER_DIMENSIONS_MM.a4;
  const pageHeightMm = pageSetup.orientation === 'landscape' ? dims.width : dims.height;
  const pageHeightTwips = mmToTwips(pageHeightMm);
  const marginTopTwips = cmToTwips((pageSetup.margin_top_cm as number) ?? 2);
  const marginBottomTwips = cmToTwips((pageSetup.margin_bottom_cm as number) ?? 2);
  const contentHeightTwips = Math.max(1, pageHeightTwips - marginTopTwips - marginBottomTwips);
  return Math.round(contentHeightTwips / 15);
}

function getImageMaxWidth(context: ExportContext): number {
  const image = getImageStyle(context);
  const percent = Math.max(1, Math.min(100, Number(image.max_width_percent) || DEFAULT_IMAGE_STYLE.max_width_percent));
  return Math.max(1, Math.round(getPageContentWidthPx(context) * percent / 100));
}

function getImageMaxHeight(context: ExportContext): number {
  return Math.max(1, Math.round(getPageContentHeightPx(context) * MAX_IMAGE_HEIGHT_PERCENT / 100));
}

function getImageParagraphOptions(context: ExportContext): ParagraphOptions {
  const image = getImageStyle(context);
  return { alignment: alignmentToWordType(image.alignment || DEFAULT_IMAGE_STYLE.alignment) };
}

function getCaptionRunMarks(context: ExportContext): RunOptions {
  const image = getImageStyle(context);
  const marks: RunOptions = {
    font: image.caption_font || DEFAULT_IMAGE_STYLE.caption_font,
    size: chineseSizeToHalfPt(image.caption_size || DEFAULT_IMAGE_STYLE.caption_size),
  };
  if (image.caption_bold === true) marks.bold = true;
  if (image.caption_italic === true) marks.italics = true;
  return marks;
}

function getCaptionParagraphOptions(context: ExportContext): ParagraphOptions {
  return {
    alignment: alignmentToWordType(getImageStyle(context).caption_alignment || DEFAULT_IMAGE_STYLE.caption_alignment),
    after: context?.bodyAfterSpacing ?? 160,
    line: context?.bodyLineSpacing,
    indent: { left: 0, right: 0, firstLine: 0, hanging: 0 },
  };
}

// ── GFM 表格修正（模型常把分隔行/数据行压一行）────────────────────────────
function normalizeColumnSpan(value: unknown): number {
  const span = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(span) && span > 1 ? span : 1;
}

function isMarkdownTableRowLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(String(line || ''));
}

function isMarkdownTableDelimiterLine(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ''));
}

function splitMarkdownTableCells(line: string): string[] {
  let source = String(line || '').trim();
  if (!source.includes('|')) return [];
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|')) source = source.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of source) {
    if (char === '|' && !escaped) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
    escaped = char === '\\' && !escaped;
  }
  cells.push(current.trim());
  return cells;
}

function isMarkdownTableDelimiterCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(String(cell || '').trim());
}

function markdownTableRowIndent(line: string): string {
  const match = /^(\s*)\|/.exec(String(line || ''));
  return match ? match[1] : '';
}

function formatMarkdownTableRow(cells: string[], indent = ''): string {
  return `${indent}| ${cells.map((cell) => String(cell || '').trim()).join(' | ')} |`;
}

function expandCompressedMarkdownTableRows(headerLine: string, nextLine: string): string[] | null {
  if (!isMarkdownTableRowLine(headerLine) || !isMarkdownTableRowLine(nextLine)) return null;
  const headerCells = splitMarkdownTableCells(headerLine);
  const nextCells = splitMarkdownTableCells(nextLine);
  const columnCount = headerCells.length;
  if (columnCount < 2 || nextCells.length <= columnCount) return null;
  const delimiterCells = nextCells.slice(0, columnCount);
  if (!delimiterCells.every(isMarkdownTableDelimiterCell)) return null;
  const indent = markdownTableRowIndent(headerLine);
  const lines = [formatMarkdownTableRow(headerCells, indent), formatMarkdownTableRow(delimiterCells, indent)];
  const remainingCells = nextCells.slice(columnCount);
  while (remainingCells.length) {
    if (remainingCells.length > columnCount && !remainingCells[0] && remainingCells.length % columnCount !== 0) {
      remainingCells.shift();
      continue;
    }
    const rowCells = remainingCells.splice(0, columnCount);
    if (rowCells.some((cell) => String(cell || '').trim())) lines.push(formatMarkdownTableRow(rowCells, indent));
  }
  return lines;
}

function expandInlineMarkdownTableRows(line: string): string[] {
  const source = String(line || '');
  if (!/\|\s*:?-{3,}:?\s*\|/.test(source)) return [source];
  const firstPipeIndex = source.indexOf('|');
  if (firstPipeIndex < 0) return [source];
  const prefix = source.slice(0, firstPipeIndex);
  const isIndentedTableLine = /^\s*$/.test(prefix);
  const tableText = source.slice(firstPipeIndex).trim();
  const tableRows = tableText.replace(/\|\s+\|/g, '|\n|').split('\n').map((row) => row.trim()).filter(Boolean);
  if (isIndentedTableLine) return tableRows.map((row) => `${prefix}${row}`);
  return [prefix.trimEnd(), ...tableRows];
}

function normalizeMarkdownTablesForDocx(content: string): string {
  const expandedLines = String(content || '').replace(/\r\n?/g, '\n').split('\n').flatMap(expandInlineMarkdownTableRows);
  const lines: string[] = [];
  for (let index = 0; index < expandedLines.length; index += 1) {
    const line = expandedLines[index];
    const nextLine = expandedLines[index + 1] || '';
    const compressedTableRows = expandCompressedMarkdownTableRows(line, nextLine);
    const startsCompressedTable = Boolean(compressedTableRows);
    const startsTable = isMarkdownTableRowLine(line) && isMarkdownTableDelimiterLine(nextLine);
    const previousLine = lines[lines.length - 1] || '';
    if ((startsTable || startsCompressedTable) && previousLine.trim() && !isMarkdownTableRowLine(previousLine)) lines.push('');
    if (compressedTableRows) {
      lines.push(...compressedTableRows);
      index += 1;
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function normalizeMarkdownListMarkersForDocx(content: string): string {
  return String(content || '').split('\n').map((line) => {
    const match = line.match(/^(\s*)[•●○◦▪▫■□◆◇‣➢➤✓✔✧–－]\s+(.*)$/u);
    if (!match) return line;
    return `${match[1]}- ${match[2]}`;
  }).join('\n');
}

// ── 列表 numbering 引用 ─────────────────────────────────────────────────────
function createListReference(context: ExportContext, ordered: boolean): string | null {
  const bodyStyle = (context.exportFormat?.body_text as Record<string, unknown>) || {};
  if (!ordered && bodyStyle.list_style === 'none') return null;
  context.numberingIndex = (context.numberingIndex || 0) + 1;
  const reference = `${NUMBERING_REFERENCE_PREFIX}-${context.numberingIndex}`;
  context.numberingReferences.push({
    reference,
    ordered,
    unorderedListStyle: (bodyStyle.list_style as string) || 'disc',
    orderedListStyle: (bodyStyle.ordered_list_style as string) || 'decimal-dot',
    listIndentChars: typeof bodyStyle.list_indent_chars === 'number' ? bodyStyle.list_indent_chars : 2,
    bodyRunFont: context.bodyRunFont || '宋体',
    bodyRunSize: context.bodyRunSize || 24,
  });
  return reference;
}

function createOrderedListReference(context: ExportContext): string | null {
  return createListReference(context, true);
}

function createUnorderedListReference(context: ExportContext): string | null {
  return createListReference(context, false);
}

// ── 标题样式 ────────────────────────────────────────────────────────────────
function headingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  if (level === 4) return HeadingLevel.HEADING_4;
  if (level === 5) return HeadingLevel.HEADING_5;
  return HeadingLevel.HEADING_6;
}

function getHeadingStyle(exportFormat: ExportFormatLike | null, level: number): Record<string, unknown> | null {
  const headings = exportFormat && Array.isArray(exportFormat.headings) ? exportFormat.headings : [];
  const idx = Math.min(level - 1, 5);
  return headings[idx] || null;
}

function levelUsesNativeNumbering(exportFormat: ExportFormatLike | null, level: number): boolean {
  const style = getHeadingStyle(exportFormat, level);
  return (style?.numbering_format as string | undefined) === 'native';
}

// ── 编号格式化（中文/圈号/字母/罗马）────────────────────────────────────────
function numberToChinese(num: number): string {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const tens = ['', '十', '二十', '三十', '四十', '五十', '六十', '七十', '八十', '九十'];
  const n = Math.max(1, Math.min(9999, Math.floor(Number(num) || 1)));
  if (n <= 9) return digits[n];
  if (n <= 19) return `十${n === 10 ? '' : digits[n - 10]}`;
  if (n <= 99) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return `${tens[t]}${o ? digits[o] : ''}`;
  }
  if (n <= 999) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return `${digits[h]}百${r === 0 ? '' : r <= 9 ? `零${digits[r]}` : r <= 19 ? `一${numberToChinese(r)}` : numberToChinese(r)}`;
  }
  const th = Math.floor(n / 1000);
  const r = n % 1000;
  return `${digits[th]}千${r === 0 ? '' : r < 100 ? `零${numberToChinese(r)}` : numberToChinese(r)}`;
}

function numberToCircled(num: number): string {
  const circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
  return circled[num - 1] || String(num);
}

function numberToAlpha(num: number, upper = false): string {
  let n = Math.max(1, Math.floor(Number(num) || 1));
  let value = '';
  while (n > 0) {
    n -= 1;
    value = String.fromCharCode(97 + (n % 26)) + value;
    n = Math.floor(n / 26);
  }
  return upper ? value.toUpperCase() : value;
}

function numberToRoman(num: number, upper = false): string {
  let n = Math.max(1, Math.min(3999, Math.floor(Number(num) || 1)));
  const pairs: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let value = '';
  pairs.forEach(([amount, symbol]) => {
    while (n >= amount) {
      value += symbol;
      n -= amount;
    }
  });
  return upper ? value.toUpperCase() : value;
}

function outlineNumberParts(id: string): number[] {
  return String(id || '').split('.').map((part) => parseInt(part, 10)).filter((part) => Number.isFinite(part) && part > 0);
}

function formatOutlineNumber(id: string, headingStyle: Record<string, unknown> | null): string {
  const parts = outlineNumberParts(id);
  if (!parts.length) return '';
  if (headingStyle?.numbering_format === 'outline-decimal') return parts.join('.');
  if (headingStyle?.numbering_format !== 'custom') return '';
  const lastPart = parts[parts.length - 1];
  const cn = numberToChinese(lastPart);
  const tail = (parts.length >= 3 ? parts.slice(2) : [lastPart]).join('.');
  return String(headingStyle.numbering_template || '')
    .replace(/\{tail(\d+)\}/g, (_, level) => {
      const startLevel = Number(level);
      if (!Number.isFinite(startLevel) || startLevel < 1 || startLevel > 6 || startLevel > parts.length) return '';
      return parts.slice(startLevel - 1).join('.');
    })
    .replace(/\{zh\}/g, cn)
    .replace(/\{num\}/g, String(lastPart))
    .replace(/\{tail\}/g, tail)
    .replace(/\{full\}/g, parts.join('.'))
    .replace(/\{circled\}/g, numberToCircled(lastPart))
    .replace(/\{alpha\}/g, numberToAlpha(lastPart))
    .replace(/\{ALPHA\}/g, numberToAlpha(lastPart, true))
    .replace(/\{roman\}/g, numberToRoman(lastPart))
    .replace(/\{ROMAN\}/g, numberToRoman(lastPart, true))
    .trim();
}

function shouldInsertSpaceAfterNumber(prefix: string): boolean {
  return !/[、，。；：）)】\]》〉]$/.test(prefix);
}

function formatOutlineTitle(id: string, title: string, headingStyle: Record<string, unknown> | null): string {
  const prefix = formatOutlineNumber(id, headingStyle);
  if (!prefix) return String(title || '');
  return `${prefix}${shouldInsertSpaceAfterNumber(prefix) ? ' ' : ''}${title || ''}`;
}

// ── 图片 run / 段落 ──────────────────────────────────────────────────────────
interface ImageNode {
  url: string;
  alt?: string;
}

async function imageRunFromNode(node: ImageNode, context: ExportContext, options: { loadRetry?: { retryAttempts?: number; retryDelayMs?: number; onRetry?: (a: number, e: unknown) => void }; loadedImage?: LoadedImage | null } = {}): Promise<TextRun> {
  let loaded: LoadedImage | null = null;
  const imageLabel = compactText(node.alt || node.url || '未知图片');
  const imageIndex = (context.imageCount || 0) + 1;
  context.imageCount = imageIndex;
  writeExportLog(context, 'export.image.started', {
    image_index: imageIndex, label: imageLabel, source: describeImageSourceForLog(node.url),
  });
  try {
    loaded = Object.prototype.hasOwnProperty.call(options, 'loadedImage')
      ? (options.loadedImage as LoadedImage | null)
      : await loadImageWithRetry(node.url, { baseDir: context.baseDir }, options.loadRetry || {});
  } catch (error) {
    const message = `图片无法导出：${imageLabel}，${compactText((error as Error).message || '下载失败', 120)}`;
    addWarning(context, message);
    return textRun(`[${message}]`, { color: 'C83220' });
  }
  if (!loaded?.buffer || !loaded.type) {
    const message = `图片无法导出：${imageLabel}，未找到可用图片数据`;
    addWarning(context, message);
    return textRun(`[${message}]`, { color: 'C83220' });
  }
  try {
    loaded = normalizeImageForDocx(loaded);
  } catch (error) {
    const message = `图片无法导出：${imageLabel}，${(error as Error).message || '图片格式转换失败'}`;
    addWarning(context, message);
    return textRun(`[${message}]`, { color: 'C83220' });
  }
  let size: { width: number; height: number };
  try {
    size = measureImage(loaded.buffer);
  } catch {
    const message = `图片无法导出：${imageLabel}，图片尺寸识别失败`;
    addWarning(context, message);
    return textRun(`[${message}]`, { color: 'C83220' });
  }
  const sourceWidth = size.width || MAX_IMAGE_WIDTH;
  const sourceHeight = size.height || Math.round(MAX_IMAGE_WIDTH * 0.62);
  const maxWidth = getImageMaxWidth(context);
  const maxHeight = getImageMaxHeight(context);
  const ratio = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * ratio));
  const height = Math.max(1, Math.round(sourceHeight * ratio));
  context.imageSuccessCount = (context.imageSuccessCount || 0) + 1;
  return new ImageRun({
    type: loaded.type as 'png' | 'jpg' | 'gif' | 'bmp',
    data: loaded.buffer,
    transformation: { width, height },
    altText: {
      title: cleanText(node.alt || '图片'),
      description: cleanText(node.alt || node.url || 'Markdown 图片'),
      name: cleanText(node.alt || 'image'),
    },
  });
}

async function imageParagraphFromSource(source: string, alt: string, context: ExportContext): Promise<Paragraph> {
  return paragraph([await imageRunFromNode({ url: source, alt }, context)], getImageParagraphOptions(context));
}

async function imageParagraphFromLoadedImage(source: string, alt: string, loadedImage: LoadedImage | null, context: ExportContext): Promise<Paragraph> {
  return paragraph([await imageRunFromNode({ url: source, alt }, context, { loadedImage })], getImageParagraphOptions(context));
}

// ── HTML → docx 内联/表格/列表 ──────────────────────────────────────────────
interface HtmlNode {
  type: string;
  name?: string;
  data?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function htmlTagName(node: HtmlNode | undefined): string {
  return String(node?.name || '').toLowerCase();
}

function isHtmlBrNode(node: HtmlNode | undefined): boolean {
  return node?.type === 'tag' && htmlTagName(node) === 'br';
}

function htmlInlineGroupHasContent($: CheerioAPI, nodes: HtmlNode[] = []): boolean {
  return nodes.some((node) => {
    if (!node) return false;
    if (node.type === 'text') return Boolean(String(node.data || '').trim());
    if (node.type === 'tag') return htmlTagName(node) !== 'br' || Boolean($(node as never).text().trim());
    return false;
  });
}

function splitHtmlInlineNodesByBreaks($: CheerioAPI, nodes: HtmlNode[] = []): HtmlNode[][] {
  const groups: HtmlNode[][] = [];
  let current: HtmlNode[] = [];
  let hasBreak = false;
  for (const node of nodes) {
    if (isHtmlBrNode(node)) {
      hasBreak = true;
      groups.push(current);
      current = [];
      continue;
    }
    current.push(node);
  }
  groups.push(current);
  if (!hasBreak) return [nodes];
  return groups.filter((group) => htmlInlineGroupHasContent($, group));
}

function hasBlockHtmlChildren($: CheerioAPI, node: HtmlNode): boolean {
  return ($(node as never).contents().toArray() as HtmlNode[]).some((child) => ['table', 'ul', 'ol', 'blockquote', 'pre', 'div', 'section', 'article', 'img', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(htmlTagName(child)));
}

async function htmlInlineRuns($: CheerioAPI, nodes: HtmlNode[], context: ExportContext, marks: RunOptions = {}): Promise<ParagraphChild[]> {
  if (context.bodyRunFont && !('font' in marks)) marks = { font: context.bodyRunFont, ...marks };
  if (context.bodyRunSize && !('size' in marks)) marks = { size: context.bodyRunSize, ...marks };
  const runs: ParagraphChild[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(...textRunsWithSubjectReplacementComments(node.data || '', marks, context));
      continue;
    }
    if (node.type !== 'tag') continue;
    const tag = htmlTagName(node);
    if (tag === 'br') {
      runs.push(lineBreakRun());
    } else if (tag === 'strong' || tag === 'b') {
      runs.push(...await htmlInlineRuns($, ($(node as never).contents().toArray() as HtmlNode[]), context, { ...marks, bold: true }));
    } else if (tag === 'em' || tag === 'i') {
      runs.push(...await htmlInlineRuns($, ($(node as never).contents().toArray() as HtmlNode[]), context, { ...marks, italics: true }));
    } else if (tag === 'del' || tag === 's' || tag === 'strike') {
      runs.push(...await htmlInlineRuns($, ($(node as never).contents().toArray() as HtmlNode[]), context, { ...marks, strike: true }));
    } else if (tag === 'code') {
      runs.push(new TextRun({ text: cleanText($(node as never).text()), font: 'Consolas', size: 22, color: '155BD7' }));
    } else if (tag === 'a') {
      const href = ($(node as never).attr('href') as string) || '';
      const children = await htmlInlineRuns($, ($(node as never).contents().toArray() as HtmlNode[]), context, { ...marks, color: '2174FD', underline: true });
      if (href) {
        runs.push(new ExternalHyperlink({ link: href, children }));
      } else {
        runs.push(...children);
      }
    } else if (tag === 'img') {
      runs.push(await imageRunFromNode({ url: ($(node as never).attr('src') as string) || '', alt: ($(node as never).attr('alt') as string) || 'HTML 图片' }, context));
    } else if (tag === 'input' && String(($(node as never).attr('type') as string) || '').toLowerCase() === 'checkbox') {
      runs.push(textRun(($(node as never).attr('checked') == null ? '☐ ' : '☑ '), { ...marks, font: 'Segoe UI Symbol' }));
    } else {
      if (!['p', 'span', 'label', 'small', 'sub', 'sup', 'mark'].includes(tag)) addUnsupportedHtmlWarning(context, tag);
      runs.push(...await htmlInlineRuns($, ($(node as never).contents().toArray() as HtmlNode[]), context, marks));
    }
  }
  return runs;
}

async function htmlTableToDocx($: CheerioAPI, tableNode: HtmlNode, context: ExportContext): Promise<Table[]> {
  const rows: TableRow[] = [];
  const rowDescriptors = ($(tableNode as never).find('tr').toArray() as HtmlNode[]).map((rowNode) => {
    const cells = ($(rowNode as never).children('th,td').toArray() as HtmlNode[]).map((cellNode) => ({
      node: cellNode,
      columnSpan: normalizeColumnSpan(($(cellNode as never).attr('colspan') as string)),
    }));
    return { cells, columnCount: cells.reduce((sum, cell) => sum + cell.columnSpan, 0) };
  }).filter((row) => row.cells.length);
  const maxColumns = Math.max(1, ...rowDescriptors.map((row) => row.columnCount));
  for (const [rowIndex, row] of rowDescriptors.entries()) {
    const cells: TableCell[] = [];
    const rowHasExplicitHeader = row.cells.some((cell) => htmlTagName(cell.node) === 'th');
    const firstCellText = row.cells.length ? String($(row.cells[0].node as never).text() || '').replace(/\s+/g, ' ').trim() : '';
    const firstRowLooksLikeData = /^\d+(?:[.．]\d+)*(?:[、.．)）])?$/.test(firstCellText);
    const rowIsHeader = rowHasExplicitHeader || (rowIndex === 0 && !firstRowLooksLikeData);
    for (const [cellIndex, cell] of row.cells.entries()) {
      const cellNode = cell.node;
      const isHeader = rowIsHeader || htmlTagName(cellNode) === 'th';
      const isFirstColumn = !isHeader && cellIndex === 0;
      const cellStyle = getTableCellStyle(context, { isHeader, isFirstColumn }) as Record<string, unknown>;
      const remainingSpan = cellIndex === row.cells.length - 1 ? maxColumns - row.columnCount : 0;
      cells.push(createTableCell({
        children: [paragraph(await htmlInlineRuns($, ($(cellNode as never).contents().toArray() as HtmlNode[]), context, tableCellRunMarks(cellStyle)), tableCellParagraphOptions(cellStyle))],
        context,
        isHeader,
        isFirstColumn,
        columnSpan: cell.columnSpan + Math.max(0, remainingSpan),
        totalColumns: maxColumns,
      }));
    }
    rows.push(new TableRow({ children: cells }));
  }
  if (!rows.length) return [];
  return [createDocxTable(rows, maxColumns, context)];
}

function buildListParagraphOptions(context: ExportContext, reference: string | null, level: number, itemIndex: number, totalItems: number, options: { manualListIndent?: boolean; manualIndent?: boolean } = {}): ParagraphOptions {
  const paragraphOptions: ParagraphOptions = reference ? { numbering: { reference, level } } : {};
  if (!reference && options.manualListIndent) {
    const indent = getManualUnorderedListLevelIndent(context, level);
    if (indent) paragraphOptions.indent = indent;
  } else if (!reference && options.manualIndent) {
    const indent = getTaskListLevelIndent(context, level);
    if (indent) paragraphOptions.indent = indent;
  }
  if (context.bodyLineSpacing) paragraphOptions.line = context.bodyLineSpacing;
  if (context.bodyAlignment) paragraphOptions.alignment = context.bodyAlignment;
  if (itemIndex === 0 && context.bodyBeforeSpacing) paragraphOptions.before = context.bodyBeforeSpacing;
  paragraphOptions.after = itemIndex === totalItems - 1 ? (context.bodyAfterSpacing ?? 0) : 0;
  return paragraphOptions;
}

function isWhitespaceHtmlTextNode(node: HtmlNode | undefined): boolean {
  return node?.type === 'text' && !String(node.data || '').trim();
}

function isCheckboxInputNode($: CheerioAPI, node: HtmlNode | undefined): boolean {
  return htmlTagName(node) === 'input' && String(($(node as never).attr('type') as string) || '').toLowerCase() === 'checkbox';
}

function hasClassName($: CheerioAPI, node: HtmlNode | undefined, className: string): boolean {
  return String(($(node as never).attr('class') as string) || '').split(/\s+/).includes(className);
}

function isTaskListItem($: CheerioAPI, itemNode: HtmlNode, inlineNodes: HtmlNode[] = []): boolean {
  if (hasClassName($, itemNode, 'task-list-item')) return true;
  return inlineNodes.some((node) => {
    if (isCheckboxInputNode($, node)) return true;
    return htmlTagName(node) === 'p' && ($(node as never).children('input[type="checkbox"]').length > 0);
  });
}

async function htmlListToDocx($: CheerioAPI, listNode: HtmlNode, context: ExportContext, options: { listLevel?: number } = {}): Promise<(Paragraph | Table)[]> {
  const blocks: (Paragraph | Table)[] = [];
  const ordered = htmlTagName(listNode) === 'ol';
  const unorderedListWithoutMarker = !ordered && context.bodyListStyle === 'none';
  let numberingReference: string | null = null;
  const listItems = ($(listNode as never).children('li').toArray() as HtmlNode[]);
  for (const [itemIndex, itemNode] of listItems.entries()) {
    const inlineNodes = ($(itemNode as never).contents().toArray() as HtmlNode[])
      .filter((child) => !['ul', 'ol'].includes(htmlTagName(child)))
      .filter((child) => !isWhitespaceHtmlTextNode(child));
    const isTaskItem = isTaskListItem($, itemNode, inlineNodes);
    if (!isTaskItem && numberingReference == null && !unorderedListWithoutMarker) {
      numberingReference = ordered ? createOrderedListReference(context) : createUnorderedListReference(context);
    }
    const listOptions = buildListParagraphOptions(
      context,
      isTaskItem ? null : numberingReference,
      Math.min(options.listLevel || 0, 2),
      itemIndex,
      listItems.length,
      { manualIndent: isTaskItem, manualListIndent: !isTaskItem && unorderedListWithoutMarker },
    );
    blocks.push(paragraph(await htmlInlineRuns($, inlineNodes, context), listOptions));
    for (const childList of ($(itemNode as never).children('ul,ol').toArray() as HtmlNode[])) {
      blocks.push(...await htmlListToDocx($, childList, context, { ...options, listLevel: (options.listLevel || 0) + 1 }));
    }
  }
  return blocks;
}

function buildHtmlBodyParaOpts(context: ExportContext): ParagraphOptions {
  const opts: ParagraphOptions = {};
  if (context.bodyAfterSpacing != null) opts.after = context.bodyAfterSpacing;
  if (context.bodyLineSpacing) opts.line = context.bodyLineSpacing;
  if (context.bodyAlignment) opts.alignment = context.bodyAlignment;
  if (context.bodyIndent) opts.indent = context.bodyIndent;
  if (context.bodyBeforeSpacing) opts.before = context.bodyBeforeSpacing;
  return opts;
}

// ── Mermaid → docx ──────────────────────────────────────────────────────────
async function mermaidCodeToDocxBlocks(code: string, context: ExportContext): Promise<Paragraph[]> {
  const value = String(code || '').trim();
  if (!value) return [];
  const nextIndex = (context.convertedMermaidCount || 0) + 1;
  const total = context.stats?.mermaidCount || nextIndex;
  let cacheEntry: ReturnType<typeof getMermaidCacheEntry> | null = null;
  try {
    cacheEntry = getMermaidCacheEntry(value);
    reportConversionProgress(context, cacheEntry.exists
      ? `Mermaid 图 ${nextIndex}/${total} 已命中本地缓存。`
      : `正在转换 Mermaid 图 ${nextIndex}/${total}，可能需要联网等待。`);
    const loadRetry = {
      retryAttempts: 2,
      retryDelayMs: 3000,
      onRetry: (attempt: number) => {
        reportConversionProgress(context, `Mermaid 图 ${nextIndex}/${total} 转换失败，3 秒后第 ${attempt} 次重试。`);
      },
    };
    const block = cacheEntry.exists
      ? await imageParagraphFromSource(`file://${cacheEntry.filePath}`, 'Mermaid 图', context)
      : await (async () => {
          const loaded = await loadImageWithRetry(mermaidInkUrl(cacheEntry.code), { baseDir: context.baseDir }, loadRetry);
          if (loaded?.buffer?.length) {
            try {
              saveMermaidCacheImage(cacheEntry.hash, loaded.buffer);
            } catch {
              /* cache write failure non-fatal */
            }
          }
          return imageParagraphFromLoadedImage(mermaidInkUrl(cacheEntry.code), 'Mermaid 图', loaded, context);
        })();
    reportConversionProgress(context, `Mermaid 图 ${nextIndex}/${total} 已转换并缓存。`);
    return [block];
  } catch (error) {
    const message = `Mermaid 图无法导出：${compactText((error as Error).message || '转换失败', 120)}`;
    addWarning(context, message);
    reportConversionProgress(context, `Mermaid 图 ${nextIndex}/${total} 转换失败。`);
    return [paragraph([textRun(`[${message}]`, { color: 'C83220' })], { alignment: AlignmentType.CENTER })];
  } finally {
    context.convertedMermaidCount = nextIndex;
  }
}

function isMermaidCodeElement($: CheerioAPI, codeNode: HtmlNode): boolean {
  const className = String(($(codeNode as never).attr('class') as string) || '').toLowerCase();
  return /\blanguage-mermaid\b/.test(className) || /\bmermaid\b/.test(className);
}

async function htmlHeadingToDocxBlocks($: CheerioAPI, node: HtmlNode, context: ExportContext): Promise<Paragraph[]> {
  const mdLevel = Math.min(Math.max(parseInt(htmlTagName(node).slice(1), 10) || 1, 1), 6);
  const style = getHeadingStyle(context.exportFormat, mdLevel);
  const headingOpts: ParagraphOptions = {
    heading: headingLevel(mdLevel),
    before: style ? (style.spacing_before_pt as number) * 20 : (mdLevel === 1 ? 280 : 180),
    after: style ? (style.spacing_after_pt as number) * 20 : 120,
    indent: { left: 0, right: 0, firstLine: 0, hanging: 0 },
  };
  if (style) {
    headingOpts.alignment = alignmentToWordType(style.alignment as string);
    if (style.line_spacing) headingOpts.line = 240 * (style.line_spacing as number);
  }
  const runMarks: RunOptions = {};
  if (style) {
    runMarks.font = (style.font as string) || '黑体';
    runMarks.size = chineseSizeToHalfPt((style.size as string) || '小四');
    runMarks.bold = false;
  } else {
    runMarks.bold = true;
  }
  return [paragraph(await htmlInlineRuns($, ($(node as never).contents().toArray() as HtmlNode[]), context, runMarks), headingOpts)];
}

async function htmlNodeToDocxBlocks($: CheerioAPI, node: HtmlNode, context: ExportContext, options: { listLevel?: number } = {}): Promise<(Paragraph | Table)[]> {
  if (node.type === 'text') {
    const text = String(node.data || '').trim();
    if (!text) return [];
    const runOpts: RunOptions = {};
    if (context.bodyRunFont) runOpts.font = context.bodyRunFont;
    if (context.bodyRunSize) runOpts.size = context.bodyRunSize;
    return [paragraph([textRun(text, runOpts)], buildHtmlBodyParaOpts(context))];
  }
  if (node.type !== 'tag') return [];
  const tag = htmlTagName(node);
  if (/^h[1-6]$/.test(tag)) return htmlHeadingToDocxBlocks($, node, context);
  if (tag === 'table') return htmlTableToDocx($, node, context);
  if (tag === 'img') return [await imageParagraphFromSource(($(node as never).attr('src') as string) || '', ($(node as never).attr('alt') as string) || 'HTML 图片', context)];
  if (tag === 'ul' || tag === 'ol') return htmlListToDocx($, node, context, options);
  if (tag === 'blockquote') {
    return [paragraph(await htmlInlineRuns($, ($(node as never).contents().toArray() as HtmlNode[]), context, { color: '536176' }), {
      indent: { left: 360 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: '2174FD' } },
      shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
    })];
  }
  if (tag === 'pre') {
    const codeNode = ($(node as never).children('code').first() as unknown as HtmlNode[]);
    if (codeNode.length && isMermaidCodeElement($, codeNode[0])) return mermaidCodeToDocxBlocks($(codeNode[0] as never).text(), context);
    return [paragraph([new TextRun({ text: cleanText($(node as never).text()), font: 'Consolas', size: 21, color: '243048' })], {
      shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
      indent: { left: 260, right: 260 },
    })];
  }
  if (tag === 'br') return [paragraph([lineBreakRun()])];
  if (tag === 'hr') return [paragraph([textRun('────────────────────────', { color: 'DCDFF6' })], { alignment: AlignmentType.CENTER })];
  if (['div', 'section', 'article'].includes(tag) && hasBlockHtmlChildren($, node)) return htmlNodesToDocxBlocks($, ($(node as never).contents().toArray() as HtmlNode[]), context, options);
  if (tag === 'p' && hasBlockHtmlChildren($, node)) return htmlNodesToDocxBlocks($, ($(node as never).contents().toArray() as HtmlNode[]), context, options);
  if (['p', 'div', 'section', 'article', 'span', 'strong', 'b', 'em', 'i', 'del', 's', 'strike', 'a', 'code', 'label', 'small', 'sub', 'sup', 'mark'].includes(tag)) {
    const isFigureCaption = /^图[:：]/.test($(node as never).text().trim());
    if (isFigureCaption) {
      return [paragraph([textRun($(node as never).text().trim(), getCaptionRunMarks(context))], getCaptionParagraphOptions(context))];
    }
    const htmlParaOpts = buildHtmlBodyParaOpts(context);
    const groups = splitHtmlInlineNodesByBreaks($, ($(node as never).contents().toArray() as HtmlNode[]));
    const paragraphs: Paragraph[] = [];
    for (const [index, group] of groups.entries()) {
      const paraOpts: ParagraphOptions = { ...htmlParaOpts };
      if (groups.length > 1 && index < groups.length - 1) paraOpts.after = 0;
      if (index > 0) delete paraOpts.before;
      paragraphs.push(paragraph(await htmlInlineRuns($, group, context), paraOpts));
    }
    return paragraphs;
  }
  addUnsupportedHtmlWarning(context, tag);
  return htmlNodesToDocxBlocks($, ($(node as never).contents().toArray() as HtmlNode[]), context, options);
}

async function htmlNodesToDocxBlocks($: CheerioAPI, nodes: HtmlNode[], context: ExportContext, options: { listLevel?: number } = {}): Promise<(Paragraph | Table)[]> {
  const blocks: (Paragraph | Table)[] = [];
  for (const node of nodes) {
    blocks.push(...await htmlNodeToDocxBlocks($, node, context, options));
  }
  return blocks;
}

async function htmlToDocxBlocks(html: string, context: ExportContext): Promise<(Paragraph | Table)[]> {
  const source = String(html || '').trim();
  if (!source) return [];
  const cheerio = await import('cheerio');
  const $ = cheerio.load(source, null, false);
  const blocks = await htmlNodesToDocxBlocks($, ($.root().contents().toArray() as HtmlNode[]), context);
  if (!blocks.length) addWarning(context, '部分 HTML 内容未能导出，请核对 Word 内容。');
  return blocks;
}

async function markdownToDocxBlocks(content: string, context: ExportContext): Promise<(Paragraph | Table)[]> {
  const markdown = normalizeMarkdownTablesForDocx(normalizeMarkdownListMarkersForDocx(content));
  const html = await renderMarkdownHtml(markdown, { allowRawHtml: true, enableGfm: true });
  return htmlToDocxBlocks(html, context);
}

async function addMarkdownContent(children: (Paragraph | Table)[], content: string, context: ExportContext): Promise<void> {
  children.push(...await markdownToDocxBlocks(content, context));
}

// ── 大纲遍历 ────────────────────────────────────────────────────────────────
function buildOutlineHeadingParagraph(item: OutlineItemLike, context: ExportContext, level: number, options: { compact?: boolean; manualNumbering?: boolean; disablePageBreakBefore?: boolean; omitNumbering?: boolean; disableIndent?: boolean } = {}): Paragraph {
  const style = getHeadingStyle(context.exportFormat, level);
  const nativeHeadingNumbering = levelUsesNativeNumbering(context.exportFormat, level) && !options.manualNumbering && !options.omitNumbering;
  const displayTitle = options.omitNumbering
    ? String(item.title || '')
    : (nativeHeadingNumbering ? String(item.title || '') : formatOutlineTitle(item.id, String(item.title || ''), style));
  const runOptions: RunOptions = { bold: false };
  if (style) {
    runOptions.font = (style.font as string) || '黑体';
    runOptions.size = chineseSizeToHalfPt((style.size as string) || '小四');
    runOptions.bold = style.bold === true;
    runOptions.color = normalizeDocxColor((style.text_color as string) || '#243048', '243048');
  } else {
    runOptions.bold = true;
  }
  const paraOptions: ParagraphOptions = {
    heading: headingLevel(level),
    pageBreakBefore: level === 1 && isLevel1PageBreakEnabled(context.exportFormat) && !options.disablePageBreakBefore,
    alignment: style ? alignmentToWordType(style.alignment as string) : undefined,
    before: options.compact ? 0 : (style ? (style.spacing_before_pt as number) * 20 : (level === 1 ? 320 : 200)),
    after: options.compact ? 0 : (style ? (style.spacing_after_pt as number) * 20 : 120),
    line: style ? 240 * ((style.line_spacing as number) || 1) : undefined,
  };
  paraOptions.indent = { left: 0, right: 0, firstLine: 0, hanging: 0 };
  if (nativeHeadingNumbering) {
    context.usesHeadingNumbering = true;
    paraOptions.numbering = { reference: HEADING_NUMBERING_REFERENCE, level: Math.min(level - 1, 5) };
  }
  return paragraph([textRun(displayTitle, runOptions)], paraOptions);
}

async function addChapterFrameRows(rows: TableRow[], items: OutlineItemLike[], context: ExportContext, level = 1): Promise<void> {
  for (const item of items || []) {
    const isLeaf = !item.children?.length;
    const useLeafColumns = isLeaf && (context.exportFormat?.heading_border as Record<string, unknown> | undefined)?.min_heading_left_enabled === true;
    if (useLeafColumns) {
      const bodyChildren: Paragraph[] = [];
      if (String(item.content || '').trim()) await addMarkdownContent(bodyChildren, String(item.content), context);
      rows.push(buildChapterLeafRow(
        context.exportFormat,
        buildOutlineHeadingParagraph(item, context, level, { compact: true, manualNumbering: true, disablePageBreakBefore: true, omitNumbering: true }),
        bodyChildren,
        level,
      ) as TableRow);
      context.convertedLeafCount = (context.convertedLeafCount || 0) + 1;
      reportConversionProgress(context, `已处理 ${context.convertedLeafCount}/${context.stats?.leafCount || context.convertedLeafCount} 个正文小节。`);
      continue;
    }
    rows.push(buildChapterHeadingRow(
      context.exportFormat,
      buildOutlineHeadingParagraph(item, context, level, { compact: true, disableIndent: true, manualNumbering: true, disablePageBreakBefore: true }),
      level,
    ) as TableRow);
    if (isLeaf) {
      if (String(item.content || '').trim()) {
        const bodyChildren: Paragraph[] = [];
        await addMarkdownContent(bodyChildren, String(item.content), context);
        rows.push(buildChapterContentRow(context.exportFormat, bodyChildren) as TableRow);
      }
      context.convertedLeafCount = (context.convertedLeafCount || 0) + 1;
      reportConversionProgress(context, `已处理 ${context.convertedLeafCount}/${context.stats?.leafCount || context.convertedLeafCount} 个正文小节。`);
      continue;
    }
    await addChapterFrameRows(rows, item.children || [], context, level + 1);
  }
}

async function addOutlineItems(children: (Paragraph | Table)[], items: OutlineItemLike[], context: ExportContext, level = 1): Promise<void> {
  for (const item of items || []) {
    const useChapterFrame = level === 1 && getChapterFrameConfig(context.exportFormat);
    if (useChapterFrame) {
      const rows: TableRow[] = [];
      await addChapterFrameRows(rows, [item], context, level);
      if (isLevel1PageBreakEnabled(context.exportFormat)) children.push(pageBreakParagraph());
      children.push(buildChapterFrameTable(context.exportFormat, rows) as Table);
      continue;
    }
    children.push(buildOutlineHeadingParagraph(item, context, level));
    if (!item.children?.length) {
      if (String(item.content || '').trim()) await addMarkdownContent(children, String(item.content), context);
      context.convertedLeafCount = (context.convertedLeafCount || 0) + 1;
      reportConversionProgress(context, `已处理 ${context.convertedLeafCount}/${context.stats?.leafCount || context.convertedLeafCount} 个正文小节。`);
      continue;
    }
    await addOutlineItems(children, item.children || [], context, level + 1);
  }
}

// ── numbering / styles 装配 ─────────────────────────────────────────────────
function getTaskListLevelIndent(context: ExportContext, level: number): Record<string, number> | null {
  const bodyStyle = (context.exportFormat?.body_text as Record<string, unknown>) || {};
  const safeLevel = Math.max(0, Math.min(Number(level) || 0, 2));
  if (safeLevel <= 0) return null;
  const listIndentChars = typeof bodyStyle.list_indent_chars === 'number' ? bodyStyle.list_indent_chars : 2;
  return { left: Math.round(charsToTwips(listIndentChars, context.bodyRunSize || 24) * safeLevel) };
}

function getManualUnorderedListLevelIndent(context: ExportContext, level: number): Record<string, number> | null {
  const safeLevel = Math.max(0, Math.min(Number(level) || 0, 2));
  const listIndentChars = typeof context.bodyListIndentChars === 'number' ? context.bodyListIndentChars : 2;
  const left = Math.round(charsToTwips(listIndentChars, context.bodyRunSize || 24) * (safeLevel + 1));
  return left > 0 ? { left } : null;
}

function getListLevelIndent(referenceConfig: NumberingReferenceConfig, level: number): Record<string, number> {
  const baseIndent = charsToTwips(referenceConfig.listIndentChars, referenceConfig.bodyRunSize);
  const left = Math.round(baseIndent * (level + 1));
  const hanging = Math.min(left, charsToTwips(1, referenceConfig.bodyRunSize));
  return { left, hanging };
}

function createListNumberingLevel(referenceConfig: NumberingReferenceConfig, level: number) {
  const ordered = referenceConfig.ordered === true;
  const orderedStyle = getOrderedListWordStyle(referenceConfig.orderedListStyle);
  const marker = UNORDERED_LIST_MARKERS[referenceConfig.unorderedListStyle] || UNORDERED_LIST_MARKERS.disc;
  const markerSize = Math.max(1, Math.round((referenceConfig.bodyRunSize || 24) * (marker.sizeScale || 1)));
  return {
    level,
    format: ordered ? orderedStyle.format : LevelFormat.BULLET,
    text: ordered ? orderedStyle.text(level) : marker.text,
    alignment: AlignmentType.START,
    suffix: LevelSuffix.TAB,
    style: {
      run: { font: ordered ? (referenceConfig.bodyRunFont || '宋体') : marker.font, size: ordered ? (referenceConfig.bodyRunSize || 24) : markerSize },
      paragraph: { indent: getListLevelIndent(referenceConfig, level) },
    },
  };
}

function createHeadingNumberingConfig() {
  return {
    reference: HEADING_NUMBERING_REFERENCE,
    levels: [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      format: LevelFormat.DECIMAL,
      start: 1,
      text: Array.from({ length: level + 1 }, (_, index) => `%${index + 1}`).join('.'),
      alignment: AlignmentType.START,
      suffix: LevelSuffix.TAB,
      style: { paragraph: { indent: { left: 360 + level * 360, hanging: 360 } } },
    })),
  };
}

function createNumberingConfig(context: ExportContext) {
  const references = context.numberingReferences || [];
  if (!references.length && !context.usesHeadingNumbering) return undefined;
  const config: unknown[] = [];
  if (context.usesHeadingNumbering) config.push(createHeadingNumberingConfig());
  config.push(...references.map((referenceConfig) => ({
    reference: referenceConfig.reference,
    levels: [0, 1, 2].map((level) => createListNumberingLevel(referenceConfig, level)),
  })));
  return { config };
}

function buildHeadingParagraphStyles(exportFormat: ExportFormatLike | null) {
  const styles: Record<string, unknown>[] = [];
  const names = ['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'];
  const ids = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];
  // 章节页框（heading_border.enabled）模式下，标题渲染走 addChapterFrameRows 且带
  // manualNumbering/omitNumbering 抑制原生编号，全部改用文本前缀。该模式下若再给 Heading
  // 样式挂多级列表，会与页框文本前缀冲突，故仅在非页框模式下绑定。
  const frameEnabled = (exportFormat?.heading_border as Record<string, unknown> | undefined)?.enabled === true;
  for (let i = 0; i < 6; i += 1) {
    const style = getHeadingStyle(exportFormat, i + 1);
    // 把 HEADING_NUMBERING_REFERENCE 多级列表绑到对应 Heading 样式：Word 中对该样式新建段落
    // 会自动继承编号，插入新标题时同级兄弟自动顺延（1.2 与 1.3 间插一个 → 原 1.3 变 1.4）。
    // 仅当该级 numbering_format=native 且非页框模式时绑定。
    const useStyleNumbering = !frameEnabled && levelUsesNativeNumbering(exportFormat, i + 1);
    if (!style) {
      styles.push({
        id: ids[i], name: names[i], basedOn: 'Normal',
        run: { bold: false },
        paragraph: {
          spacing: { before: 200, after: 120 },
          ...(useStyleNumbering ? { numbering: { reference: HEADING_NUMBERING_REFERENCE, level: Math.min(i, 5) } } : {}),
        },
      });
      continue;
    }
    const halfPt = chineseSizeToHalfPt((style.size as string));
    const lineSpacing = 240 * ((style.line_spacing as number) || 1);
    styles.push({
      id: ids[i], name: names[i], basedOn: 'Normal',
      run: { font: (style.font as string) || 'SimHei', size: halfPt, bold: false },
      paragraph: {
        spacing: { before: ((style.spacing_before_pt as number) || 10) * 20, after: ((style.spacing_after_pt as number) || 10) * 20, line: lineSpacing },
        alignment: alignmentToWordType(style.alignment as string),
        indent: { left: 0, right: 0, firstLine: 0, hanging: 0 },
        ...(useStyleNumbering ? { numbering: { reference: HEADING_NUMBERING_REFERENCE, level: Math.min(i, 5) } } : {}),
      },
    });
  }
  return styles;
}

// 把 native 多级编号绑到 docx.js 的「内置」Heading 1-6 样式（styles.default.headingN）。
// 必要性：docx.js 在 styles.xml 里会无条件先发一份内置 Heading 样式，再追加 paragraphStyles，
// 形成 styleId 重复。Word 对重复 styleId 取首条还是末条并不可靠，而 buildOutlineHeadingParagraph
// 的字体/字号是 run 级直接格式——无法证明样式层走了哪份。为确保「在 Word 里新建 Heading 段落
// 一定继承编号」，让内置那份也带 numPr：无论 Word 取首还是末，两份都有 numPr，样式继承必中。
// 章节页框模式下原生编号被 manualNumbering 抑制（全用文本前缀），此时不绑，避免与页框冲突。
function buildHeadingDefaultOverrides(exportFormat: ExportFormatLike | null): Record<string, unknown> {
  const frameEnabled = (exportFormat?.heading_border as Record<string, unknown> | undefined)?.enabled === true;
  if (frameEnabled) return {};
  const overrides: Record<string, unknown> = {};
  for (let i = 0; i < 6; i += 1) {
    if (!levelUsesNativeNumbering(exportFormat, i + 1)) continue;
    overrides[`heading${i + 1}`] = {
      paragraph: { numbering: { reference: HEADING_NUMBERING_REFERENCE, level: Math.min(i, 5) } },
    };
  }
  return overrides;
}

// ── 顶层装配 ────────────────────────────────────────────────────────────────
export async function buildDocxResult(
  payload: { project_name?: string; outline?: OutlineItemLike[]; export_format?: Record<string, unknown> | null; base_dir?: string; baseDir?: string; subject_replacement_comment_terms?: string[] },
  options: { onProgress?: (p: BuildProgress) => void; warnings?: string[] } = {},
): Promise<BuildResult> {
  const exportFormat = (payload && payload.export_format) || null;
  const stats = countOutlineStats(payload.outline || []);
  const context: ExportContext = {
    baseDir: payload?.base_dir || payload?.baseDir,
    onProgress: options.onProgress,
    warnings: options.warnings || [],
    stats,
    convertedLeafCount: 0,
    convertedMermaidCount: 0,
    imageCount: 0,
    imageSuccessCount: 0,
    numberingReferences: [],
    numberingIndex: 0,
    usesHeadingNumbering: false,
    unsupportedHtmlTags: new Set(),
    developerLogger: NOOP_LOGGER,
    exportFormat,
    subjectReplacementCommentTerms: normalizeCommentTerms(payload.subject_replacement_comment_terms),
    comments: new ExportCommentRegistry(),
  };
  writeExportLog(context, 'export.docx.build.started', { stats, content_metrics: countOutlineContentMetrics(payload.outline || []) });

  const bodyStyle = (exportFormat && exportFormat.body_text) ? (exportFormat.body_text as Record<string, unknown>) : null;
  const bodyFont = bodyStyle ? ((bodyStyle.font as string) || '宋体') : '宋体';
  const bodySizeHalfPt = bodyStyle ? chineseSizeToHalfPt((bodyStyle.size as string) || '小四') : 24;
  const bodyLineSpacing = bodyStyle ? 240 * ((bodyStyle.line_spacing_multiple as number) || 1.2) : 360;
  const bodyAfterSpacing = bodyStyle ? ((bodyStyle.spacing_after_pt as number) || 0) * 20 : 160;

  context.bodyRunFont = bodyFont;
  context.bodyRunSize = bodySizeHalfPt;
  context.bodyLineSpacing = bodyLineSpacing;
  context.bodyAfterSpacing = bodyAfterSpacing;
  context.bodyListStyle = bodyStyle ? ((bodyStyle.list_style as string) || 'disc') : 'disc';
  context.bodyOrderedListStyle = bodyStyle ? ((bodyStyle.ordered_list_style as string) || 'decimal-dot') : 'decimal-dot';
  context.bodyListIndentChars = bodyStyle ? ((bodyStyle.list_indent_chars as number) ?? 2) : 2;
  if (bodyStyle) {
    context.bodyAlignment = alignmentToWordType(bodyStyle.alignment as string);
    if (((bodyStyle.first_line_indent_chars as number) || 0) > 0) {
      context.bodyIndent = { firstLine: charsToTwips(bodyStyle.first_line_indent_chars as number, bodySizeHalfPt) };
    }
    if (((bodyStyle.spacing_before_pt as number) || 0) > 0) {
      context.bodyBeforeSpacing = (bodyStyle.spacing_before_pt as number) * 20;
    }
  }

  const children: (Paragraph | Table)[] = [
    paragraph([textRun(payload.project_name || '投标技术文件', { bold: true, size: 34 })], { alignment: AlignmentType.CENTER, after: 300 }),
  ];

  reportProgress(context, 10, stats.mermaidCount
    ? `准备导出正文，并转换 ${stats.mermaidCount} 张 Mermaid 图。`
    : '准备导出正文。');
  await addOutlineItems(children, payload.outline || [], context);
  reportProgress(context, 90, '正在生成 Word 文件。');

  const pageSetup = (exportFormat && exportFormat.page) ? (exportFormat.page as Record<string, unknown>) : null;
  const pageMargin = pageSetup ? {
    top: cmToTwips((pageSetup.margin_top_cm as number) ?? 2),
    bottom: cmToTwips((pageSetup.margin_bottom_cm as number) ?? 2),
    left: cmToTwips((pageSetup.margin_left_cm as number) ?? 2),
    right: cmToTwips((pageSetup.margin_right_cm as number) ?? 2),
    footer: cmToTwips((pageSetup.footer_distance_cm as number) ?? 1.75),
  } : { top: 1440, right: 1440, bottom: 1440, left: 1440, footer: cmToTwips(1.75) };
  const firstPageDifferent = pageSetup ? pageSetup.first_page_different === true : false;

  const pageSizeConfig: { size?: { width: number; height: number; orientation: PageOrientation } } = {};
  if (pageSetup && pageSetup.paper_size) {
    const dims = PAPER_DIMENSIONS_MM[pageSetup.paper_size as string];
    if (dims) {
      const isLandscape = pageSetup.orientation === 'landscape';
      pageSizeConfig.size = {
        width: mmToTwips(dims.width),
        height: mmToTwips(dims.height),
        orientation: isLandscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
      };
    }
  }

  const sectionChildren = [...children];
  const pageNumberEnabled = isPageNumberEnabled(pageSetup);
  const pageNumberStart = Math.max(1, Math.floor(Number(pageSetup ? pageSetup.page_number_start : 1) || 1));
  const headers = buildWordHeaders(pageSetup);
  const footers = buildWordFooters(pageSetup);
  const numbering = createNumberingConfig(context);
  const comments = context.comments.toOptions();
  const headingStyles = buildHeadingParagraphStyles(exportFormat);
  const headingDefaultOverrides = buildHeadingDefaultOverrides(exportFormat);
  const sectionProperties: ConstructorParameters<typeof Document>[0]['sections'][number]['properties'] = {
    page: {
      margin: pageMargin as never,
      ...(pageSizeConfig.size ? { size: pageSizeConfig.size as never } : {}),
      ...(pageNumberEnabled ? { pageNumbers: { start: pageNumberStart } } : {}),
    } as never,
    ...(firstPageDifferent ? { titlePage: true } : {}),
  };
  const doc = new Document({
    ...(comments ? { comments } : {}),
    ...(numbering ? { numbering } : {}),
    styles: {
      default: {
        document: {
          run: { font: bodyFont, size: bodySizeHalfPt },
          paragraph: { spacing: { line: bodyLineSpacing, after: bodyAfterSpacing } },
        },
        ...headingDefaultOverrides,
      },
      paragraphStyles: headingStyles as never,
    },
    sections: [{
      properties: sectionProperties,
      headers: headers as never,
      footers: footers as never,
      children: sectionChildren as never,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return { buffer, warnings: context.warnings, stats };
}
