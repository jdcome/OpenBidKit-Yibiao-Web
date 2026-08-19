// 移植自 client/electron/utils/aiLog.cjs。
// 去磁盘化：writeAiLog 改为 no-op（dev-mode 落盘日志延后到 P8 服务端文件存储接入）。
// 其余纯逻辑（id/title 清洗、错误响应提取）保持一致，保证 aiService 调用契约不变。
import { randomUUID } from 'node:crypto';

const MAX_AI_LOG_TITLE_LENGTH = 64;

export function createAiRequestId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
}

export function sanitizeAiLogTitle(value: any): string {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_AI_LOG_TITLE_LENGTH)
    .replace(/[. ]+$/g, '');
}

export function resolveAiLogTitle(request: any, fallback = ''): string {
  return sanitizeAiLogTitle(request?.logTitle || request?.log_title || request?.progressLabel || request?.schemaName || fallback);
}

// 延后：dev-mode 落盘日志（P8 接入服务端文件存储后恢复）。
export function writeAiLog(_app: any, _config: any, _payload: any): void {
  // no-op
}

function getRawAiErrorResponse(error: any): any {
  for (const key of ['raw_response_body', 'raw_response_payload', 'raw_response_data']) {
    if (Object.prototype.hasOwnProperty.call(error || {}, key)) {
      return error[key];
    }
  }
  return undefined;
}

export function getAiErrorLogResponse(error: any, fallbackResponse: any): any {
  const rawResponse = getRawAiErrorResponse(error);
  return rawResponse === undefined ? fallbackResponse : rawResponse;
}

export function getAiErrorLogError(error: any, fallbackMessage: any): any {
  const rawResponse = getRawAiErrorResponse(error);
  return rawResponse === undefined || rawResponse === '' ? fallbackMessage : rawResponse;
}
