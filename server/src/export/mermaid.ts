// Mermaid 图 → PNG 转换的 URL 生成 + 本地缓存（移植自 exportService.cjs 107-117 + utils/mermaidCache.cjs）。
// 桌面用 mermaid.ink 远程转图 + 本地文件缓存；服务端沿用同一策略，缓存目录改到 <dataDir>/shared/mermaid-cache/。
// yibiao-asset:// URL 在桌面用于渲染器回显，服务端导出只关心字节，故省略。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getDataDir } from '../document/paths';

const MERMAID_CACHE_DIR_NAME = 'mermaid-cache';
const MERMAID_CACHE_VERSION = 1;
const MERMAID_CACHE_OUTPUT_TYPE = 'png';
const MERMAID_CACHE_THEME = 'default';
const MERMAID_CACHE_BG_COLOR = '!white';

export function normalizeMermaidCode(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function createMermaidCacheHash(code: string): string {
  const payload = {
    version: MERMAID_CACHE_VERSION,
    outputType: MERMAID_CACHE_OUTPUT_TYPE,
    theme: MERMAID_CACHE_THEME,
    bgColor: MERMAID_CACHE_BG_COLOR,
    code: normalizeMermaidCode(code),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function getMermaidCacheDir(): string {
  return path.join(getDataDir(), 'shared', MERMAID_CACHE_DIR_NAME);
}

function getMermaidCacheFilePath(hash: string): string {
  return path.join(getMermaidCacheDir(), `${hash}.png`);
}

export interface MermaidCacheEntry {
  hash: string;
  code: string;
  filePath: string;
  exists: boolean;
}

export function getMermaidCacheEntry(code: string): MermaidCacheEntry {
  const normalizedCode = normalizeMermaidCode(code);
  const hash = createMermaidCacheHash(normalizedCode);
  const filePath = getMermaidCacheFilePath(hash);
  return { hash, code: normalizedCode, filePath, exists: fs.existsSync(filePath) };
}

export function saveMermaidCacheImage(hash: string, buffer: Buffer): void {
  if (!buffer?.length) return;
  const cacheDir = getMermaidCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = getMermaidCacheFilePath(hash);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  fs.renameSync(tempPath, filePath);
}

// mermaid.ink 接受 pako-deflate + base64url 编码的 {code, mermaid:{theme}} 状态。
export function encodeMermaidForInk(code: string): string {
  const state = JSON.stringify({ code: String(code || ''), mermaid: { theme: 'default' } });
  return `pako:${zlib.deflateSync(Buffer.from(state, 'utf-8')).toString('base64url')}`;
}

export function mermaidInkUrl(code: string): string {
  return `https://mermaid.ink/img/${encodeMermaidForInk(code)}?type=png&bgColor=!white`;
}
