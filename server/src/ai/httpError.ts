// 忠实移植自 client/electron/utils/aiHttpError.cjs。
// 区别：原版用 electron.BrowserWindow.getAllWindows().webContents.send 广播；
// Web 版改为进程内订阅者列表，SSE 总线（M1-P6）订阅后向浏览器 fan-out。
import { isRetryableHttpStatus, markAiRequestError } from './retry';
import { eventBus } from '../events/bus';

export interface AiHttpErrorPayload {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
  source: string;
  createdAt: string;
}

function getHeaderValue(headers: any, name: string): string {
  if (!headers?.get) return '';
  return headers.get(name) || '';
}

function parseResponseDetail(rawText: string): string {
  try {
    const body: any = rawText ? JSON.parse(rawText) : null;
    return body?.error?.message || body?.message || '';
  } catch {
    return '';
  }
}

function createAiHttpErrorPayload(response: any, rawText: string, source?: string): AiHttpErrorPayload {
  return {
    status: Number(response?.status || 0),
    statusText: response?.statusText || '',
    contentType: getHeaderValue(response?.headers, 'content-type'),
    body: String(rawText || ''),
    source: source || 'ai-service',
    createdAt: new Date().toISOString(),
  };
}

export function isAiHttpErrorHtmlPayload(payload: AiHttpErrorPayload | null | undefined): boolean {
  if (!payload) return false;
  const contentType = String(payload.contentType || '').toLowerCase();
  if (contentType.includes('html')) return true;
  return /<!doctype\s+html|<html[\s>]/i.test(String(payload.body || ''));
}

function formatAiHttpErrorMessage(payload: AiHttpErrorPayload): string {
  const statusLabel = payload.status
    ? `HTTP ${payload.status}${payload.statusText ? ` ${payload.statusText}` : ''}`
    : 'HTTP 错误';
  return `AI 服务商返回 ${statusLabel} 错误，请查看弹窗中的原始返回内容。`;
}

export async function createAiHttpErrorFromResponse(
  response: any,
  fallbackMessage = 'AI 请求失败',
  options: { source?: string; responseFormatUnsupportedChecker?: (text: string) => boolean } = {},
): Promise<any> {
  const rawText = await response.text().catch(() => '');
  const payload = createAiHttpErrorPayload(response, rawText, options.source);
  const detail = parseResponseDetail(rawText);
  const message = isAiHttpErrorHtmlPayload(payload)
    ? formatAiHttpErrorMessage(payload)
    : detail || String(rawText || '').trim() || fallbackMessage;
  const error: any = new Error(message);
  if (payload.status) {
    error.status = payload.status;
    error.statusCode = payload.status;
  }
  const retryAfterHeader = getHeaderValue(response?.headers, 'retry-after');
  if (retryAfterHeader) {
    error.aiHttpRetryAfter = retryAfterHeader;
  }
  error.raw_response_body = rawText;
  error.aiHttpError = payload;
  error.ai_http_error = payload;
  error.aiHttpErrorDetail = detail;
  if (typeof options.responseFormatUnsupportedChecker === 'function') {
    error.responseFormatUnsupported = options.responseFormatUnsupportedChecker(detail || rawText);
  }
  return markAiRequestError(error, { retryable: isRetryableHttpStatus(payload.status) });
}

export function getAiHttpError(error: any): AiHttpErrorPayload | null {
  if (!error) return null;
  if (error.aiHttpError) return error.aiHttpError;
  if (error.ai_http_error) return error.ai_http_error;
  if (error.cause) return getAiHttpError(error.cause);
  return null;
}

export function copyAiHttpError(source: any, target: any): any {
  const payload = getAiHttpError(source);
  if (!payload || !target) return target;
  target.aiHttpError = payload;
  target.ai_http_error = payload;
  if (source.aiHttpErrorDetail) {
    target.aiHttpErrorDetail = source.aiHttpErrorDetail;
  }
  return target;
}

// 经 EventBus 向触发该 AI 请求的项目 SSE 通道 fan-out（仅 HTML 类错误，用于弹窗展示原始返回）。
// 与桌面版一致——只广播 HTML 类错误。projectId 由调用方从 config.__sseProjectId 透传
// （路由/引擎在 buildMerged 后打戳），未带 projectId 时静默不发（如服务端自发的连通性测试无归属项目）。
export function emitAiHttpError(
  errorOrPayload: any,
  overrides: Record<string, any> = {},
  options: { projectId?: string } = {},
): boolean {
  const payload: any = getAiHttpError(errorOrPayload) || errorOrPayload;
  if (!payload?.body && !payload?.status) return false;
  if (!isAiHttpErrorHtmlPayload(payload)) return false;
  const eventPayload = { ...payload, ...overrides };
  if (options.projectId) {
    eventBus.emit(options.projectId, 'ai-http-error', eventPayload);
  }
  return true;
}
