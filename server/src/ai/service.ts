// 忠实移植自 client/electron/services/aiService.cjs。
// Web 版差异：
//  - app 对象降级为 { getVersion: () => 'web' }（不再有 Electron app/paths）。
//  - writeAiLog 改为 no-op（dev-mode 落盘延后到 P8）。
//  - textTokenStatsStore 改为内存 no-op（dev-mode token 统计延后）。
//  - emitAiHttpErrorToWindows → 进程内订阅者（M1-P6 SSE 总线 fan-out）。
//  - 生图（generateImage/saveGeneratedImage/downloadImage）延后到 M1-P5，此处不移植。
//  - chat/requestJson 内部仍按 config.request_mode 走上游流式，但对外返回聚合后的完整字符串/JSON（与桌面 IPC 一致）。
import { runWithAiRetry, markAiRequestError, copyAiRequestErrorMeta } from './retry';
import {
  copyAiHttpError,
  createAiHttpErrorFromResponse,
  emitAiHttpError,
} from './httpError';
import { createAiRequestQueue } from './requestQueue';
import { getLiveTextRequestQueueLimit } from '../config/store';
import { createHash } from 'node:crypto';
import { classifyDiagnosticError } from '../ai-diagnostics/classify';
import { summarizeResponseShape } from '../ai-diagnostics/sanitize';
import {
  createAiRequestId,
  getAiErrorLogError,
  getAiErrorLogResponse,
  resolveAiLogTitle,
  writeAiLog,
} from './log';

const AI_REQUEST_TIMEOUT_MS = 600000;
const IMAGE_MODEL_TEST_TIMEOUT_MESSAGE = '生图模型测试超时，请检查 Base URL、API Key 或模型名称';
const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const ANALYTICS_PROJECT_NAME = 'yibiao-client';

const STUB_APP = { getVersion: () => 'web' };

const OPENAI_IMAGE_PROVIDER_META: Record<string, { label: string; defaultBaseUrl: string; logProvider: string; modelLabel: string }> = {
  jinlong: { label: '金龙中转站', defaultBaseUrl: 'https://img-api.jlaudeapi.com/v1', logProvider: 'jinlong', modelLabel: '生图模型名称' },
  volcengine: { label: '火山方舟', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', logProvider: 'volcengine', modelLabel: '模型名称或推理接入点 ID' },
  agnes: { label: 'Agnes AI', defaultBaseUrl: 'https://apihub.agnes-ai.com/v1', logProvider: 'agnes', modelLabel: '生图模型名称' },
  custom: { label: '自定义生图服务', defaultBaseUrl: '', logProvider: 'custom', modelLabel: '生图模型名称' },
};

function trimBaseUrl(baseUrl: any): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function requireBaseUrl(baseUrl: any, message: string): string {
  const trimmed = trimBaseUrl(baseUrl);
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
}

function isResponseFormatUnsupported(message: any): boolean {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('response_format') && [
    'not supported', 'does not support', 'not support', 'unsupported',
    'unknown parameter', 'invalid parameter', 'must be',
  ].some((marker) => normalized.includes(marker));
}

function normalizeTokenNumber(value: any): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeCachedTokenNumber(source: any): number {
  const promptDetails = source?.prompt_tokens_details || source?.promptTokensDetails || source?.input_token_details || source?.inputTokenDetails || {};
  return normalizeTokenNumber(
    source?.cached_tokens ?? source?.cachedTokens ?? source?.prompt_cached_tokens ?? source?.promptCachedTokens
    ?? source?.prompt_cache_hit_tokens ?? source?.promptCacheHitTokens ?? source?.cache_read_input_tokens
    ?? source?.cacheReadInputTokens ?? source?.cached_content_token_count ?? source?.cachedContentTokenCount
    ?? promptDetails.cached_tokens ?? promptDetails.cachedTokens ?? promptDetails.cache_read ?? promptDetails.cacheRead
    ?? promptDetails.cache_read_input_tokens ?? promptDetails.cacheReadInputTokens,
  );
}

function normalizeTokenUsage(usage: any) {
  const source = usage || {};
  const promptTokens = normalizeTokenNumber(source.prompt_tokens ?? source.promptTokens ?? source.promptTokenCount);
  const completionTokens = normalizeTokenNumber(
    source.completion_tokens ?? source.completionTokens ?? source.completionTokenCount ?? source.candidatesTokenCount,
  );
  const totalTokens = normalizeTokenNumber(source.total_tokens ?? source.totalTokens ?? source.totalTokenCount) || promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_tokens: normalizeCachedTokenNumber(source),
  };
}

function extractOpenAIUsage(responseData: any) {
  return normalizeTokenUsage(responseData?.usage);
}

function extractGoogleUsage(responseData: any) {
  return normalizeTokenUsage(responseData?.usageMetadata || responseData?.usage_metadata);
}

function normalizeRequestTimeoutMs(request: any): number {
  const timeoutMs = Number(request?.timeout_ms);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : AI_REQUEST_TIMEOUT_MS;
}

function normalizeTextRequestMode(config: any): 'stream' | 'normal' {
  return config?.request_mode === 'normal' ? 'normal' : 'stream';
}

function normalizeImageRequestMode(imageConfig: any): 'stream' | 'normal' {
  return imageConfig?.request_mode === 'normal' ? 'normal' : 'stream';
}

function normalizeOpenAICompatibleImageSize(imageConfig: any, requestSize?: any): string {
  const size = String(requestSize || imageConfig?.image_size || '1024x1024').trim();
  return size || '1024x1024';
}

function normalizeGoogleImageSize(imageConfig: any): string {
  const size = String(imageConfig?.image_size || '1K').trim();
  return size || '1K';
}

function createAbortError(): Error {
  const error: any = new Error('AI 请求超时');
  error.name = 'AbortError';
  return markAiRequestError(error, { retryable: true });
}

function createOperationTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(createAbortError());
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });
  return {
    signal: controller.signal,
    run<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, timeoutPromise]) as Promise<T>;
    },
    clear() {
      controller.abort();
    },
  };
}

async function runWithOperationTimeout<T>(runner: (signal: AbortSignal) => Promise<T>, timeoutMs = AI_REQUEST_TIMEOUT_MS): Promise<T> {
  const timeout = createOperationTimeout(timeoutMs);
  try {
    return await timeout.run(runner(timeout.signal));
  } finally {
    timeout.clear();
  }
}

function createHeaders(apiKey: any) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function normalizeAnalyticsEndpointHost(baseUrl: any): string {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) return '';
  const candidates = rawValue.includes('://') ? [rawValue] : [`https://${rawValue}`];
  for (const candidate of candidates) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      // 尝试下一个候选格式。
    }
  }
  return '';
}

// 分析上报：best-effort，失败静默。app.getVersion 在 Web 取 'web'。
function trackAiRequest(app: any, config: any, payload: any): void {
  void Promise.resolve()
    .then(() => {
      const imageConfig = config.image_model || {};
      const requestType = payload.ai_request_type || '';
      const tokenUsage = normalizeTokenUsage(payload.usage);
      const modelProvider = requestType === 'image' ? imageConfig.provider || '' : config.text_model_provider || '';
      const modelBaseUrl = requestType === 'image' ? imageConfig.base_url || '' : config.base_url || '';
      const modelEndpointHost = normalizeAnalyticsEndpointHost(modelBaseUrl);
      const modelName = requestType === 'image' ? imageConfig.model_name || '' : config.model_name || '';
      const body = {
        projectName: ANALYTICS_PROJECT_NAME,
        event: 'ai_request',
        version: typeof app?.getVersion === 'function' ? app.getVersion() : '',
        platform: process.platform,
        arch: process.arch,
        client_id: config.analytics_client_id || '',
        client_created_at: config.analytics_created_at || '',
        ai_request_type: requestType,
        ai_model_provider: modelProvider,
        ai_model_base_url: modelEndpointHost,
        ai_model_name: modelName,
        prompt_tokens: tokenUsage.prompt_tokens,
        completion_tokens: tokenUsage.completion_tokens,
        total_tokens: tokenUsage.total_tokens,
        text_model_name: requestType === 'text' ? modelName : '',
        image_model_name: requestType === 'image' ? modelName : '',
      };
      return fetch(ANALYTICS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    })
    .catch(() => undefined);
}

// dev-mode token 统计：Web 版暂 no-op（P8 接入服务端存储后恢复）。
function recordTextTokenStats(_config: any, _usage: any): void { /* no-op */ }

function safeImageResponse(data: any): any {
  return {
    ...data,
    data: Array.isArray(data?.data)
      ? data.data.map((item: any) => ({ ...item, b64_json: item.b64_json ? '[base64 omitted]' : item.b64_json }))
      : data?.data,
    candidates: Array.isArray(data?.candidates) ? '[candidates omitted]' : data?.candidates,
  };
}

function copyRawAiErrorResponse(source: any, target: any): any {
  for (const key of ['raw_response_body', 'raw_response_payload', 'raw_response_data', 'raw_sse_data']) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) {
      target[key] = source[key];
    }
  }
  return copyAiHttpError(source, target);
}

function createAiResponseDataError(message: string, responseData: any): Error {
  const error: any = new Error(message);
  error.raw_response_data = responseData;
  return error;
}

async function ensureOk(response: any, fallbackMessage: string, options: { source?: string } = {}): Promise<void> {
  if (response.ok) return;
  throw await createAiHttpErrorFromResponse(response, fallbackMessage, { source: options.source || 'ai-service' });
}

// ---------- JSON 解析/修复（requestJson 用） ----------

function extractJsonContent(content: any): string {
  const normalized = String(content || '').trim();
  if (!normalized.startsWith('```')) return normalized;
  const lines = normalized.split(/\r?\n/);
  const firstLine = (lines[0] || '').trim().toLowerCase();
  const lastLine = (lines[lines.length - 1] || '').trim();
  if ((firstLine === '```' || firstLine === '```json') && lastLine.startsWith('```')) {
    return lines.slice(1, -1).join('\n').trim();
  }
  return normalized;
}

function extractFencedJsonBlocks(content: any): string[] {
  const blocks: string[] = [];
  const normalized = String(content || '').trim();
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = fenceRegex.exec(normalized);
  while (match) {
    const block = String(match[1] || '').trim();
    if (block) blocks.push(block);
    match = fenceRegex.exec(normalized);
  }
  return blocks;
}

function extractBalancedJsonCandidates(content: any): string[] {
  const text = String(content || '');
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const firstChar = text[start];
    if (firstChar !== '{' && firstChar !== '[') continue;
    const stack = [firstChar];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) { escaped = false; }
        else if (char === '\\') { escaped = true; }
        else if (char === '"') { inString = false; }
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{' || char === '[') { stack.push(char); continue; }
      if (char === '}' || char === ']') {
        const expectedOpen = char === '}' ? '{' : '[';
        if (stack[stack.length - 1] !== expectedOpen) break;
        stack.pop();
        if (!stack.length) {
          const candidate = text.slice(start, index + 1).trim();
          if (candidate) candidates.push(candidate);
          start = index;
          break;
        }
      }
    }
  }
  return candidates;
}

const jsonEscapeChars = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const markdownEscapeChars = new Set(['.', '(', ')', '[', ']', '{', '}', '#', '*', '+', '-', '_', '!', '<', '>', '|', '`']);

function repairInvalidJsonStringEscapes(content: any): string {
  const text = String(content || '');
  let output = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (char === '"') { output += char; inString = false; continue; }
    if (char !== '\\') { output += char; continue; }
    const nextChar = text[index + 1] || '';
    if (!nextChar) { output += '\\\\'; continue; }
    if (nextChar === 'u') {
      const unicodeDigits = text.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
        output += text.slice(index, index + 6);
        index += 5;
      } else {
        output += '\\\\';
      }
      continue;
    }
    if (jsonEscapeChars.has(nextChar)) { output += char + nextChar; index += 1; continue; }
    if (markdownEscapeChars.has(nextChar)) { output += nextChar; index += 1; continue; }
    output += '\\\\';
  }
  return output;
}

export function parseJsonContent(content: any): any {
  const normalized = String(content || '').replace(/^﻿/, '').trim();
  const candidates = [normalized, extractJsonContent(normalized), ...extractFencedJsonBlocks(normalized)].filter(Boolean);
  const withBalancedCandidates: string[] = [];
  for (const candidate of candidates) {
    withBalancedCandidates.push(candidate);
    withBalancedCandidates.push(...extractBalancedJsonCandidates(candidate));
  }
  const repairedCandidates: string[] = [];
  for (const candidate of withBalancedCandidates) {
    const repaired = repairInvalidJsonStringEscapes(candidate);
    if (repaired !== candidate) repairedCandidates.push(repaired);
  }
  const uniqueCandidates = [...new Set([...withBalancedCandidates, ...repairedCandidates].map((item) => item.trim()).filter(Boolean))];
  let lastError: any = null;
  for (const candidate of uniqueCandidates) {
    try {
      return JSON.parse(candidate);
    } catch (error: any) {
      lastError = error;
    }
  }
  throw lastError || new Error('AI 返回内容为空，无法解析 JSON');
}

function formatJsonIssues(error: any): string[] {
  if (error instanceof SyntaxError) return [`JSON 语法错误：${error.message}`];
  return [error?.message || String(error || '字段校验失败')];
}

function buildJsonRepairMessages(invalidContent: any, issues: string[], targetDescription: any): any[] {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    { role: 'system', content: `你是一个严格的 JSON 修复助手。请根据给出的原始内容和校验问题，修复现有结果。

要求：
1. 优先在原结果基础上做最小必要修改，不要整体重写
2. 尽量保留原有结构、字段值、节点顺序和已生成内容
3. 若缺少必填字段，应结合现有上下文补齐合理内容，不要用空字符串敷衍
4. 若存在多余说明、代码块包裹、字段名错误、children 结构不规范或顶层包裹错误，应修正为合法 JSON
5. 必须修复 JSON 字符串中的非法反斜杠转义，例如将 1\\. 改为 1.，或将必须保留的反斜杠写成 \\\\
6. 只返回修复后的完整 JSON，不要输出任何解释` },
    { role: 'user', content: `目标结果类型：${targetDescription}` },
    { role: 'user', content: `当前校验问题：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
    { role: 'user', content: '请在保留原有正确内容的前提下，仅修复上述问题，并返回完整 JSON。' },
  ];
}

async function emitProgress(progressCallback: any, message: string): Promise<void> {
  if (!progressCallback) return;
  await Promise.resolve(progressCallback(message));
}

function normalizeJsonPayload(request: any, parsed: any): any {
  const normalized = request.normalizer ? request.normalizer(parsed) : parsed;
  if (request.validator) {
    request.validator(normalized);
  }
  return normalized;
}

function diagnosticRequestMeta(request: any, phase: 'primary' | 'repair', attemptNo: number) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const requestChars = messages.reduce((sum: number, item: any) => sum + String(item?.content || '').length, 0);
  const requestHash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  return {
    phase,
    attemptNo,
    messageCount: messages.length,
    messageRoles: messages.map((item: any) => String(item?.role || 'unknown')),
    requestChars,
    requestHash,
  };
}

async function processDiagnosticJson(request: any, content: any, attemptId?: string): Promise<any> {
  const reporter = request?.diagnostic?.reporter;
  const stage = async (value: string, patch: any = {}) => {
    if (reporter && attemptId) await reporter.recordAttemptStage(attemptId, value, patch);
  };
  let parsed: any;
  try {
    await stage('parse', { responseChars: String(content ?? '').length });
    parsed = parseJsonContent(content);
  } catch (error: any) {
    error.diagnosticIssue = classifyDiagnosticError(error, 'parse');
    throw error;
  }
  let normalized: any;
  try {
    await stage('normalize', { responseShape: summarizeResponseShape(parsed) });
    normalized = request.normalizer ? request.normalizer(parsed) : parsed;
  } catch (error: any) {
    error.diagnosticIssue = classifyDiagnosticError(error, 'normalize');
    throw error;
  }
  try {
    await stage('validate', { responseShape: summarizeResponseShape(normalized) });
    if (request.validator) request.validator(normalized);
    return normalized;
  } catch (error: any) {
    error.diagnosticIssue = classifyDiagnosticError(error, 'validate');
    throw error;
  }
}

function attachDiagnosticError(error: any, request: any, issue: any): any {
  error.diagnosticTraceId = request?.diagnostic?.context?.traceId;
  error.diagnosticCode = issue?.code;
  error.diagnosticStage = issue?.stage;
  error.diagnosticIssues = issue ? [issue] : [];
  return error;
}

// ---------- 文本 chat ----------

function createChatRequestBody(config: any, request: any, options: { stream?: boolean; omitResponseFormat?: boolean } = {}): any {
  const body: any = { model: config.model_name, messages: request.messages };
  if (options.stream) body.stream = true;
  if (request.response_format && !options.omitResponseFormat) {
    body.response_format = request.response_format;
  }
  return body;
}

async function fetchChatCompletion(_app: any, config: any, body: any, options: { signal?: AbortSignal } = {}): Promise<any> {
  const controller = options.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS) : null;
  const baseUrl = requireBaseUrl(config.base_url, '请先在设置中配置文本模型 Base URL');
  try {
    return await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: createHeaders(config.api_key),
      body: JSON.stringify(body),
      signal: (options.signal || (controller?.signal as AbortSignal | undefined)) as any,
    });
  } catch (error: any) {
    throw markAiRequestError(error, { retryable: true });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureTextAiResponseOk(response: any, fallbackMessage: string): Promise<void> {
  if (response.ok) return;
  throw await createAiHttpErrorFromResponse(response, fallbackMessage, {
    source: 'text-model',
    responseFormatUnsupportedChecker: isResponseFormatUnsupported,
  });
}

function appendStreamChoiceContent(choice: any, contentParts: string[]): void {
  const deltaContent = choice?.delta?.content;
  const messageContent = choice?.message?.content;
  const textContent = choice?.text;
  if (typeof deltaContent === 'string') { contentParts.push(deltaContent); return; }
  if (typeof messageContent === 'string') { contentParts.push(messageContent); return; }
  if (typeof textContent === 'string') { contentParts.push(textContent); }
}

function normalizeStreamPayloadError(error: any, fallbackMessage: string): string {
  if (!error) return fallbackMessage;
  if (typeof error === 'string') return error;
  return error.message || error.code || fallbackMessage;
}

async function readSseJsonDataLine(line: string, state: any, options: any): Promise<void> {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
  const data = trimmed.slice(5).trim();
  if (!data) return;
  if (data === '[DONE]') { state.done = true; return; }
  let payload: any = null;
  try {
    payload = JSON.parse(data);
  } catch (error: any) {
    const parseError: any = new Error(`${options.parseErrorMessage || 'AI 流式响应解析失败'}：${error.message}`);
    parseError.raw_response_body = data;
    throw markAiRequestError(parseError, { retryable: true });
  }
  if (payload?.error && options.throwOnPayloadError !== false) {
    const streamError: any = new Error(normalizeStreamPayloadError(payload.error, options.failureMessage || 'AI 流式请求失败'));
    streamError.raw_response_payload = payload;
    streamError.raw_sse_data = data;
    throw markAiRequestError(streamError, { retryable: true });
  }
  await Promise.resolve(options.onPayload?.(payload));
}

async function readSseJsonStream(response: any, options: any = {}): Promise<void> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw markAiRequestError(new Error(options.unreadableMessage || 'AI 流式响应不可读'), { retryable: true });
  }
  const decoder = new TextDecoder('utf-8');
  const state = { done: false };
  let buffer = '';
  while (!state.done) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      await readSseJsonDataLine(line, state, options);
      if (state.done) break;
    }
  }
  buffer += decoder.decode();
  if (!state.done && buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      await readSseJsonDataLine(line, state, options);
      if (state.done) break;
    }
  }
}

async function readOpenAIChatStream(response: any): Promise<{ content: string; usage: any; responseData: any }> {
  const state = { usage: null as any, contentParts: [] as string[] };
  await readSseJsonStream(response, {
    unreadableMessage: 'AI 流式响应不可读',
    parseErrorMessage: 'AI 流式响应解析失败',
    failureMessage: 'AI 流式请求失败',
    onPayload(payload: any) {
      if (payload?.usage) state.usage = payload.usage;
      const choices = Array.isArray(payload?.choices) ? payload.choices : [];
      choices.forEach((choice: any) => appendStreamChoiceContent(choice, state.contentParts));
    },
  });
  const content = state.contentParts.join('');
  return { content, usage: state.usage, responseData: { stream: true, choices: [{ message: { content } }], usage: state.usage } };
}

async function requestTextAiNormal(app: any, config: any, requestBody: any, options: { signal?: AbortSignal }) {
  const response = await fetchChatCompletion(app, config, requestBody, { signal: options.signal });
  await ensureTextAiResponseOk(response, 'AI 请求失败');
  let responseData: any = null;
  try {
    responseData = await response.json();
  } catch (error: any) {
    throw markAiRequestError(error, { retryable: true });
  }
  return {
    content: responseData.choices?.[0]?.message?.content || '',
    usage: extractOpenAIUsage(responseData),
    responseData,
  };
}

async function requestTextAiStream(app: any, config: any, requestBody: any, options: { signal?: AbortSignal }) {
  const response = await fetchChatCompletion(app, config, requestBody, { signal: options.signal });
  await ensureTextAiResponseOk(response, 'AI 请求失败');
  return readOpenAIChatStream(response);
}

async function requestTextAi(app: any, config: any, requestBody: any, options: { signal?: AbortSignal; requestMode: 'stream' | 'normal' }) {
  if (options.requestMode === 'stream') return requestTextAiStream(app, config, requestBody, options);
  return requestTextAiNormal(app, config, requestBody, options);
}

async function chatWithConfig(app: any, config: any, request: any): Promise<string> {
  if (!config.api_key) throw new Error('请先在设置中配置文本模型 API Key');
  if (!config.model_name) throw new Error('请先在设置中配置文本模型名称');
  requireBaseUrl(config.base_url, '请先在设置中配置文本模型 Base URL');

  const requestId = createAiRequestId();
  const logTitle = resolveAiLogTitle(request, '文本请求');
  const requestMode = normalizeTextRequestMode(config);
  let requestBody = createChatRequestBody(config, request, { stream: requestMode === 'stream' });
  let responseData: any = null;
  let errorMessage = '';
  let analyticsTracked = false;
  const timeoutMs = normalizeRequestTimeoutMs(request);

  try {
    writeAiLog(app, config, {
      request_id: requestId, log_title: logTitle, type: 'chat-pending', request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`, request: requestBody, status: 'pending', created_at: new Date().toISOString(),
    });
    const result = await runWithAiRetry(() => runWithOperationTimeout(async (signal) => {
      try {
        return await requestTextAi(app, config, requestBody, { signal, requestMode });
      } catch (error: any) {
        if (!request.response_format || !error.responseFormatUnsupported) throw error;
        requestBody = createChatRequestBody(config, request, { omitResponseFormat: true, stream: requestMode === 'stream' });
        return requestTextAi(app, config, requestBody, { signal, requestMode });
      }
    }, timeoutMs));

    responseData = result.responseData;
    recordTextTokenStats(config, result.usage);
    trackAiRequest(app, config, { ai_request_type: 'text', usage: result.usage });
    analyticsTracked = true;
    const content = result.content || '';
    writeAiLog(app, config, {
      request_id: requestId, log_title: logTitle, type: 'chat', request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`, request: requestBody, response: responseData, content, created_at: new Date().toISOString(),
    });
    return content;
  } catch (error: any) {
    errorMessage = error.name === 'AbortError' ? request.timeout_message || `AI 请求超时（${timeoutMs / 1000} 秒）` : error.message;
    if (!analyticsTracked) {
      recordTextTokenStats(config, null);
      trackAiRequest(app, config, { ai_request_type: 'text' });
      analyticsTracked = true;
    }
    writeAiLog(app, config, {
      request_id: requestId, log_title: logTitle, type: 'chat-error', request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`, request: requestBody,
      response: getAiErrorLogResponse(error, responseData), error: getAiErrorLogError(error, errorMessage), created_at: new Date().toISOString(),
    });
    const wrappedError: any = new Error(errorMessage || 'AI 请求失败');
    if (error.status || error.statusCode) {
      wrappedError.status = error.status || error.statusCode;
      wrappedError.statusCode = error.status || error.statusCode;
    }
    copyRawAiErrorResponse(error, wrappedError);
    copyAiRequestErrorMeta(error, wrappedError);
    markAiRequestError(wrappedError, { retryable: false });
    emitAiHttpError(wrappedError, {}, { projectId: config?.__sseProjectId });
    throw wrappedError;
  }
}

// ---------- requestJson（带重试 + 修复） ----------

async function repairJsonResponse(app: any, config: any, invalidContent: any, issues: string[], temperature: number, responseFormat: any, progressCallback: any, progressLabel: string, repairMessagesBuilder: any, logTitle: string, chat = chatWithConfig): Promise<string> {
  await emitProgress(progressCallback, `${progressLabel}格式校验失败，正在基于当前结果进行修复。`);
  return chat(app, config, {
    messages: repairMessagesBuilder ? repairMessagesBuilder({ invalidContent, issues, progressLabel }) : buildJsonRepairMessages(invalidContent, issues, progressLabel),
    temperature,
    response_format: responseFormat,
    logTitle: logTitle ? `${logTitle}修复` : `${progressLabel}修复`,
  });
}

async function parseOrRepairJsonResponseWithConfig(app: any, config: any, request: any, content: any, chat = chatWithConfig): Promise<any> {
  const temperature = request.temperature ?? 0.7;
  const responseFormat = request.response_format || { type: 'json_object' };
  const progressLabel = request.progressLabel || 'JSON结果';
  const failureMessage = request.failureMessage || '模型返回的 JSON 数据格式无效';
  const logTitle = resolveAiLogTitle(request, progressLabel);
  const reporter = request?.diagnostic?.reporter;
  const traceId = request?.diagnostic?.context?.traceId;
  const primaryId = reporter && traceId
    ? await reporter.startAttempt(traceId, diagnosticRequestMeta(request, 'primary', 1))
    : undefined;
  try {
    const value = await processDiagnosticJson(request, content, primaryId);
    if (reporter && primaryId) await reporter.completeAttempt(primaryId, { responseChars: String(content ?? '').length, responseShape: summarizeResponseShape(value) });
    return value;
  } catch (error: any) {
    const issue = error.diagnosticIssue || classifyDiagnosticError(error, 'parse');
    if (reporter && primaryId && traceId) await reporter.failAttempt(traceId, primaryId, issue, content);
    const issues = formatJsonIssues(error);
    const repairMessages = request.repairMessagesBuilder
      ? request.repairMessagesBuilder({ invalidContent: content, issues, progressLabel })
      : buildJsonRepairMessages(content, issues, progressLabel);
    const repairId = reporter && traceId
      ? await reporter.startAttempt(traceId, diagnosticRequestMeta({ messages: repairMessages }, 'repair', 1))
      : undefined;
    let repairedContent: any;
    try {
      repairedContent = await repairJsonResponse(app, config, content, issues, temperature, responseFormat, request.progressCallback, progressLabel, () => repairMessages, logTitle, chat);
      const value = await processDiagnosticJson(request, repairedContent, repairId);
      if (reporter && repairId) await reporter.completeAttempt(repairId, { responseChars: String(repairedContent ?? '').length, responseShape: summarizeResponseShape(value) });
      return value;
    } catch (repairError: any) {
      const repairIssue = repairError.diagnosticIssue || classifyDiagnosticError(repairError, 'repair');
      if (reporter && repairId && traceId) await reporter.failAttempt(traceId, repairId, repairIssue, repairedContent ?? repairError?.raw_response_body);
      throw attachDiagnosticError(new Error(failureMessage), request, repairIssue);
    }
  }
}

export function parseOrRepairJsonResponseWithConfigForTest(app: any, config: any, request: any, content: any, chat: any): Promise<any> {
  return parseOrRepairJsonResponseWithConfig(app, config, request, content, chat);
}

async function collectJsonResponseWithConfig(app: any, config: any, request: any, chat = chatWithConfig): Promise<any> {
  const maxRetries = request.max_retries ?? 2;
  const totalAttempts = maxRetries + 1;
  const temperature = request.temperature ?? 0.7;
  const responseFormat = request.response_format || { type: 'json_object' };
  const progressLabel = request.progressLabel || 'JSON结果';
  const failureMessage = request.failureMessage || '模型返回的 JSON 数据格式无效';
  const logTitle = resolveAiLogTitle(request, progressLabel);
  let lastError: any = null;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const reporter = request?.diagnostic?.reporter;
    const traceId = request?.diagnostic?.context?.traceId;
    const primaryId = reporter && traceId
      ? await reporter.startAttempt(traceId, diagnosticRequestMeta(request, 'primary', attempt + 1))
      : undefined;
    let content: any;
    try {
      content = await chat(app, config, {
        messages: request.messages, temperature, response_format: responseFormat,
        timeout_ms: request.timeout_ms, timeout_message: request.timeout_message, logTitle,
      });
    } catch (requestError: any) {
      const requestIssue = classifyDiagnosticError(requestError, 'request');
      if (reporter && primaryId && traceId) await reporter.failAttempt(traceId, primaryId, requestIssue, requestError?.raw_response_body);
      throw attachDiagnosticError(requestError, request, requestIssue);
    }
    try {
      if (reporter && primaryId) await reporter.recordAttemptStage(primaryId, 'response', { responseChars: String(content ?? '').length });
      const value = await processDiagnosticJson(request, content, primaryId);
      if (reporter && primaryId) await reporter.completeAttempt(primaryId, { responseChars: String(content ?? '').length, responseShape: summarizeResponseShape(value) });
      return value;
    } catch (error: any) {
      lastError = error;
      const issue = error.diagnosticIssue || classifyDiagnosticError(error, 'parse');
      if (reporter && primaryId && traceId) await reporter.failAttempt(traceId, primaryId, issue, content);
      const issues = formatJsonIssues(error);
      const repairMessages = request.repairMessagesBuilder
        ? request.repairMessagesBuilder({ invalidContent: content, issues, progressLabel })
        : buildJsonRepairMessages(content, issues, progressLabel);
      const repairId = reporter && traceId
        ? await reporter.startAttempt(traceId, diagnosticRequestMeta({ messages: repairMessages }, 'repair', attempt + 1))
        : undefined;
      let repairedContent: any;
      try {
        repairedContent = await repairJsonResponse(app, config, content, issues, temperature, responseFormat, request.progressCallback, progressLabel, () => repairMessages, logTitle, chat);
        if (reporter && repairId) await reporter.recordAttemptStage(repairId, 'response', { responseChars: String(repairedContent ?? '').length });
        const value = await processDiagnosticJson(request, repairedContent, repairId);
        if (reporter && repairId) await reporter.completeAttempt(repairId, { responseChars: String(repairedContent ?? '').length, responseShape: summarizeResponseShape(value) });
        return value;
      } catch (repairError: any) {
        lastError = repairError;
        const repairIssue = repairError.diagnosticIssue || classifyDiagnosticError(repairError, 'repair');
        if (reporter && repairId && traceId) await reporter.failAttempt(traceId, repairId, repairIssue, repairedContent ?? repairError?.raw_response_body);
        if (attempt === maxRetries) {
          await emitProgress(request.progressCallback, `${progressLabel}连续 ${totalAttempts} 次校验失败。`);
          throw attachDiagnosticError(new Error(failureMessage), request, repairIssue);
        }
        await emitProgress(request.progressCallback, `${progressLabel}第 ${attempt + 1}/${totalAttempts} 次校验失败，正在重试。`);
      }
    }
  }
  throw attachDiagnosticError(new Error(lastError?.message || failureMessage), request, lastError?.diagnosticIssue);
}

export function collectJsonResponseWithConfigForTest(app: any, config: any, request: any, chat: any): Promise<any> {
  return collectJsonResponseWithConfig(app, config, request, chat);
}

// ---------- listModels ----------

export async function listModelsWithConfig(config: any): Promise<{ success: boolean; message: string; models: string[] }> {
  if (!config.api_key) return { success: false, message: '请先填写文本模型 API Key', models: [] };
  if (!trimBaseUrl(config.base_url)) return { success: false, message: '请先填写文本模型 Base URL', models: [] };
  let data: any = null;
  try {
    data = await runWithAiRetry(async () => {
      let response: any = null;
      try {
        response = await fetch(`${trimBaseUrl(config.base_url)}/models`, { method: 'GET', headers: createHeaders(config.api_key) });
      } catch (error: any) {
        throw markAiRequestError(error, { retryable: true });
      }
      await ensureOk(response, '获取模型列表失败');
      try {
        return await response.json();
      } catch (error: any) {
        throw markAiRequestError(error, { retryable: true });
      }
    });
  } catch (error: any) {
    emitAiHttpError(error, {}, { projectId: config?.__sseProjectId });
    throw error;
  }
  return {
    success: true,
    message: '模型列表已更新',
    models: Array.isArray(data?.data) ? data.data.map((item: any) => item.id).filter(Boolean) : [],
  };
}

// ---------- testImageModel ----------

async function fetchOpenAICompatibleImageResponse(baseUrl: string, apiKey: any, requestBody: any, fallbackMessage: string, options: { signal?: AbortSignal; source?: string } = {}): Promise<any> {
  const sendRequest = async (body: any) => {
    try {
      return await fetch(`${baseUrl}/images/generations`, {
        method: 'POST', headers: createHeaders(apiKey), body: JSON.stringify(body), signal: options.signal as any,
      });
    } catch (error: any) {
      throw markAiRequestError(error, { retryable: true });
    }
  };
  const response = await sendRequest(requestBody);
  if (response.ok) return response;
  const error = await createAiHttpErrorFromResponse(response, fallbackMessage, {
    source: options.source || 'openai-compatible-image-model',
    responseFormatUnsupportedChecker: isResponseFormatUnsupported,
  });
  if (requestBody.response_format && (error as any).responseFormatUnsupported) {
    const retryBody = { ...requestBody };
    delete retryBody.response_format;
    const retryResponse = await sendRequest(retryBody);
    await ensureOk(retryResponse, fallbackMessage, { source: options.source || 'openai-compatible-image-model' });
    return retryResponse;
  }
  throw error;
}

function appendOpenAICompatibleImageItem(state: any, item: any): void {
  const url = String(item?.url || '');
  const b64Json = String(item?.b64_json || '');
  if (!url && !b64Json) return;
  state.images.push({ ...item, url, b64_json: b64Json, mime_type: item?.mime_type || item?.mimeType || 'image/png' });
}

function appendOpenAICompatibleImageError(state: any, payload: any): void {
  state.errors.push({
    image_index: payload?.image_index, code: payload?.error?.code || '',
    message: normalizeStreamPayloadError(payload?.error, '图片生成失败'), raw_payload: payload,
  });
}

function appendOpenAICompatibleImagePayload(payload: any, state: any): void {
  if (payload?.usage) state.usage = payload.usage;
  if (payload?.error && payload?.type !== 'image_generation.completed' && payload?.type !== 'image_generation.partial_failed') {
    appendOpenAICompatibleImageError(state, payload); return;
  }
  if (payload?.type === 'image_generation.completed') {
    state.completed = payload;
    if (payload.usage) state.usage = payload.usage;
    if (Array.isArray(payload?.data)) payload.data.forEach((item: any) => appendOpenAICompatibleImageItem(state, item));
    else appendOpenAICompatibleImageItem(state, payload);
    if (payload.error) appendOpenAICompatibleImageError(state, payload);
    return;
  }
  if (payload?.type === 'image_generation.partial_failed') { appendOpenAICompatibleImageError(state, payload); return; }
  if (payload?.type === 'image_generation.partial_succeeded') { appendOpenAICompatibleImageItem(state, payload); return; }
  if (Array.isArray(payload?.data)) { payload.data.forEach((item: any) => appendOpenAICompatibleImageItem(state, item)); return; }
  appendOpenAICompatibleImageItem(state, payload);
}

async function readOpenAICompatibleImageStream(response: any) {
  const state = { images: [] as any[], errors: [] as any[], completed: null as any, usage: null as any };
  await readSseJsonStream(response, {
    unreadableMessage: '生图流式响应不可读', parseErrorMessage: '生图流式响应解析失败', failureMessage: '生图流式请求失败', throwOnPayloadError: false,
    onPayload(payload: any) { appendOpenAICompatibleImagePayload(payload, state); },
  });
  return { stream: true, data: state.images, errors: state.errors, completed: state.completed, usage: state.usage };
}

async function requestOpenAICompatibleImageData(baseUrl: string, apiKey: any, requestBody: any, fallbackMessage: string, options: { signal?: AbortSignal; source?: string } = {}): Promise<any> {
  const response = await fetchOpenAICompatibleImageResponse(baseUrl, apiKey, requestBody, fallbackMessage, options);
  if (requestBody.stream) return readOpenAICompatibleImageStream(response);
  try { return await response.json(); } catch (error: any) { throw markAiRequestError(error, { retryable: true }); }
}

function getOpenAICompatibleImageFailureMessage(responseData: any, fallbackMessage: string): string {
  const firstError = Array.isArray(responseData?.errors) ? responseData.errors.find((item: any) => item?.message) : null;
  return firstError?.message || fallbackMessage;
}

async function testOpenAICompatibleImageModel(app: any, config: any, provider: string): Promise<any> {
  const imageConfig = config.image_model || {};
  const meta = OPENAI_IMAGE_PROVIDER_META[provider] || OPENAI_IMAGE_PROVIDER_META.volcengine;
  let responseData: any = null;
  let analyticsTracked = false;
  if (!imageConfig.api_key) throw new Error(`请先填写${meta.label} API Key`);
  if (!imageConfig.model_name) throw new Error(`请先填写${meta.label}${meta.modelLabel}`);
  const baseUrl = requireBaseUrl(imageConfig.base_url, `${meta.label} Base URL 缺失，请重新选择服务商后保存配置`);
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestId = createAiRequestId();
  const logTitle = `AI生图测试-${meta.label}`;
  const requestBody: any = {
    model: imageConfig.model_name, prompt: '大字报，内容是“金盾AI老好了”',
    size: normalizeOpenAICompatibleImageSize(imageConfig), response_format: 'url',
    ...(requestMode === 'stream' ? { stream: true } : {}),
  };
  try {
    writeAiLog(app, config, { request_id: requestId, log_title: logTitle, type: 'image-test-pending', provider: meta.logProvider, request_mode: requestMode, url: `${baseUrl}/images/generations`, request: requestBody, status: 'pending', created_at: new Date().toISOString() });
    try {
      responseData = await runWithAiRetry(() => runWithOperationTimeout(
        (signal) => requestOpenAICompatibleImageData(baseUrl, imageConfig.api_key, requestBody, `${meta.label}生图测试失败`, { signal }),
        AI_REQUEST_TIMEOUT_MS,
      ));
    } catch (error: any) {
      const message = error.message || '';
      if (message.includes('does not exist') || message.includes('do not have access')) {
        throw copyRawAiErrorResponse(error, new Error(`${meta.label}生图模型不可用，请确认${meta.modelLabel}已开通并可访问。原始错误：${message}`));
      }
      throw error;
    }
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractOpenAIUsage(responseData) });
    analyticsTracked = true;
    const firstImage = responseData.data?.[0] || {};
    const imageUrl = firstImage.url || '';
    const imageData = firstImage.b64_json || '';
    if (!imageUrl && !imageData) {
      throw createAiResponseDataError(getOpenAICompatibleImageFailureMessage(responseData, `${meta.label}生图测试未返回图片数据`), responseData);
    }
    writeAiLog(app, config, { request_id: requestId, log_title: logTitle, type: 'image-test', provider: meta.logProvider, request_mode: requestMode, request: requestBody, response: safeImageResponse(responseData), result: { image_url: imageUrl, image_data: imageData ? '[base64 omitted]' : '', mime_type: 'image/png' }, created_at: new Date().toISOString() });
    return { success: true, message: imageUrl ? `测试成功：已生成图片 ${imageUrl}` : '测试成功：已返回生图结果', image_url: imageUrl, image_data: imageData, mime_type: 'image/png' };
  } catch (error: any) {
    if (!analyticsTracked) trackAiRequest(app, config, { ai_request_type: 'image' });
    const errorMessage = error?.name === 'AbortError' ? IMAGE_MODEL_TEST_TIMEOUT_MESSAGE : error?.message || '生图模型测试失败';
    writeAiLog(app, config, { request_id: requestId, log_title: logTitle, type: 'image-test-error', provider: meta.logProvider, request_mode: requestMode, request: requestBody, response: getAiErrorLogResponse(error, responseData ? safeImageResponse(responseData) : null), error: getAiErrorLogError(error, errorMessage), created_at: new Date().toISOString() });
    const wrappedError = copyRawAiErrorResponse(error, new Error(errorMessage));
    emitAiHttpError(wrappedError, {}, { projectId: config?.__sseProjectId });
    throw wrappedError;
  }
}

// Google AI Studio 生图测试
function createGoogleImageRequestBody(prompt: string, imageSize: string): any {
  const generationConfig: any = { responseModalities: ['TEXT', 'IMAGE'] };
  const normalizedImageSize = String(imageSize || '').trim();
  if (normalizedImageSize) generationConfig.imageConfig = { imageSize: normalizedImageSize };
  return { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
}

function createGoogleImageUrl(baseUrl: string, modelName: string, requestMode: 'stream' | 'normal'): string {
  const action = requestMode === 'stream' ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${baseUrl}/models/${encodeURIComponent(modelName)}:${action}`;
}

function createGoogleHeaders(apiKey: any): any {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
}

function extractGoogleCandidateParts(responseData: any): any[] {
  const candidates = Array.isArray(responseData?.candidates) ? responseData.candidates : [];
  return candidates.flatMap((candidate: any) => (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []));
}

function appendGoogleImagePayload(payload: any, state: any): void {
  if (payload?.usageMetadata || payload?.usage_metadata) state.usageMetadata = payload.usageMetadata || payload.usage_metadata;
  state.parts.push(...extractGoogleCandidateParts(payload));
}

async function readGoogleImageStream(response: any) {
  const state = { parts: [] as any[], usageMetadata: null as any };
  await readSseJsonStream(response, {
    unreadableMessage: '生图流式响应不可读', parseErrorMessage: '生图流式响应解析失败', failureMessage: 'Google AI Studio 生图流式请求失败',
    onPayload(payload: any) { appendGoogleImagePayload(payload, state); },
  });
  return { stream: true, candidates: [{ content: { parts: state.parts } }], usageMetadata: state.usageMetadata };
}

async function requestGoogleImageData(baseUrl: string, imageConfig: any, requestBody: any, requestMode: 'stream' | 'normal', fallbackMessage: string, options: { signal?: AbortSignal } = {}): Promise<any> {
  let response: any = null;
  try {
    response = await fetch(createGoogleImageUrl(baseUrl, imageConfig.model_name, requestMode), {
      method: 'POST', headers: createGoogleHeaders(imageConfig.api_key), body: JSON.stringify(requestBody), signal: options.signal as any,
    });
  } catch (error: any) {
    throw markAiRequestError(error, { retryable: true });
  }
  await ensureOk(response, fallbackMessage, { source: 'google-image-model' });
  if (requestMode === 'stream') return readGoogleImageStream(response);
  try { return await response.json(); } catch (error: any) { throw markAiRequestError(error, { retryable: true }); }
}

function getGoogleImageInlineData(responseData: any): any {
  const imagePart = extractGoogleCandidateParts(responseData).find((part: any) => part.inlineData?.data || part.inline_data?.data);
  return imagePart?.inlineData || imagePart?.inline_data || null;
}

function getGoogleText(responseData: any): string {
  return extractGoogleCandidateParts(responseData).map((part: any) => part.text || '').filter(Boolean).join('').trim();
}

async function testGoogleImageModel(app: any, config: any): Promise<any> {
  const imageConfig = config.image_model || {};
  let analyticsTracked = false;
  if (!imageConfig.api_key) throw new Error('请先填写 Google AI Studio API Key');
  if (!imageConfig.model_name) throw new Error('请先填写 Google 生图模型名称');
  const baseUrl = requireBaseUrl(imageConfig.base_url, 'Google AI Studio Base URL 缺失，请重新选择服务商后保存配置');
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestId = createAiRequestId();
  const logTitle = 'AI生图测试-Google AI Studio';
  const requestBody = createGoogleImageRequestBody('大字报，内容是“金盾AI老好了”', normalizeGoogleImageSize(imageConfig));
  const url = createGoogleImageUrl(baseUrl, imageConfig.model_name, requestMode);
  let responseData: any = null;
  try {
    writeAiLog(app, config, { request_id: requestId, log_title: logTitle, type: 'image-test-pending', provider: 'google-ai-studio', request_mode: requestMode, url, request: requestBody, status: 'pending', created_at: new Date().toISOString() });
    responseData = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => requestGoogleImageData(baseUrl, imageConfig, requestBody, requestMode, 'Google AI Studio 生图测试失败', { signal }),
      AI_REQUEST_TIMEOUT_MS,
    ));
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractGoogleUsage(responseData) });
    analyticsTracked = true;
    const text = getGoogleText(responseData);
    const inlineData = getGoogleImageInlineData(responseData);
    if (!inlineData?.data) throw createAiResponseDataError('Google AI Studio 生图测试未返回图片数据', responseData);
    writeAiLog(app, config, { request_id: requestId, log_title: logTitle, type: 'image-test', provider: 'google-ai-studio', request_mode: requestMode, request: requestBody, response: safeImageResponse(responseData), result: { image_data: '[base64 omitted]', mime_type: inlineData?.mimeType || inlineData?.mime_type || 'image/png' }, created_at: new Date().toISOString() });
    return { success: true, message: `测试成功：已返回图片${text ? `，${text}` : ''}`, image_data: inlineData.data, mime_type: inlineData?.mimeType || inlineData?.mime_type || 'image/png' };
  } catch (error: any) {
    if (!analyticsTracked) trackAiRequest(app, config, { ai_request_type: 'image' });
    const errorMessage = error?.name === 'AbortError' ? IMAGE_MODEL_TEST_TIMEOUT_MESSAGE : error?.message || '生图模型测试失败';
    writeAiLog(app, config, { request_id: requestId, log_title: logTitle, type: 'image-test-error', provider: 'google-ai-studio', request_mode: requestMode, request: requestBody, response: getAiErrorLogResponse(error, responseData ? safeImageResponse(responseData) : null), error: getAiErrorLogError(error, errorMessage), created_at: new Date().toISOString() });
    const wrappedError = copyRawAiErrorResponse(error, new Error(errorMessage));
    emitAiHttpError(wrappedError, {}, { projectId: config?.__sseProjectId });
    throw wrappedError;
  }
}

async function testImageModelWithConfig(app: any, config: any): Promise<any> {
  const provider = config.image_model?.provider;
  if (provider === 'jinlong' || provider === 'volcengine' || provider === 'agnes' || provider === 'custom') {
    return testOpenAICompatibleImageModel(app, config, provider);
  }
  if (provider === 'google-ai-studio') {
    return testGoogleImageModel(app, config);
  }
  throw new Error('当前服务商暂不支持测试');
}

// ---------- 工厂 ----------
// 队列进程内单例（所有用户共享上游并发池）；config 由路由按请求方 userId 经
// buildMerged 取真实 key 后显式传入——避免把单用户 config 焙进共享 service。
export interface AiService {
  chat: (config: any, request: any) => Promise<string>;
  requestJson: (config: any, request: any) => Promise<any>;
  collectJsonResponse: (config: any, request: any) => Promise<any>;
  parseJsonResponseContent: (config: any, request: any, content: any) => Promise<any>;
  listModels: (config: any) => Promise<{ success: boolean; message: string; models: string[] }>;
  testImageModel: (config: any) => Promise<any>;
  getTextQueueStatus: () => any;
  pauseQueueScope: (scopeId: string) => number;
  resumeQueueScope: (scopeId: string) => void;
}

// 进程内单例 aiService（路由复用，队列跨请求共享）。
let singleton: AiService | null = null;
export function getAiService(): AiService {
  if (singleton) return singleton;
  // 上游并发池上限：进程内单例、跨用户共享。默认 24（env AI_TEXT_QUEUE_LIMIT 可调）。
  // 单任务并发（contentConcurrency）默认 24 会吃满；多用户/多项目并发时共用此池。
  // getLimit 走 getLiveTextRequestQueueLimit：设置页改 text_request_queue_limit 后热生效，无需重启。
  const AI_TEXT_QUEUE_LIMIT = (() => {
    const raw = Number(process.env.AI_TEXT_QUEUE_LIMIT);
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 24;
  })();
  const textRequestQueue = createAiRequestQueue({ defaultLimit: AI_TEXT_QUEUE_LIMIT, getLimit: getLiveTextRequestQueueLimit });

  function getQueueScopeId(request: any): string {
    return String(request?.queueScopeId || request?.queue_scope_id || '').trim();
  }

  function enqueueTextRequest(request: any, runner: (ctx: { attempt: number; maxAttempts: number }) => Promise<any>): Promise<any> {
    return textRequestQueue.enqueue(runner, { scopeId: getQueueScopeId(request) });
  }

  singleton = {
    async chat(config: any, request: any): Promise<string> {
      return enqueueTextRequest(request, async () => chatWithConfig(STUB_APP, config, request));
    },
    async requestJson(config: any, request: any): Promise<any> {
      return enqueueTextRequest(request, async () => collectJsonResponseWithConfig(STUB_APP, config, request));
    },
    async collectJsonResponse(config: any, request: any): Promise<any> {
      return enqueueTextRequest(request, async () => collectJsonResponseWithConfig(STUB_APP, config, request));
    },
    async parseJsonResponseContent(config: any, request: any, content: any): Promise<any> {
      return enqueueTextRequest(request, async () => parseOrRepairJsonResponseWithConfig(STUB_APP, config, request, content));
    },
    async listModels(config: any): Promise<{ success: boolean; message: string; models: string[] }> {
      return listModelsWithConfig(config);
    },
    async testImageModel(config: any): Promise<any> {
      return testImageModelWithConfig(STUB_APP, config);
    },
    getTextQueueStatus() { return textRequestQueue.getStatus(); },
    pauseQueueScope(scopeId: string) { return textRequestQueue.pauseScope(scopeId); },
    resumeQueueScope(scopeId: string) { textRequestQueue.resumeScope(scopeId); },
  };
  return singleton;
}
