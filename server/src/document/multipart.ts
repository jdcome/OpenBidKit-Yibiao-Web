// multipart 上传的两条共享收集路径：
//   - collectParsedImports：每 part 落临时文件 → parseDocument（technical_plan / rejection_check 导入用）。
//   - collectRawUploads   ：仅收字节缓冲，不解析（duplicate_check 选文件 / knowledge_base copy_source 用，
//     调用方自行决定落盘与是否再解析）。单 part 失败不阻断整批（收集到 errors）。
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import { parseDocument, isLibreOfficeMissingError, type ParsedImport } from './parser';

export interface CollectedImports {
  docs: ParsedImport[];
  errors: string[];
  officeMissing: boolean;
}

export async function collectParsedImports(req: FastifyRequest): Promise<CollectedImports> {
  const docs: ParsedImport[] = [];
  const errors: string[] = [];
  let officeMissing = false;
  for await (const part of req.files()) {
    const fileName = String(part.filename || 'upload');
    const ext = path.extname(fileName).toLowerCase();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yibiao-upload-'));
    const tmpPath = path.join(tmpDir, `upload${ext || ''}`);
    try {
      const buffer = await part.toBuffer();
      await fs.writeFile(tmpPath, buffer);
      const result = await parseDocument(tmpPath);
      docs.push({ fileName, ...result });
    } catch (error) {
      if (isLibreOfficeMissingError(error)) officeMissing = true;
      errors.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { docs, errors, officeMissing };
}

export interface RawUpload {
  fileName: string;
  ext: string;
  buffer: Buffer;
}

export interface CollectedRawUploads {
  files: RawUpload[];
  errors: string[];
}

// 仅收集 multipart 字节缓冲（不落临时文件、不解析）。调用方自行持久化或再 parseDocument。
export async function collectRawUploads(req: FastifyRequest): Promise<CollectedRawUploads> {
  const files: RawUpload[] = [];
  const errors: string[] = [];
  for await (const part of req.files()) {
    const fileName = String(part.filename || 'upload');
    const ext = path.extname(fileName).toLowerCase();
    try {
      const buffer = await part.toBuffer();
      files.push({ fileName, ext, buffer });
    } catch (error) {
      errors.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files, errors };
}
