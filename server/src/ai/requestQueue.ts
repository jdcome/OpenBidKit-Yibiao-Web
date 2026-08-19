// 忠实移植自 client/electron/utils/aiRequestQueue.cjs（纯逻辑）。
// 并发限流 + 作用域暂停 + 内建可重试错误退避重试。
import {
  AI_REQUEST_MAX_ATTEMPTS,
  getAiRetryDelayMs,
  isRetryableAiRequestError,
} from './retry';

export const AI_QUEUE_SCOPE_PAUSED = 'AI_QUEUE_SCOPE_PAUSED';

export function createQueueScopePausedError(): Error {
  const error: any = new Error('AI 请求队列已暂停');
  error.code = AI_QUEUE_SCOPE_PAUSED;
  return error;
}

function normalizeLimit(value: any, fallback = 10): number {
  const number = Number(value);
  return Math.max(1, Number.isFinite(number) ? Math.round(number) : fallback);
}

export interface AiRequestQueueOptions {
  limit?: number;
  defaultLimit?: number;
  getLimit?: () => any;
}

export interface QueueStatus {
  active: number;
  queued: number;
  retrying: number;
  limit: number;
  pausedScopes: string[];
}

export function createAiRequestQueue(options: AiRequestQueueOptions = {}) {
  let activeCount = 0;
  const queue: any[] = [];
  const retryingJobs = new Set<any>();
  const pausedScopes = new Set<string>();
  const getLimit = typeof options.getLimit === 'function'
    ? options.getLimit
    : () => options.limit || 10;
  const fallbackLimit = normalizeLimit(options.defaultLimit, 10);

  function currentLimit(): number {
    try {
      return normalizeLimit(getLimit(), fallbackLimit);
    } catch {
      return fallbackLimit;
    }
  }

  function rejectIfPaused(job: any): boolean {
    if (!job.scopeId || !pausedScopes.has(job.scopeId)) {
      return false;
    }
    job.reject(createQueueScopePausedError());
    return true;
  }

  function pump(): void {
    while (activeCount < currentLimit() && queue.length) {
      const job = queue.shift();
      if (rejectIfPaused(job)) {
        continue;
      }
      activeCount += 1;
      void runJob(job);
    }
  }

  function scheduleRetry(job: any): void {
    retryingJobs.add(job);
    job.retryTimer = setTimeout(() => {
      retryingJobs.delete(job);
      job.retryTimer = null;
      if (!rejectIfPaused(job)) {
        queue.push(job);
        pump();
      }
    }, getAiRetryDelayMs(job.attempts - 1, job.lastError));
  }

  async function runJob(job: any): Promise<void> {
    try {
      if (rejectIfPaused(job)) {
        return;
      }
      const result = await job.runner({ attempt: job.attempts, maxAttempts: AI_REQUEST_MAX_ATTEMPTS });
      job.resolve(result);
    } catch (error: any) {
      if (isRetryableAiRequestError(error) && job.attempts < AI_REQUEST_MAX_ATTEMPTS) {
        job.attempts += 1;
        job.lastError = error;
        scheduleRetry(job);
      } else {
        job.reject(error);
      }
    } finally {
      activeCount = Math.max(0, activeCount - 1);
      pump();
    }
  }

  function enqueue<T>(runner: (ctx: { attempt: number; maxAttempts: number }) => Promise<T>, options: { scopeId?: string; queueScopeId?: string } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job = {
        runner,
        resolve,
        reject,
        scopeId: String(options.scopeId || options.queueScopeId || '').trim(),
        attempts: 1,
        retryTimer: null as (ReturnType<typeof setTimeout> | null),
      };
      if (rejectIfPaused(job)) {
        return;
      }
      queue.push(job);
      pump();
    });
  }

  function pauseScope(scopeId: string): number {
    const normalizedScopeId = String(scopeId || '').trim();
    if (!normalizedScopeId) {
      return 0;
    }
    pausedScopes.add(normalizedScopeId);
    let discarded = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const job = queue[index];
      if (job.scopeId !== normalizedScopeId) {
        continue;
      }
      queue.splice(index, 1);
      job.reject(createQueueScopePausedError());
      discarded += 1;
    }
    for (const job of Array.from(retryingJobs)) {
      if (job.scopeId !== normalizedScopeId) {
        continue;
      }
      retryingJobs.delete(job);
      if (job.retryTimer) {
        clearTimeout(job.retryTimer);
        job.retryTimer = null;
      }
      job.reject(createQueueScopePausedError());
      discarded += 1;
    }
    return discarded;
  }

  function resumeScope(scopeId: string): void {
    const normalizedScopeId = String(scopeId || '').trim();
    if (normalizedScopeId) {
      pausedScopes.delete(normalizedScopeId);
    }
  }

  function getStatus(): QueueStatus {
    return {
      active: activeCount,
      queued: queue.length,
      retrying: retryingJobs.size,
      limit: currentLimit(),
      pausedScopes: [...pausedScopes],
    };
  }

  return { enqueue, pauseScope, resumeScope, getStatus };
}
