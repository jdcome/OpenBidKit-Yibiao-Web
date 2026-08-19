// 忠实移植自 client/electron/utils/aiRetry.cjs（纯逻辑，无 Electron 依赖）。
// AI 请求重试：可重试 HTTP 状态（408/429/5xx）、网络错误码、abort/timeout、fetch 网络失败。
// 透传 cause 链与 errors[] 数组，避免吞掉底层错误。
const AI_REQUEST_MAX_ATTEMPTS = 3;
const AI_RETRY_DELAY_MS_BY_FAILED_ATTEMPT = [3000, 5000];
// 单次退避上限：无论 Retry-After 还是指数退避都不超过此值，避免单条请求长时间挂起队列。
const AI_RETRY_DELAY_MAX_MS = 60_000;

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DESTROYED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function normalizeHttpStatus(value: any): number {
  const status = Number(value);
  return Number.isFinite(status) ? Math.floor(status) : 0;
}

export function isRetryableHttpStatus(value: any): boolean {
  const normalized = normalizeHttpStatus(value);
  return RETRYABLE_HTTP_STATUS_CODES.has(normalized) || (normalized >= 500 && normalized <= 599);
}

function getErrorStatus(error: any): number {
  const status = normalizeHttpStatus(error?.status || error?.statusCode);
  if (status) {
    return status;
  }
  return error?.cause ? getErrorStatus(error.cause) : 0;
}

function walkErrorChain(error: any, visitor: (e: any) => boolean, seen: Set<any> = new Set()): boolean {
  if (!error || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (visitor(error)) {
    return true;
  }
  if (Array.isArray(error.errors)) {
    for (const child of error.errors) {
      if (walkErrorChain(child, visitor, seen)) {
        return true;
      }
    }
  }
  return walkErrorChain(error.cause, visitor, seen);
}

function hasRetryableNetworkCode(error: any): boolean {
  return walkErrorChain(error, (item) => RETRYABLE_NETWORK_ERROR_CODES.has(String(item?.code || '').toUpperCase()));
}

function isAbortLikeError(error: any): boolean {
  return walkErrorChain(error, (item) => {
    const name = String(item?.name || '');
    return name === 'AbortError' || name === 'TimeoutError';
  });
}

function isFetchNetworkError(error: any): boolean {
  return walkErrorChain(error, (item) => {
    const name = String(item?.name || '');
    const message = String(item?.message || '').toLowerCase();
    return name === 'TypeError' && (
      message.includes('fetch failed')
      || message.includes('network')
      || message.includes('socket')
    );
  });
}

export function markAiRequestError(error: any, options: { retryable?: boolean } = {}): any {
  const target: any = error instanceof Error ? error : new Error(String(error || 'AI 请求失败'));
  target.isAiRequestError = true;
  if (Object.prototype.hasOwnProperty.call(options, 'retryable')) {
    target.aiRequestRetryable = Boolean(options.retryable);
  }
  return target;
}

export function copyAiRequestErrorMeta(source: any, target: any): any {
  if (!source || !target) {
    return target;
  }
  if (source.isAiRequestError) {
    target.isAiRequestError = true;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'aiRequestRetryable')) {
    target.aiRequestRetryable = Boolean(source.aiRequestRetryable);
  }
  if (source.cause && !target.cause) {
    target.cause = source.cause;
  }
  return target;
}

export function isRetryableAiRequestError(error: any): boolean {
  if (!error || error?.code === 'AI_QUEUE_SCOPE_PAUSED') {
    return false;
  }
  if (error.aiRequestRetryable === false) {
    return false;
  }
  if (error.aiRequestRetryable === true) {
    return true;
  }
  const status = getErrorStatus(error);
  if (status) {
    return isRetryableHttpStatus(status);
  }
  if (isAbortLikeError(error)) {
    return true;
  }
  return hasRetryableNetworkCode(error) || isFetchNetworkError(error);
}

export function getAiRetryDelayMs(failedAttempt: number, error?: any): number {
  // 1) 优先尊重上游 Retry-After（429/503 场景）：解析 delta-seconds 或 HTTP-date，钳制到上限。
  //    DeepSeek 等 TPM 限流若返回 Retry-After，按它退避可避免无谓重试消耗配额。
  const retryAfterMs = error ? extractRetryAfterMs(error) : null;
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return applyJitter(retryAfterMs, 0.2);
  }
  // 2) 无 Retry-After 时走固定退避表（向后兼容原行为）+ ±25% 抖动，
  //    防止多 worker 在同一瞬间集中重试形成同步风暴。
  const attempt = Math.max(1, Number(failedAttempt) || 1);
  const base = AI_RETRY_DELAY_MS_BY_FAILED_ATTEMPT[
    Math.min(attempt, AI_RETRY_DELAY_MS_BY_FAILED_ATTEMPT.length) - 1
  ];
  return applyJitter(base, 0.25);
}

// Retry-After 解析（RFC 7231）：delta-seconds 或 HTTP-date。失败返回 null（继续 fallback）。
function parseRetryAfter(value: any): number | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return clampRetryMs(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return clampRetryMs(Math.max(0, delta));
  }
  return null;
}

function clampRetryMs(ms: number): number {
  return Math.max(0, Math.min(Math.round(ms), AI_RETRY_DELAY_MAX_MS));
}

// 沿 cause/errors 链查找首个可解析的 Retry-After：兼容 aiHttpRetryAfter（httpError 附加的原始头）、
// retryAfter、或带 headers 的 response 对象。
function extractRetryAfterMs(error: any): number | null {
  let found: number | null = null;
  walkErrorChain(error, (item) => {
    const explicit = Number(item?.aiHttpRetryAfterMs);
    if (Number.isFinite(explicit) && explicit >= 0) {
      found = clampRetryMs(explicit);
      return true;
    }
    const rawHeader =
      (typeof item?.aiHttpRetryAfter === 'string' && item.aiHttpRetryAfter) ||
      (item?.retryAfter != null ? String(item.retryAfter) : '') ||
      (typeof item?.headers?.get === 'function' ? item.headers.get('retry-after') : '') ||
      (typeof item?.response?.headers?.get === 'function' ? item.response.headers.get('retry-after') : '');
    const parsed = parseRetryAfter(rawHeader);
    if (parsed !== null) {
      found = parsed;
      return true;
    }
    return false;
  });
  return found;
}

// 对称抖动：base ± fraction*base，最终钳制到 [0, MAX]，避免退避意外过大或为负。
function applyJitter(baseMs: number, fraction: number): number {
  const safeBase = Math.max(0, baseMs);
  const delta = Math.round(safeBase * fraction);
  if (delta <= 0) return clampRetryMs(safeBase);
  const offset = Math.round((Math.random() * 2 - 1) * delta);
  return clampRetryMs(safeBase + offset);
}

function getAbortReason(signal?: AbortSignal): Error {
  return (signal?.reason as Error) || new Error('AI 请求已取消');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(getAbortReason(signal));
      return;
    }
    const cleanup = () => {
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(getAbortReason(signal!));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export interface AiRetryOptions {
  maxAttempts?: number;
  signal?: AbortSignal;
  onRetry?: (ctx: { error: any; attempt: number; nextAttempt: number; maxAttempts: number }) => void;
  getDelayMs?: (ctx: { error: any; attempt: number; nextAttempt: number; maxAttempts: number }) => number;
}

export async function runWithAiRetry<T>(
  runner: (ctx: { attempt: number; maxAttempts: number }) => Promise<T>,
  options: AiRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts) || AI_REQUEST_MAX_ATTEMPTS));
  let lastError: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw getAbortReason(options.signal);
    }
    try {
      return await runner({ attempt, maxAttempts });
    } catch (error: any) {
      lastError = error;
      if (options.signal?.aborted || attempt >= maxAttempts || !isRetryableAiRequestError(error)) {
        throw error;
      }
      await Promise.resolve(options.onRetry?.({ error, attempt, nextAttempt: attempt + 1, maxAttempts }));
      const delayMs = typeof options.getDelayMs === 'function'
        ? options.getDelayMs({ error, attempt, nextAttempt: attempt + 1, maxAttempts })
        : getAiRetryDelayMs(attempt, error);
      await delay(delayMs, options.signal);
    }
  }
  throw lastError || new Error('AI 请求失败');
}

export { AI_REQUEST_MAX_ATTEMPTS };
