// 导出编排层（移植自 exportService.cjs createExportService.exportWord 2118-2193）。
// 与桌面差异：
//  - 去掉 dialog.showSaveDialog（浏览器用 Content-Disposition 触发下载，无需选保存路径）。
//  - 去掉 fs.writeFileSync（直接把 buffer 经 HTTP 返回）。
//  - 去掉 shell.openPath（浏览器无此能力；下载完成后由用户自行打开）。
//  - executeRequiredOnlineService ping gate 去掉：mermaid.ink 联网失败由 loadImageWithRetry 兜底降级。
//  - developerLogger no-op（不落 JSONL 调试日志）。
import { buildDocxResult } from './docxBuilder';
import type { BuildProgress } from './docxBuilder';
import { sanitizeFilename, formatExportTimestampMinute, type ExportWordPayload } from './format';

export interface ExportWordOptions {
  onProgress?: (progress: BuildProgress) => void;
}

export interface ExportWordResult {
  buffer: Buffer;
  filename: string;
  warnings: string[];
  stats: { leafCount: number; mermaidCount: number };
}

function buildExportFilename(payload: ExportWordPayload): string {
  const projectName = sanitizeFilename(payload.project_name || '标书文档');
  const rawCode = String(payload.project_code || '').trim();
  const prefix = rawCode ? `${sanitizeFilename(rawCode)}${projectName}` : projectName;
  const timestamp = formatExportTimestampMinute(new Date());
  return `${prefix}_${timestamp}.docx`;
}

export async function exportWordToBuffer(payload: ExportWordPayload, options: ExportWordOptions = {}): Promise<ExportWordResult> {
  const outline = Array.isArray(payload?.outline) ? payload.outline : [];
  if (!outline.length) {
    throw new Error('大纲为空，无法导出 Word 文件。');
  }

  const onProgress = options.onProgress;
  const filename = buildExportFilename(payload);

  const { buffer, warnings, stats } = await buildDocxResult(
    {
      project_name: payload.project_name,
      outline,
      export_format: payload.export_format ?? null,
      base_dir: payload.base_dir || payload.baseDir,
      subject_replacement_comment_terms: payload.subject_replacement_comment_terms,
    },
    { onProgress, warnings: [] },
  );

  onProgress?.({
    phase: 'completed',
    progress: 100,
    message: 'Word 文件已生成。',
    warnings,
  });

  return { buffer, filename, warnings, stats };
}
