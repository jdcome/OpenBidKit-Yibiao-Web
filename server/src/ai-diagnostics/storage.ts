import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeDiagnosticText } from './sanitize';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function safeId(value: unknown, label: string): string {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${label} 无效`);
  return id;
}

function assertInside(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('诊断文件路径越界');
  }
  return resolvedTarget;
}

export function createAiDiagnosticStorage(rootDir: string) {
  const root = path.resolve(rootDir);
  return {
    async writeFailure(traceId: string, attemptId: string, content: unknown): Promise<string> {
      const trace = safeId(traceId, 'traceId');
      const attempt = safeId(attemptId, 'attemptId');
      const day = new Date().toISOString().slice(0, 10);
      const dir = assertInside(root, path.join(root, day, trace));
      await mkdir(dir, { recursive: true });
      const finalPath = assertInside(root, path.join(dir, `${attempt}.txt`));
      const tempPath = assertInside(root, `${finalPath}.${randomUUID()}.tmp`);
      await writeFile(tempPath, sanitizeDiagnosticText(content), 'utf8');
      await rename(tempPath, finalPath);
      return path.relative(root, finalPath);
    },
    async readFailure(relativePath: string): Promise<string> {
      if (!relativePath || path.isAbsolute(relativePath)) throw new Error('诊断文件路径无效');
      const target = assertInside(root, path.join(root, relativePath));
      return readFile(target, 'utf8');
    },
    async deleteExpired(now = new Date()): Promise<number> {
      let entries: Dirent<string>[] = [];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error: any) {
        if (error?.code === 'ENOENT') return 0;
        throw error;
      }
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const target = assertInside(root, path.join(root, entry.name));
        const info = await stat(target);
        if (now.getTime() - info.mtime.getTime() <= RETENTION_MS) continue;
        await rm(target, { recursive: true, force: true });
        removed += 1;
      }
      return removed;
    },
  };
}
