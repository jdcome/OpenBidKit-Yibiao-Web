// opencode sidecar HTTP 客户端（移植自桌面 client/electron/services/opencode/opencodeHttpClient.cjs）。
// 三类请求：POST /session（建会话）、POST /session/:id/message（发 prompt，长超时走 undici Agent）、
// GET /session/:id/diff（取文件改动）。Basic Auth 由 server.authHeader 携带。
// 仅 /message 用 undici dispatcher（headers/body 各 30min）——目录/正文生成可能耗时数十分钟。
// 其余请求走 global fetch（Node 22 内置 undici 已够）。

import { Agent, fetch as undiciFetch } from 'undici';
import type { AgentActivityEvent } from './types';

const AGENT_MESSAGE_HTTP_TIMEOUT_MS = 30 * 60 * 1000;
const agentMessageHttpDispatcher = new Agent({
  headersTimeout: AGENT_MESSAGE_HTTP_TIMEOUT_MS,
  bodyTimeout: AGENT_MESSAGE_HTTP_TIMEOUT_MS,
});

export interface OpenCodeHttpServer {
  baseUrl: string;
  authHeader: string;
  requestLog?: unknown[];
}

export interface HttpClientOptions {
  signal?: AbortSignal;
  onActivity?: (event: AgentActivityEvent) => void;
  agent?: string;
}

interface RequestJsonOptions extends HttpClientOptions {
  method?: string;
  stage?: string;
  successStage?: string;
  errorStage?: string;
  dispatcher?: Agent;
  body?: Record<string, unknown>;
}

function headers(server: OpenCodeHttpServer): Record<string, string> {
  return {
    Authorization: server.authHeader,
    'Content-Type': 'application/json',
  };
}

function errorCauseMessage(error: unknown): string {
  const cause = (error as { cause?: { message?: string; code?: string } } | null)?.cause;
  return cause?.message || cause?.code || '';
}

function appendRequestLog(server: OpenCodeHttpServer, payload: Record<string, unknown>): void {
  if (!Array.isArray(server?.requestLog)) return;
  server.requestLog.push({
    at: new Date().toISOString(),
    ...payload,
  });
  if (server.requestLog.length > 80) {
    server.requestLog.splice(0, server.requestLog.length - 80);
  }
}

function summarizeRequestBody(body: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const model = body.model as { providerID?: string; modelID?: string } | undefined;
  const parts = Array.isArray(body.parts) ? body.parts : [];
  return {
    title: body.title || '',
    agent: body.agent || '',
    model: model ? `${model.providerID || ''}/${model.modelID || ''}` : '',
    parts_count: parts.length,
    text_chars: parts.reduce(
      (total, part) =>
        total + ((part as { type?: string; text?: string })?.type === 'text' ? String((part as { text?: string }).text || '').length : 0),
      0,
    ),
  };
}

function summarizeResponseData(data: Record<string, unknown> | null): Record<string, unknown> {
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const info = data?.info as { status?: string } | undefined;
  const session = data?.session as { id?: string } | undefined;
  return {
    id: (data?.id as string) || (data?.sessionID as string) || (data?.session_id as string) || '',
    session_id: session?.id || (data?.sessionID as string) || (data?.session_id as string) || '',
    parts_count: parts.length,
    part_types: parts.map((part) => (part as { type?: string })?.type || '').filter(Boolean),
    text_chars: parts.reduce(
      (total, part) =>
        total + ((part as { type?: string; text?: string })?.type === 'text' ? String((part as { text?: string }).text || '').length : 0),
      0,
    ),
    info_status: info?.status || '',
  };
}

function emitHttpActivity(onActivity: HttpClientOptions['onActivity'], event: AgentActivityEvent): void {
  onActivity?.({
    ...event,
    source: 'opencode-http',
    visible: false,
    activity: false,
  });
}

async function readJsonResponse(response: Response, fallbackMessage: string): Promise<(Record<string, unknown> & { __rawLength?: number }) | null> {
  const raw = await response.text();
  let data: (Record<string, unknown> & { __rawLength?: number }) | null = null;
  try {
    data = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const errorData = data as { error?: { message?: string }; message?: string } | null;
    const message = errorData?.error?.message || errorData?.message || raw || fallbackMessage;
    const error = new Error(message) as Error & {
      openCodeResponseText?: string;
      openCodeResponseData?: unknown;
    };
    error.openCodeResponseText = raw;
    error.openCodeResponseData = data;
    throw error;
  }

  if (data && typeof data === 'object') {
    data.__rawLength = raw.length;
  }
  return data;
}

export async function requestJson(
  server: OpenCodeHttpServer,
  routePath: string,
  options: RequestJsonOptions = {},
): Promise<Record<string, unknown> | null> {
  const method = options.method || 'GET';
  const startedAt = Date.now();
  let response: Response | null = null;
  emitHttpActivity(options.onActivity, {
    stage: options.stage || 'opencode_request',
    message: '',
    meta: { route: routePath, method },
  });
  appendRequestLog(server, {
    route: routePath,
    method,
    status: 0,
    duration_ms: 0,
    ok: 'pending',
    request: summarizeRequestBody(options.body),
  });
  try {
    const fetchOptions: RequestInit & { dispatcher?: Agent } = {
      method,
      headers: headers(server),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    };
    if (options.dispatcher) {
      fetchOptions.dispatcher = options.dispatcher;
    }
    const fetchImpl = options.dispatcher ? undiciFetch : fetch;
    response = (await fetchImpl(`${server.baseUrl}${routePath}`, fetchOptions as RequestInit)) as Response;

    const data = await readJsonResponse(response, `OpenCode 请求失败：${routePath}`);
    emitHttpActivity(options.onActivity, {
      stage: options.successStage || options.stage || 'opencode_request',
      message: '',
      meta: { route: routePath, method, status: response.status },
    });
    appendRequestLog(server, {
      route: routePath,
      method,
      status: response.status,
      duration_ms: Date.now() - startedAt,
      ok: true,
      response: summarizeResponseData(data),
      response_raw_chars: data?.__rawLength || 0,
    });
    return data;
  } catch (error) {
    const err = error as Error & {
      openCodeRoute?: string;
      openCodeMethod?: string;
      openCodeBaseUrl?: string;
      openCodeStatus?: number;
      openCodeDurationMs?: number;
      openCodeCause?: string;
      openCodeResponseText?: string;
    };
    err.openCodeRoute = routePath;
    err.openCodeMethod = method;
    err.openCodeBaseUrl = server.baseUrl;
    err.openCodeStatus = response?.status || 0;
    err.openCodeDurationMs = Date.now() - startedAt;
    err.openCodeCause = errorCauseMessage(error);
    appendRequestLog(server, {
      route: routePath,
      method,
      status: response?.status || 0,
      duration_ms: err.openCodeDurationMs,
      ok: false,
      error: err.message || String(error),
      cause: err.openCodeCause,
      error_name: err.name || 'Error',
      aborted: Boolean(options.signal?.aborted),
      abort_reason: options.signal?.reason ? String(options.signal.reason) : '',
      response_excerpt: String(err.openCodeResponseText || '').slice(0, 2000),
      request: summarizeRequestBody(options.body),
    });
    emitHttpActivity(options.onActivity, {
      stage: options.errorStage || options.stage || 'opencode_request',
      message: err.message || String(error),
      meta: { route: routePath, method, status: response?.status || 0, error: err.message || String(error) },
    });
    throw error;
  }
}

export async function createSession(
  server: OpenCodeHttpServer,
  title: string,
  options: HttpClientOptions = {},
): Promise<Record<string, unknown>> {
  const data = await requestJson(server, '/session', {
    method: 'POST',
    signal: options.signal,
    onActivity: options.onActivity,
    stage: 'session',
    body: { title: title || 'Yibiao Agent Task' },
  });
  return data || {};
}

export async function sendPrompt(
  server: OpenCodeHttpServer,
  sessionId: string,
  prompt: string,
  options: HttpClientOptions = {},
): Promise<Record<string, unknown>> {
  const data = await requestJson(server, `/session/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    signal: options.signal,
    onActivity: options.onActivity,
    stage: 'message',
    dispatcher: agentMessageHttpDispatcher,
    body: {
      model: {
        providerID: 'yibiao',
        modelID: 'default',
      },
      agent: options.agent || 'build',
      parts: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    },
  });
  return data || {};
}

export async function getSessionDiff(
  server: OpenCodeHttpServer,
  sessionId: string,
  options: HttpClientOptions = {},
): Promise<unknown[]> {
  const data = await requestJson(server, `/session/${encodeURIComponent(sessionId)}/diff`, {
    signal: options.signal,
    onActivity: options.onActivity,
    stage: 'output',
  });
  return Array.isArray(data) ? data : [];
}

export function extractTextFromPromptResult(result: { parts?: Array<{ type?: string; text?: string }> } | null): string {
  const parts = Array.isArray(result?.parts) ? result.parts : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim();
}

export interface RunOpenCodeTaskResult {
  session: Record<string, unknown>;
  message: unknown;
  parts: Array<{ type?: string; text?: string }>;
  text: string;
  diff: unknown[];
}

export async function runOpenCodeTask(
  server: OpenCodeHttpServer,
  input: {
    title: string;
    prompt: string;
    signal?: AbortSignal;
    agent?: string;
    onActivity?: HttpClientOptions['onActivity'];
    onSessionCreated?: (session: Record<string, unknown>) => void;
  },
): Promise<RunOpenCodeTaskResult> {
  const { title, prompt, signal, agent, onActivity, onSessionCreated } = input;
  const session = await createSession(server, title, { signal, onActivity });
  onSessionCreated?.(session);
  const messageResult = (await sendPrompt(server, (session.id as string) || '', prompt, { signal, agent, onActivity })) as {
    info?: unknown;
    parts?: Array<{ type?: string; text?: string }>;
  } | null;
  const diff = await getSessionDiff(server, (session.id as string) || '', { signal, onActivity }).catch(() => []);

  return {
    session,
    message: messageResult?.info || null,
    parts: Array.isArray(messageResult?.parts) ? messageResult.parts : [],
    text: extractTextFromPromptResult(messageResult),
    diff: Array.isArray(diff) ? diff : [],
  };
}
