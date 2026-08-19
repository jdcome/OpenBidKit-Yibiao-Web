// 导出格式纯工具与类型（移植自 client/electron/services/exportService.cjs 的常量与无副作用函数）。
// docx 耦合的常量（如 ORDERED_LIST_WORD_STYLES 引用 LevelFormat）放在 docxBuilder.ts。
import type { AlignmentType } from 'docx';

// ── 中文字号 → half-pt（docx size 单位是 half-point）────────────────────────
export const SIZE_TO_HALF_PT: Record<string, number> = {
  '初号': 84, '小初': 72, '一号': 52, '小一': 48, '二号': 44, '小二': 36,
  '三号': 32, '小三': 30, '四号': 28, '小四': 24, '五号': 21, '小五': 18,
  '六号': 15, '小六': 13,
};

export function chineseSizeToHalfPt(sizeName: string): number {
  return SIZE_TO_HALF_PT[sizeName] || 24;
}

export function charsToTwips(chars: number, bodySizeHalfPt = 24): number {
  const safeChars = Math.max(0, Number(chars) || 0);
  const safeHalfPt = Math.max(1, Number(bodySizeHalfPt) || 24);
  return Math.round(safeChars * safeHalfPt * 10);
}

export function cmToTwips(cm: number): number {
  return Math.round((cm || 0) * 567);
}

// 1mm = 1440 twips ÷ 25.4 mm/inch
export function mmToTwips(mm: number): number {
  return Math.round(mm * 56.6929);
}

// 表格单元格「水平+垂直居中」标签：段落水平映射为 center，垂直居中由 docxBuilder 落 <w:vAlign>。
export const TABLE_CELL_VERTICAL_CENTER_ALIGN = '水平+垂直居中';

// 中文对齐标签 → docx AlignmentType（运行时映射，避免在此文件 import 整个 docx 运行时枚举字面量）
const ALIGNMENT_MAP: Record<string, AlignmentType> = {
  '居中对齐': 'center',
  [TABLE_CELL_VERTICAL_CENTER_ALIGN]: 'center',
  '两端对齐': 'justified',
  '左对齐': 'left',
  '右对齐': 'right',
} as unknown as Record<string, AlignmentType>;

export function alignmentToWordType(align: string | undefined): AlignmentType {
  return (ALIGNMENT_MAP[String(align || '')] || 'justified') as AlignmentType;
}

// 颜色：接受 #rgb / #rrggbb / 裸 hex，归一化为大写 6 位 hex（无 #）
export function normalizeDocxColor(value: string | undefined, fallback = '536176'): string {
  const raw = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return raw.split('').map((char) => `${char}${char}`).join('').toUpperCase();
  }
  return fallback;
}

// 剥离非法控制字符（docx 不容许 \x00-\x08 \x0B \x0C \x0E-\x1F）
export function cleanText(value: unknown): string {
  return String(value || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function sanitizeFilename(value: string): string {
  return String(value || '标书文档')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '标书文档';
}

// 时间戳由调用方传入（service 层用 new Date()），此处只做格式化
export function formatExportTimestamp(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// 精确到分钟的时间戳（导出文件名用：编号+项目名称+导出时间）
export function formatExportTimestampMinute(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ── 纸张尺寸 mm（portrait 模式 width × height），与渲染器 exportFormat.ts 对齐 ──
export const PAPER_DIMENSIONS_MM: Record<string, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  a5: { width: 148, height: 210 },
  b4: { width: 250, height: 353 },
  b5: { width: 176, height: 250 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  '16k': { width: 184, height: 260 },
};

// ── 默认样式（exportFormat 缺字段时兜底）──────────────────────────────────
export const DOCX_TABLE_WIDTH_TWIPS = 9000;
export const CHAPTER_LEAF_TITLE_WIDTH_TWIPS = 1800;
export const CHAPTER_LEAF_CONTENT_WIDTH_TWIPS = DOCX_TABLE_WIDTH_TWIPS - CHAPTER_LEAF_TITLE_WIDTH_TWIPS;
export const MAX_IMAGE_WIDTH = 520;
export const MAX_IMAGE_HEIGHT_PERCENT = 90;

export const DEFAULT_HEADING_BORDER_CELL_COLORS = ['#e0ecff', '#e9f1ff', '#f2f7ff', '#f8fbff', '#ffffff', '#ffffff'];

export const DEFAULT_TABLE_STYLE = {
  border_width: 1,
  border_color: '#dcdff6',
  cell_padding_pt: 6,
  full_width: true,
  header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#243048', background_color: '#eef5ff' },
  first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
  body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
};

export const DEFAULT_IMAGE_STYLE = {
  max_width_percent: 90,
  alignment: '居中对齐',
  caption_font: '宋体',
  caption_size: '小五',
  caption_alignment: '居中对齐',
  caption_bold: false,
  caption_italic: false,
};

// 无序列表 marker 字形（docx 用 BULLET 格式 + 显式 marker 字符渲染）
export const UNORDERED_LIST_MARKERS: Record<string, { text: string; font: string; sizeScale: number }> = {
  disc: { text: '•', font: 'Arial', sizeScale: 0.75 },
  circle: { text: '○', font: 'Arial', sizeScale: 0.82 },
  square: { text: '■', font: 'Arial', sizeScale: 0.72 },
  diamond: { text: '◆', font: 'Arial', sizeScale: 0.72 },
  dash: { text: '–', font: 'Arial', sizeScale: 0.9 },
  check: { text: '✓', font: 'Segoe UI Symbol', sizeScale: 0.85 },
  arrow: { text: '➢', font: 'Segoe UI Symbol', sizeScale: 0.88 },
  sparkle: { text: '✧', font: 'Segoe UI Symbol', sizeScale: 0.9 },
};

export const NUMBERING_REFERENCE_PREFIX = 'technical-plan-numbering';
export const HEADING_NUMBERING_REFERENCE = 'technical-plan-heading-numbering';

// ── payload 结构类型（outline 树 + 导出格式配置）──────────────────────────
// 渲染器按 ExportFormatConfig 传整个模板配置；服务端按结构读取，缺字段走默认。
export interface OutlineItemLike {
  id: string;
  title?: string;
  content?: string;
  children?: OutlineItemLike[];
}

export interface ExportWordPayload {
  requestId?: string;
  project_code?: string;
  project_name?: string;
  outline?: OutlineItemLike[];
  export_format?: Record<string, unknown> | null;
  base_dir?: string;
  baseDir?: string;
  // 服务端内部字段：导出时对投标主体代称替换后的全称插入核对批注。
  subject_replacement_comment_terms?: string[];
}

// 文本紧凑化（用于日志/警告）
export function compactText(value: unknown, maxLength = 140): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
