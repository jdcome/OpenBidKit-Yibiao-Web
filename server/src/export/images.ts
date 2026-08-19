// 图片加载（移植自 exportService.cjs 1024-1174）。
// 与桌面差异：
//  - yibiao-asset://generated-images|imported-images → 返回 null（Web 服务端尚无 AI 生成图/导入图产物，P6/P7）。
//  - WebP→PNG 不再走 electron nativeImage；docx 库本身不支持 webp，故 webp 抛错 → 上游降级为占位 warning。
//  - data: / http(s): / file: / 绝对/相对路径 全部保留（fs 在服务端可用）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from 'image-size';

export interface LoadedImage {
  buffer: Buffer;
  type: 'png' | 'jpg' | 'gif' | 'bmp' | 'webp' | null;
}

export function imageTypeFromMime(mime: string | undefined | null): LoadedImage['type'] {
  if (!mime) return null;
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('webp')) return 'webp';
  return null;
}

export function imageTypeFromPath(filePath: string | undefined | null): LoadedImage['type'] {
  const ext = path.extname(filePath || '').toLowerCase().replace('.', '');
  if (ext === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'gif', 'bmp', 'webp'].includes(ext) ? (ext as LoadedImage['type']) : null;
}

export function describeImageSourceForLog(source: string): Record<string, unknown> {
  const value = String(source || '').trim();
  if (!value) return { kind: 'empty' };
  if (/^data:/i.test(value)) return { kind: 'data-url' };
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'remote', protocol: url.protocol.replace(':', ''), host: url.hostname, extension: path.extname(url.pathname || '').toLowerCase() };
    }
    if (url.protocol === 'file:') {
      return { kind: 'local-file-url', extension: path.extname(url.pathname || '').toLowerCase() };
    }
    return { kind: 'url', protocol: url.protocol.replace(':', '') };
  } catch {
    return { kind: path.isAbsolute(value) ? 'local-path' : 'relative-path', extension: path.extname(value).toLowerCase() };
  }
}

// WebP docx 不支持，也无法在服务端无 sharp 时转码 → 抛错让上游降级占位。
export function normalizeImageForDocx(loaded: LoadedImage): LoadedImage {
  if (!loaded?.buffer || !loaded.type) return loaded;
  if (loaded.type !== 'webp') return loaded;
  throw new Error('WebP 图片暂不支持导出（服务端未启用 sharp 转码）');
}

export async function loadImage(source: string, context: { baseDir?: string } = {}): Promise<LoadedImage | null> {
  const url = String(source || '').trim();
  if (!url) return null;

  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (dataUrlMatch) {
    return { buffer: Buffer.from(dataUrlMatch[2], 'base64'), type: imageTypeFromMime(dataUrlMatch[1]) };
  }

  // yibiao-asset:// — 桌面解析到 generated-images / imported-images 目录；Web 服务端目前无此产物。
  if (/^yibiao-asset:\/\//i.test(url)) {
    return null;
  }

  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`图片下载失败：${url}`);
    }
    const type = imageTypeFromMime(response.headers.get('content-type')) || imageTypeFromPath(new URL(url).pathname);
    return { buffer: Buffer.from(await response.arrayBuffer()), type };
  }

  const fileUrlPrefix = 'file://';
  const rawPath = url.startsWith(fileUrlPrefix) ? fileURLToPath(url) : url;
  const resolvedPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(context.baseDir || process.cwd(), rawPath);

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  return { buffer: fs.readFileSync(resolvedPath), type: imageTypeFromPath(resolvedPath) };
}

const REMOTE_IMAGE_RETRY_ATTEMPTS = 2;
const REMOTE_IMAGE_RETRY_DELAY_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadImageWithRetry(
  source: string,
  context: { baseDir?: string } = {},
  options: { retryAttempts?: number; retryDelayMs?: number; onRetry?: (attempt: number, error: unknown) => void } = {},
): Promise<LoadedImage | null> {
  const retryAttempts = Math.max(0, Number(options.retryAttempts ?? REMOTE_IMAGE_RETRY_ATTEMPTS) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? REMOTE_IMAGE_RETRY_DELAY_MS) || 0);
  let attempt = 0;
  while (attempt <= retryAttempts) {
    try {
      return await loadImage(source, context);
    } catch (error) {
      if (attempt >= retryAttempts) throw error;
      attempt += 1;
      options.onRetry?.(attempt, error);
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }
  return null;
}

export function measureImage(buffer: Buffer): { width: number; height: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = imageSize(buffer as any) as { width?: number; height?: number };
  return { width: result.width || 0, height: result.height || 0 };
}
