// 导出 Word 的 Web HTTP 层。
// 桌面：IPC export:word → dialog 选路径 → fs.writeFileSync → 返回 {path,...}。
// Web：POST /api/export/word（responseType blob）→ 拿到 docx Blob → 触发浏览器下载。
// 不返回 path（浏览器自管下载）；warnings 留空（图片/Mermaid 失败已在 docx 正文内联占位）。
import { http } from './http';

export interface ExportWordPayload {
  requestId?: string;
  project_name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outline?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export_format?: any;
  base_dir?: string;
  baseDir?: string;
}

export interface ExportWordResult {
  canceled: boolean;
  message: string;
  warnings: string[];
  path?: string;
}

export interface WordExportProgressEvent {
  requestId?: string;
  phase: 'running' | 'completed' | 'error';
  progress: number;
  message: string;
  warnings?: string[];
}

// 解析 Content-Disposition 里的文件名，优先 RFC 5987 的 filename*=UTF-8''<pct> 形式。
function parseFilenameFromDisposition(disposition: string | undefined): string | null {
  if (!disposition) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plainMatch = /filename="?([^";]+)"?/i.exec(disposition);
  return plainMatch?.[1]?.trim() || null;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// responseType:'blob' 时，错误响应体也是 Blob（服务端 send 的 JSON），需读出再 parse。
async function extractErrorMessage(data: unknown): Promise<string> {
  if (data instanceof Blob) {
    try {
      const text = await data.text();
      try {
        const parsed = JSON.parse(text) as { error?: string };
        return parsed.error || text;
      } catch {
        return text;
      }
    } catch {
      return '导出失败';
    }
  }
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && 'error' in data) {
    return String((data as { error: unknown }).error || '导出失败');
  }
  return '导出失败';
}

export async function exportWord(payload: ExportWordPayload): Promise<ExportWordResult> {
  try {
    const response = await http.post('/export/word', payload, {
      responseType: 'blob',
      // mermaid.ink 远程转图可能很慢，给 5 分钟。
      timeout: 300000,
    });
    const blob = response.data as Blob;
    const filename = parseFilenameFromDisposition(response.headers['content-disposition'] as string | undefined) || 'export.docx';
    triggerBlobDownload(blob, filename);
    return {
      canceled: false,
      message: 'Word 已导出，请打开文档核对图片、表格和版式。',
      warnings: [],
    };
  } catch (error) {
    const message = await extractErrorMessage((error as { response?: { data?: unknown } })?.response?.data);
    throw new Error(message);
  }
}
