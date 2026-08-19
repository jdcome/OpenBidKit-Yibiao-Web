// 本地文档解析层（移植自 client/electron/services/fileService.cjs 的本地路径）。
// P4 范围：仅本地解析器（convert.mjs），preserveImages 恒 false（图片一律剥离）。
// 不含 MinerU（SaaS OCR，留待按需接入）、不含图片持久化（仅 duplicate-check P6 分析时需要）。
//
// convert.mjs 是 ESM，用 dynamic import 加载（与桌面 fileService.cjs:109 同法）；
// documentParseErrors.cjs 是 CJS，用 createRequire 取（避免 TS 对 .cjs 的模块解析）。
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const {
  normalizeDocumentParseError,
  isLibreOfficeMissingError,
  isLegacyOfficeFile,
} = requireCjs('./documentParseErrors.cjs') as {
  normalizeDocumentParseError: (error: unknown, filePath: string) => Error;
  isLibreOfficeMissingError: (error: unknown) => boolean;
  isLegacyOfficeFile: (filePath: string) => boolean;
};

const markdownImagePattern = /!\[(?<alt>[^\]]*)\]\((?<target><[^>]+>|[^)\s]+)(?<title>\s+"[^"]*")?\)/gi;

export function stripMarkdownImages(text: string): string {
  return String(text || '')
    .replace(markdownImagePattern, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

export const LOCAL_SUPPORTED_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.docx', '.pdf', '.doc', '.wps', '.xls', '.xlsx',
] as const;
const LOCAL_SUPPORTED_SET = new Set<string>(LOCAL_SUPPORTED_EXTENSIONS);

export function isLocallySupported(filePath: string): boolean {
  return LOCAL_SUPPORTED_SET.has(path.extname(filePath).toLowerCase());
}

export interface ParseDocumentResult {
  markdown: string;
  parserLabel: string;
  chars: number;
  hash: string;
  fallbackToLocal: boolean;
}

// 多文件导入场景下带原始文件名的解析结果（multipart 收集层产出，各域 import 方法消费）。
export interface ParsedImport extends ParseDocumentResult {
  fileName: string;
}

async function computeHashAndChars(markdown: string): Promise<{ hash: string; chars: number }> {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(markdown, 'utf-8').digest('hex');
  const chars = markdown.replace(/\s+/g, '').length;
  return { hash, chars };
}

export async function parseDocument(filePath: string): Promise<ParseDocumentResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (!LOCAL_SUPPORTED_SET.has(ext)) {
    const err = new Error(`本地解析不支持该文件格式（${ext || '无扩展名'}），支持：${LOCAL_SUPPORTED_EXTENSIONS.join(' ')}`);
    err.name = 'DocumentParseError';
    (err as Error & { code?: string }).code = 'unsupported_format';
    throw err;
  }

  try {
    let markdown: string;
    if (ext === '.txt') {
      markdown = await fs.readFile(filePath, 'utf-8');
    } else {
      const { convertPathToMarkdown } = await import('./doc2markdown/convert.mjs');
      markdown = await convertPathToMarkdown(filePath, { includeImages: false, imageResolver: null });
    }
    markdown = stripMarkdownImages(markdown);
    const { hash, chars } = await computeHashAndChars(markdown);
    return { markdown, parserLabel: '本地解析', chars, hash, fallbackToLocal: true };
  } catch (error) {
    throw normalizeDocumentParseError(error, filePath);
  }
}

export { isLibreOfficeMissingError, isLegacyOfficeFile };
