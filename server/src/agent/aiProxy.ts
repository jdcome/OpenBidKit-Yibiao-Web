// OpenCode AI proxy（移植自桌面 client/electron/services/opencode/aiServiceOpenAiProxy.cjs）。
// opencode 二进制把 provider `yibiao` 配成 @ai-sdk/openai-compatible 指向本 proxy（127.0.0.1:<port>/v1）。
// 本 proxy 收到 /v1/chat/completions 后：body.model 替换为平台 model_name、删 max_tokens*，
// fetch 上游（平台 base_url + 平台 api_key），SSE 字节级透传 + usage 捕获，错误经 EventBus 广播。
//
// 与 aiService.chat 同源配置（复用平台统一 key）但 HTTP 调用独立——agent 需要透传 SSE 流，
// 而 aiService.chat 返回已消费字符串。每请求 live 直读 getLiveAgentAiConfig：key/model 变免重启 sidecar。
// 仅 context_length_limit 变更触发 sidecar 重启（见 config/store.ts agentConfigVersion）。

import http from 'node:http';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithAiRetry, markAiRequestError } from '../ai/retry';
import { createAiRequestId, writeAiLog, getAiErrorLogError, getAiErrorLogResponse } from '../ai/log';
import { createAiHttpErrorFromResponse, emitAiHttpError } from '../ai/httpError';
import type { AgentAiConfig } from '../config/store';
import type { AgentActivityEvent } from './types';

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600000;
const SERVER_TIMEOUT_BUFFER_MS = 10000;

export interface AgentProxyDiagnostics {
  record?(event: string, payload: Record<string, unknown>): void;
}

export interface AgentProxyActivityContext {
  task_id?: string;
  task_token?: string;
}

export interface AgentProxyHandle {
  token: string;
  start(): Promise<{ token: string; port: number; baseUrl: string }>;
  getStatus(): { active: number; queued: number; limit: number };
  close(options?: { forceAfterMs?: number }): Promise<void>;
}

interface ProxyRequestBody {
  model?: string;
  messages?: Array<Record<string, unknown>>;
  tools?: unknown[];
  stream?: boolean;
  tool_choice?: unknown;
  response_format?: { type?: string };
  logTitle?: string;
  log_title?: string;
  max_tokens?: number;
  max_output_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

function normalizeTimeoutMs(value: number | string | undefined, fallback = DEFAULT_UPSTREAM_TIMEOUT_MS): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createProxyToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function trimBaseUrl(baseUrl: string | undefined): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function normalizeEndpointHost(baseUrl: string | undefined): string {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) return '';
  const candidates = rawValue.includes('://') ? [rawValue] : [`https://${rawValue}`];
  for (const candidate of candidates) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      /* try next */
    }
  }
  return '';
}

function normalizeConcurrencyLimit(value: number | undefined, fallback = 10): number {
  const number = Number(value);
  return Math.max(1, Number.isFinite(number) ? Math.round(number) : fallback);
}

function hashText(value: unknown): string {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeErrorMessage(error: unknown): string {
  return String((error as Error)?.message || error || 'OpenCode AI proxy failed').slice(0, 1000);
}

function createPromptHash(body: ProxyRequestBody | undefined): string {
  return hashText(
    JSON.stringify({
      model: body?.model || '',
      messages: Array.isArray(body?.messages)
        ? body.messages.map((item) => ({ role: item?.role || '', content_hash: hashText(item?.content || '') }))
        : [],
      tools_count: Array.isArray(body?.tools) ? body.tools.length : 0,
      stream: Boolean(body?.stream),
    }),
  );
}

function normalizeTokenUsage(usage: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const source = usage || {};
  const num = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  const promptTokens = num(source.prompt_tokens ?? source.promptTokens ?? source.promptTokenCount);
  const completionTokens = num(source.completion_tokens ?? source.completionTokens ?? source.completionTokenCount);
  const totalTokens = num(source.total_tokens ?? source.totalTokens ?? source.totalTokenCount) || promptTokens + completionTokens;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
}

function appendProxyDiagnostic(diagnostics: AgentProxyDiagnostics | undefined, event: string, payload: Record<string, unknown> = {}): void {
  try {
    diagnostics?.record?.(event, payload);
  } catch {
    /* 自检诊断不能影响代理请求 */
  }
}

function emitProxyActivity(
  onActivity: ((event: AgentActivityEvent) => void) | undefined,
  activityContext: AgentProxyActivityContext | null,
  event: AgentActivityEvent = {},
): void {
  try {
    onActivity?.({
      ...event,
      visible: event.visible === undefined ? false : event.visible,
      activity: event.activity === undefined ? false : event.activity,
      task_token: activityContext?.task_token,
      meta: {
        ...(event.meta as Record<string, unknown> | undefined),
        task_id: activityContext?.task_id || '',
      },
    });
  } catch {
    /* activity 不能影响代理请求 */
  }
}

function summarizeProxyConfig(config: AgentAiConfig | null): Record<string, unknown> {
  return {
    provider: config?.text_model_provider || '',
    model_name: config?.model_name || '',
    endpoint_host: normalizeEndpointHost(config?.base_url),
    has_api_key: Boolean(config?.api_key),
    request_mode: config?.request_mode || '',
    context_length_limit: Number(config?.context_length_limit || 0),
    concurrency_limit: Number(config?.concurrency_limit || 0),
  };
}

function summarizeRequestBody(body: ProxyRequestBody | undefined): Record<string, unknown> {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    model: body?.model || '',
    stream: Boolean(body?.stream),
    messages_count: messages.length,
    tools_count: tools.length,
    tool_choice:
      typeof body?.tool_choice === 'string'
        ? body.tool_choice
        : body?.tool_choice && typeof body.tool_choice === 'object'
          ? 'object'
          : body?.tool_choice === undefined
            ? ''
            : String(body.tool_choice),
    response_format_type: body?.response_format?.type || '',
    prompt_hash: createPromptHash(body),
  };
}

function summarizeResponseData(responseData: any, content = ''): Record<string, unknown> {
  const choices = Array.isArray(responseData?.choices) ? responseData.choices : [];
  return {
    object: responseData?.object || '',
    choices_count: choices.length,
    finish_reasons: choices.map((c: any) => c?.finish_reason).filter(Boolean),
    content_chars: String(content || '').length,
    usage: normalizeTokenUsage(extractUsageFromPayload(responseData)),
  };
}

function summarizeProxyError(error: unknown): Record<string, unknown> {
  const err = error as any;
  const cause = err?.cause || null;
  return {
    name: err?.name || 'Error',
    message: safeErrorMessage(error),
    status: err?.status || err?.statusCode || 0,
    code: err?.code || '',
    cause_name: cause?.name || '',
    cause_code: cause?.code || '',
    cause_message: cause?.message || '',
    retryable: err?.aiRequestRetryable,
  };
}

function assertTextModelConfig(config: AgentAiConfig | null): asserts config is AgentAiConfig {
  if (!config?.api_key) throw new Error('请先在设置中配置文本模型 API Key');
  if (!config?.model_name) throw new Error('请先在设置中配置文本模型名称');
  if (!trimBaseUrl(config?.base_url)) throw new Error('请先在设置中配置文本模型 Base URL');
}

function normalizeOpenCodeProxyRequestBody(config: AgentAiConfig, sourceBody: ProxyRequestBody): ProxyRequestBody {
  const messages = Array.isArray(sourceBody.messages) ? sourceBody.messages : [];
  if (!messages.length) throw new Error('OpenCode 代理请求缺少 messages');
  const normalized: ProxyRequestBody = {
    ...sourceBody,
    // OpenCode 侧只使用 yibiao/default；真实模型名称以设置页保存的 model_name 为准。
    model: config.model_name,
    messages,
  };
  // 部分 OpenAI 兼容上游会拒绝 OpenCode 注入的输出长度参数。
  delete normalized.max_tokens;
  delete normalized.max_output_tokens;
  delete normalized.max_completion_tokens;
  return normalized;
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const value = String(req.headers.authorization || '').trim();
  return value === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<ProxyRequestBody> {
  const raw = await readRequestBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as ProxyRequestBody;
  } catch (error) {
    const wrapped = new Error(`JSON 请求体解析失败：${(error as Error).message}`) as Error & { statusCode?: number };
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function createAbortError(): Error {
  const error = new Error('AI 请求超时');
  error.name = 'AbortError';
  return markAiRequestError(error, { retryable: true });
}

function createTimeoutSignal(parentSignal: AbortSignal | undefined, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(createAbortError()), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('请求已取消'));
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    touch: undefined as (() => void) | undefined,
    clear() {
      clearTimeout(timer);
      if (parentSignal) {
        try {
          parentSignal.removeEventListener('abort', abortFromParent);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function createIdleTimeoutController(
  parentSignal: AbortSignal | undefined,
  timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  message?: string,
) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  function reset() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(markAiRequestError(new Error(message || 'AI 流式响应长时间无数据'), { retryable: true })),
      timeoutMs,
    );
  }
  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('请求已取消'));
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  reset();
  return {
    signal: controller.signal,
    touch: reset,
    clear() {
      if (timer) clearTimeout(timer);
      if (parentSignal) {
        try {
          parentSignal.removeEventListener('abort', abortFromParent);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

async function createUpstreamError(response: Response): Promise<Error> {
  return createAiHttpErrorFromResponse(response, `AI 请求失败：HTTP ${response.status}`, { source: 'opencode-agent' });
}

function responseHeadersFromUpstream(response: Response, fallbackContentType: string): Headers {
  const headers = new Headers();
  const contentType = response.headers.get('content-type') || fallbackContentType;
  if (contentType) headers.set('content-type', contentType);
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) headers.set('cache-control', cacheControl);
  const requestId = response.headers.get('x-request-id');
  if (requestId) headers.set('x-request-id', requestId);
  return headers;
}

function extractUsageFromPayload(payload: any): any {
  return payload?.usage || payload?.usageMetadata || payload?.usage_metadata || null;
}

function contentPartToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentPartToText).join('');
  if (value && typeof value === 'object') {
    const v = value as { text?: string; content?: string };
    if (typeof v.text === 'string') return v.text;
    if (typeof v.content === 'string') return v.content;
  }
  return '';
}

function appendChoiceContent(choice: any, contentParts: string[]): void {
  const candidates = [choice?.delta?.content, choice?.message?.content, choice?.text];
  for (const candidate of candidates) {
    const text = contentPartToText(candidate);
    if (text) {
      contentParts.push(text);
      return;
    }
  }
}

function extractContentFromResponseData(responseData: any): string {
  const choices = Array.isArray(responseData?.choices) ? responseData.choices : [];
  return choices
    .flatMap((choice: any) => {
      const parts: string[] = [];
      appendChoiceContent(choice, parts);
      return parts;
    })
    .join('')
    .trim();
}

function createStreamResponseData(content: string, usage: any) {
  return { stream: true, choices: [{ message: { content } }], usage };
}

function createSseResponseCollector() {
  let buffer = '';
  let usage: any = null;
  const contentParts: string[] = [];

  function processLine(line: string) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const payload = JSON.parse(data);
      const nextUsage = extractUsageFromPayload(payload);
      if (nextUsage) usage = nextUsage;
      const choices = Array.isArray(payload?.choices) ? payload.choices : [];
      choices.forEach((choice: any) => appendChoiceContent(choice, contentParts));
    } catch {
      /* 单行解析失败不影响流式转发 */
    }
  }

  return {
    push(text: string) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(processLine);
    },
    flush() {
      if (buffer.trim()) {
        buffer.split(/\r?\n/).forEach(processLine);
      }
      buffer = '';
      const content = contentParts.join('').trim();
      return { content, responseData: createStreamResponseData(content, usage), usage };
    },
  };
}

interface UsageStreamOptions {
  onChunk?: () => void;
  onActivity?: (event: AgentActivityEvent) => void;
  onDone?: () => void;
  onCancel?: (reason: unknown) => void;
  onError?: (error: unknown) => void;
}

function createUsageCapturingStream(
  source: ReadableStream<Uint8Array> | null,
  onDone: (capture: { content: string; responseData: any; usage: any }) => unknown,
  options: UsageStreamOptions = {},
): ReadableStream<Uint8Array> | null {
  if (!source?.getReader) return source;
  const reader = source.getReader();
  const decoder = new TextDecoder('utf-8');
  const collector = createSseResponseCollector();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          collector.push(decoder.decode());
          await Promise.resolve(onDone(collector.flush()));
          options.onDone?.();
          controller.close();
          return;
        }
        if (value) {
          options.onChunk?.();
          options.onActivity?.({
            stage: 'model_stream',
            message: '',
            source: 'proxy.stream.chunk',
            visible: false,
            activity: true,
            meta: { bytes: value.byteLength || value.length || 0 },
          });
          collector.push(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        }
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    },
    async cancel(reason) {
      options.onCancel?.(reason);
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
}

function getOpenCodeAiLogTitle(requestBody: ProxyRequestBody | undefined): string {
  return requestBody?.logTitle || requestBody?.log_title || 'OpenCode Agent';
}

function getRequestMode(requestBody: ProxyRequestBody | undefined): string {
  return requestBody?.stream ? 'stream' : 'normal';
}

function safeWriteOpenCodeAiLog(config: AgentAiConfig | null, payload: any): void {
  try {
    writeAiLog(null, config, payload);
  } catch {
    /* OpenCode 代理日志仅用于开发排查 */
  }
}

function recordOpenCodeAiSuccess(params: {
  config: AgentAiConfig;
  requestId: string;
  requestBody: ProxyRequestBody;
  response: Response;
  responseData: any;
  content: string;
  usage: any;
  startedAt: number;
  stream: boolean;
  attempt: number;
  diagnostics?: AgentProxyDiagnostics;
}) {
  const { config, requestId, requestBody, response, responseData, content, usage, startedAt, stream, attempt, diagnostics } = params;
  const normalizedUsage = normalizeTokenUsage(usage);
  safeWriteOpenCodeAiLog(config, {
    request_id: requestId,
    log_title: getOpenCodeAiLogTitle(requestBody),
    type: 'chat',
    request_mode: getRequestMode(requestBody),
    url: `${trimBaseUrl(config.base_url)}/chat/completions`,
    request: requestBody,
    response: responseData,
    content: content || '',
    created_at: new Date().toISOString(),
  });
  appendProxyDiagnostic(diagnostics, 'proxy.upstream.completed', {
    request_id: requestId,
    attempt,
    duration_ms: Date.now() - startedAt,
    status: response.status,
    content_type: response.headers.get('content-type') || '',
    upstream_request_id: response.headers.get('x-request-id') || '',
    stream,
    request: summarizeRequestBody(requestBody),
    response: summarizeResponseData(responseData, content),
    usage: normalizedUsage,
  });
}

function recordOpenCodeAiFailure(params: {
  config: AgentAiConfig;
  requestId: string;
  requestBody: ProxyRequestBody;
  error: unknown;
  responseData: any;
  startedAt: number;
  attempt: number;
  diagnostics?: AgentProxyDiagnostics;
}) {
  const { config, requestId, requestBody, error, responseData, startedAt, attempt, diagnostics } = params;
  const errorMessage = safeErrorMessage(error);
  safeWriteOpenCodeAiLog(config, {
    request_id: requestId,
    log_title: getOpenCodeAiLogTitle(requestBody),
    type: 'chat-error',
    request_mode: getRequestMode(requestBody),
    url: `${trimBaseUrl(config.base_url)}/chat/completions`,
    request: requestBody,
    response: getAiErrorLogResponse(error, responseData || null),
    error: getAiErrorLogError(error, errorMessage),
    created_at: new Date().toISOString(),
  });
  appendProxyDiagnostic(diagnostics, 'proxy.upstream.failed', {
    request_id: requestId,
    attempt,
    duration_ms: Date.now() - startedAt,
    request: summarizeRequestBody(requestBody),
    error: summarizeProxyError(error),
    response_excerpt: String(responseData || (error as any)?.raw_response_body || '').slice(0, 2000),
  });
}

async function prepareProxyResponse(params: {
  config: AgentAiConfig;
  requestId: string;
  requestBody: ProxyRequestBody;
  response: Response;
  startedAt: number;
  attempt: number;
  diagnostics?: AgentProxyDiagnostics;
  onActivity?: (event: AgentActivityEvent) => void;
  activityContext: AgentProxyActivityContext | null;
  streamTimeout: { touch?: () => void; clear?: () => void } | null;
}): Promise<Response> {
  const { config, requestId, requestBody, response, startedAt, attempt, diagnostics, onActivity, activityContext, streamTimeout } = params;
  const stream = Boolean(requestBody.stream);
  const contentType = response.headers.get('content-type') || '';
  const isSse = stream || contentType.toLowerCase().includes('text/event-stream');

  if (isSse) {
    const body = createUsageCapturingStream(
      response.body,
      (capture) => {
        recordOpenCodeAiSuccess({
          config,
          requestId,
          requestBody,
          response,
          responseData: capture.responseData,
          content: capture.content,
          usage: capture.usage,
          startedAt,
          stream: true,
          attempt,
          diagnostics,
        });
        emitProxyActivity(onActivity, activityContext, {
          stage: 'model_stream',
          message: '',
          source: 'proxy.upstream.completed',
          activity: true,
          meta: { request_id: requestId, attempt, stream: true },
        });
        streamTimeout?.clear?.();
      },
      {
        onChunk: () => streamTimeout?.touch?.(),
        onActivity: (event) =>
          emitProxyActivity(onActivity, activityContext, {
            ...event,
            meta: { ...(event.meta as Record<string, unknown> | undefined), request_id: requestId, attempt, stream: true },
          }),
        onDone: () => streamTimeout?.clear?.(),
        onCancel: () => streamTimeout?.clear?.(),
        onError: (error) => {
          streamTimeout?.clear?.();
          emitProxyActivity(onActivity, activityContext, {
            stage: 'model_request',
            message: safeErrorMessage(error),
            source: 'proxy.upstream.failed',
            activity: true,
            meta: { request_id: requestId, attempt, error: safeErrorMessage(error) },
          });
        },
      },
    );
    return new Response(body, {
      status: response.status,
      headers: responseHeadersFromUpstream(response, 'text/event-stream; charset=utf-8'),
    });
  }

  const rawText = await response.text();
  let responseData: any = null;
  try {
    responseData = rawText ? JSON.parse(rawText) : null;
  } catch {
    responseData = rawText;
  }
  const usage = extractUsageFromPayload(responseData);
  const content = responseData && typeof responseData === 'object' ? extractContentFromResponseData(responseData) : '';
  recordOpenCodeAiSuccess({
    config,
    requestId,
    requestBody,
    response,
    responseData,
    content,
    usage,
    startedAt,
    stream: false,
    attempt,
    diagnostics,
  });
  emitProxyActivity(onActivity, activityContext, {
    stage: 'model_request',
    message: '',
    source: 'proxy.upstream.completed',
    activity: true,
    meta: { request_id: requestId, attempt, stream: false },
  });
  return new Response(rawText, {
    status: response.status,
    headers: responseHeadersFromUpstream(response, 'application/json; charset=utf-8'),
  });
}

async function requestOpenCodeChatCompletion(params: {
  loadConfig: () => AgentAiConfig | null;
  textQueue: ReturnType<typeof createOpenCodeTextQueue>;
  openAiBody: ProxyRequestBody;
  signal: AbortSignal;
  timeoutMs: number;
  diagnostics?: AgentProxyDiagnostics;
  onActivity?: (event: AgentActivityEvent) => void;
  activityContext: AgentProxyActivityContext | null;
}): Promise<Response> {
  const { loadConfig, textQueue, openAiBody, signal, timeoutMs, diagnostics, onActivity, activityContext } = params;
  const requestId = createAiRequestId();
  let queuedConfig: AgentAiConfig | null = null;
  try {
    queuedConfig = loadConfig();
  } catch {
    /* ignore */
  }
  appendProxyDiagnostic(diagnostics, 'proxy.chat.queued', {
    request_id: requestId,
    config: summarizeProxyConfig(queuedConfig),
    request: summarizeRequestBody(openAiBody),
  });
  emitProxyActivity(onActivity, activityContext, {
    stage: 'model_request',
    message: '',
    source: 'proxy.chat.queued',
    meta: { request_id: requestId },
  });

  return textQueue.enqueue(async () => {
    const config = loadConfig();
    assertTextModelConfig(config);
    const requestBody = normalizeOpenCodeProxyRequestBody(config, openAiBody);

    return runWithAiRetry(
      async ({ attempt }) => {
        const stream = Boolean(requestBody.stream);
        const timeout = stream
          ? createIdleTimeoutController(signal, timeoutMs, 'AI 流式响应长时间无数据')
          : createTimeoutSignal(signal, timeoutMs);
        const startedAt = Date.now();
        let streamHandedOff = false;
        try {
          appendProxyDiagnostic(diagnostics, 'proxy.upstream.started', {
            request_id: requestId,
            attempt,
            timeout_ms: timeoutMs,
            config: summarizeProxyConfig(config),
            request: summarizeRequestBody(requestBody),
          });
          emitProxyActivity(onActivity, activityContext, {
            stage: 'model_request',
            message: '',
            source: 'proxy.upstream.started',
            activity: true,
            meta: { request_id: requestId, attempt },
          });
          safeWriteOpenCodeAiLog(config, {
            request_id: requestId,
            log_title: getOpenCodeAiLogTitle(requestBody),
            type: 'chat-pending',
            request_mode: getRequestMode(requestBody),
            url: `${trimBaseUrl(config.base_url)}/chat/completions`,
            request: requestBody,
            status: 'pending',
            created_at: new Date().toISOString(),
          });

          const response = await fetch(`${trimBaseUrl(config.base_url)}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.api_key}`,
            },
            body: JSON.stringify(requestBody),
            signal: timeout.signal,
          });

          appendProxyDiagnostic(diagnostics, 'proxy.upstream.headers', {
            request_id: requestId,
            attempt,
            duration_ms: Date.now() - startedAt,
            status: response.status,
            ok: response.ok,
            content_type: response.headers.get('content-type') || '',
            upstream_request_id: response.headers.get('x-request-id') || '',
          });
          timeout.touch?.();
          emitProxyActivity(onActivity, activityContext, {
            stage: 'model_request',
            message: '',
            source: 'proxy.upstream.headers',
            activity: true,
            meta: { request_id: requestId, attempt, status: response.status },
          });

          if (!response.ok) {
            throw await createUpstreamError(response);
          }

          const proxyResponse = await prepareProxyResponse({
            config,
            requestId,
            requestBody,
            response,
            startedAt,
            attempt,
            diagnostics,
            onActivity,
            activityContext,
            streamTimeout: stream ? timeout : null,
          });
          streamHandedOff = stream;
          return proxyResponse;
        } catch (error) {
          recordOpenCodeAiFailure({
            config,
            requestId,
            requestBody,
            error,
            responseData: null,
            startedAt,
            attempt,
            diagnostics,
          });
          emitProxyActivity(onActivity, activityContext, {
            stage: 'model_request',
            message: safeErrorMessage(error),
            source: 'proxy.upstream.failed',
            activity: true,
            meta: { request_id: requestId, attempt, error: safeErrorMessage(error) },
          });
          throw error;
        } finally {
          if (!stream || !streamHandedOff) {
            timeout.clear();
          }
        }
      },
      { signal },
    );
  }, { signal });
}

function copyUpstreamHeaders(upstream: Response, res: ServerResponse): void {
  for (const name of ['content-type', 'cache-control', 'x-request-id']) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

async function pipeWebStreamToNode(
  webStream: ReadableStream<Uint8Array> | null,
  res: ServerResponse,
): Promise<void> {
  if (!webStream?.getReader) {
    res.end();
    return;
  }
  const reader = webStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function bindAbortToRequestLifecycle(params: {
  req: IncomingMessage;
  res: ServerResponse;
  controller: AbortController;
  diagnostics?: AgentProxyDiagnostics;
  onActivity?: (event: AgentActivityEvent) => void;
  activityContext: AgentProxyActivityContext | null;
}): void {
  const { req, res, controller, diagnostics, onActivity, activityContext } = params;
  req.on('aborted', () => {
    appendProxyDiagnostic(diagnostics, 'proxy.client.aborted', { path: req.url || '' });
    emitProxyActivity(onActivity, activityContext, {
      stage: 'model_request',
      message: 'Agent 模型请求已中止',
      source: 'proxy.client.aborted',
      activity: true,
      meta: { path: req.url || '' },
    });
    controller.abort(new Error('客户端请求已中止'));
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      appendProxyDiagnostic(diagnostics, 'proxy.client.closed', { path: req.url || '' });
      emitProxyActivity(onActivity, activityContext, {
        stage: 'model_request',
        message: 'Agent 模型连接已关闭',
        source: 'proxy.client.closed',
        activity: true,
        meta: { path: req.url || '' },
      });
      controller.abort(new Error('客户端连接已关闭'));
    }
  });
}

async function handleChatCompletions(params: {
  req: IncomingMessage;
  res: ServerResponse;
  loadConfig: () => AgentAiConfig | null;
  textQueue: ReturnType<typeof createOpenCodeTextQueue>;
  timeoutMs: number;
  diagnostics?: AgentProxyDiagnostics;
  onActivity?: (event: AgentActivityEvent) => void;
  getActivityContext?: () => AgentProxyActivityContext | null;
}): Promise<void> {
  const { req, res, loadConfig, textQueue, timeoutMs, diagnostics, onActivity, getActivityContext } = params;
  const controller = new AbortController();
  const requestBody = await readJson(req);
  const activityContext = getActivityContext?.() || null;
  bindAbortToRequestLifecycle({ req, res, controller, diagnostics, onActivity, activityContext });
  appendProxyDiagnostic(diagnostics, 'proxy.chat.received', { request: summarizeRequestBody(requestBody) });
  emitProxyActivity(onActivity, activityContext, {
    stage: 'model_request',
    message: '',
    source: 'proxy.chat.received',
    activity: true,
    meta: { request: summarizeRequestBody(requestBody) },
  });
  const upstream = await requestOpenCodeChatCompletion({
    loadConfig,
    textQueue,
    openAiBody: requestBody,
    signal: controller.signal,
    timeoutMs,
    diagnostics,
    onActivity,
    activityContext,
  });
  res.statusCode = upstream.status;
  copyUpstreamHeaders(upstream, res);
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', requestBody.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
  }
  await pipeWebStreamToNode(upstream.body, res);
}

function handleModels(res: ServerResponse): void {
  sendJson(res, 200, {
    object: 'list',
    data: [{ id: 'default', object: 'model', created: 0, owned_by: 'yibiao' }],
  });
}

// 并发小队列：限制同时打向上游的请求数（limit 来自平台 concurrency_limit，live 读取）。
// 队列内任务支持父 signal abort（removeQueuedJob），与 aiService 的 textRequestQueue 同构。
function createOpenCodeTextQueue(options: { defaultLimit?: number; getLimit?: () => number } = {}) {
  let activeCount = 0;
  const queue: Array<{
    runner: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    signal?: AbortSignal;
    started: boolean;
    cleanup: null | (() => void);
  }> = [];
  const getLimit = typeof options.getLimit === 'function' ? options.getLimit : () => options.defaultLimit || 10;
  const fallbackLimit = normalizeConcurrencyLimit(options.defaultLimit, 10);

  function currentLimit(): number {
    try {
      return normalizeConcurrencyLimit(getLimit(), fallbackLimit);
    } catch {
      return fallbackLimit;
    }
  }
  function removeQueuedJob(job: (typeof queue)[number]): boolean {
    const index = queue.indexOf(job);
    if (index >= 0) {
      queue.splice(index, 1);
      return true;
    }
    return false;
  }
  function getAbortReason(signal?: AbortSignal): Error {
    return (signal?.reason as Error) || new Error('OpenCode AI proxy 请求已取消');
  }
  function pump(): void {
    while (activeCount < currentLimit() && queue.length) {
      const job = queue.shift()!;
      if (job.signal?.aborted) {
        job.cleanup?.();
        job.reject(getAbortReason(job.signal));
        continue;
      }
      job.started = true;
      activeCount += 1;
      void runJob(job);
    }
  }
  async function runJob(job: (typeof queue)[number]): Promise<void> {
    try {
      job.cleanup?.();
      job.resolve(await job.runner());
    } catch (error) {
      job.reject(error);
    } finally {
      activeCount = Math.max(0, activeCount - 1);
      pump();
    }
  }
  function enqueue<T>(runner: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = options.signal;
      if (signal?.aborted) {
        reject(getAbortReason(signal));
        return;
      }
      const job = {
        runner: runner as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject: reject as (e: unknown) => void,
        signal,
        started: false,
        cleanup: null as null | (() => void),
      };
      if (signal) {
        const onAbort = () => {
          if (!job.started && removeQueuedJob(job)) {
            job.cleanup?.();
            reject(getAbortReason(signal));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        job.cleanup = () => {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            /* ignore */
          }
        };
      }
      queue.push(job);
      pump();
    });
  }
  return {
    enqueue,
    getStatus() {
      return { active: activeCount, queued: queue.length, limit: currentLimit() };
    },
    clearQueued(reason?: Error) {
      while (queue.length) {
        const job = queue.shift()!;
        job.cleanup?.();
        job.reject(reason || new Error('Agent proxy 队列已清空'));
      }
    },
  };
}

export interface CreateAiProxyOptions {
  loadConfig: () => AgentAiConfig | null;
  timeoutMs?: number | string;
  diagnostics?: AgentProxyDiagnostics;
  onActivity?: (event: AgentActivityEvent) => void;
  getActivityContext?: () => AgentProxyActivityContext | null;
}

export function createAiServiceOpenAiProxy(options: CreateAiProxyOptions): AgentProxyHandle {
  const token = createProxyToken();
  const upstreamTimeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const sockets = new Set<import('node:net').Socket>();
  let closing = false;
  const textQueue = createOpenCodeTextQueue({
    defaultLimit: 10,
    getLimit() {
      return options.loadConfig()?.concurrency_limit || 10;
    },
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      appendProxyDiagnostic(options.diagnostics, 'proxy.http.received', {
        method: req.method || '',
        path: url.pathname,
        authorized: url.pathname === '/health' ? true : isAuthorized(req, token),
      });

      if (url.pathname === '/health') {
        sendJson(res, closing ? 503 : 200, { ok: !closing });
        return;
      }
      if (closing) {
        sendJson(res, 503, { error: { message: 'Agent proxy 正在关闭', type: 'closing' } });
        return;
      }
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: { message: 'Unauthorized', type: 'unauthorized' } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        appendProxyDiagnostic(options.diagnostics, 'proxy.models.returned', {});
        handleModels(res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await handleChatCompletions({
          req,
          res,
          loadConfig: options.loadConfig,
          textQueue,
          timeoutMs: upstreamTimeoutMs,
          diagnostics: options.diagnostics,
          onActivity: options.onActivity,
          getActivityContext: options.getActivityContext,
        });
        return;
      }
      sendJson(res, 404, { error: { message: `Not found: ${req.method} ${url.pathname}`, type: 'not_found' } });
    } catch (error) {
      // best-effort 广播（无 projectId 时静默不发；agent 任务错误主要经 runTask 返回传播给 runner）
      emitAiHttpError(error);
      appendProxyDiagnostic(options.diagnostics, 'proxy.http.failed', {
        method: req.method || '',
        path: req.url || '',
        error: summarizeProxyError(error),
      });
      const statusCode = (error as any)?.statusCode || (error as any)?.status || 500;
      if (!res.headersSent) {
        sendJson(res, statusCode, {
          error: { message: (error as Error)?.message || 'OpenCode AI proxy failed', type: 'proxy_error' },
        });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });

  server.headersTimeout = upstreamTimeoutMs + SERVER_TIMEOUT_BUFFER_MS;
  server.requestTimeout = upstreamTimeoutMs + SERVER_TIMEOUT_BUFFER_MS;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    token,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('OpenCode AI proxy 启动失败：无法获取监听端口');
      }
      appendProxyDiagnostic(options.diagnostics, 'proxy.started', {
        port: address.port,
        base_url: `http://127.0.0.1:${address.port}`,
        timeout_ms: upstreamTimeoutMs,
      });
      return { token, port: address.port, baseUrl: `http://127.0.0.1:${address.port}` };
    },
    getStatus() {
      return textQueue.getStatus();
    },
    async close(closeOptions: { forceAfterMs?: number } = {}) {
      closing = true;
      textQueue.clearQueued(new Error('Agent proxy 正在关闭'));
      const forceAfterMs = closeOptions.forceAfterMs ?? 2000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) {
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
          }
          resolve();
        }, forceAfterMs);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
