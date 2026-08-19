// opencode sidecar 启动器（移植自桌面 client/electron/services/opencode/opencodeServerRunner.cjs）。
// 职责：spawn opencode 二进制为 HTTP sidecar（serve --pure），启动 AI proxy，写入 opencode.json，
// 健康巡检（/global/health 250ms 轮询 30s），返回 sidecar handle。close = SIGTERM→2s→SIGKILL + 关 proxy。
//
// 与桌面差异：① 二进制路径由 YIBIAO_OPENCODE_BIN env 注入（桌面打包进 electron）；② 配置经
// loadConfig()（= getLiveAgentAiConfig）每请求 live 读，非 configStore 对象；③ 工具环境用系统 rg/fd/jq。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { getAgentCacheDir } from '../document/paths';
import { writeOpenCodeConfig, normalizeTimeoutMs as normalizeConfigTimeout } from './configFactory';
import { createAiServiceOpenAiProxy, type AgentProxyDiagnostics, type AgentProxyActivityContext } from './aiProxy';
import {
  ensureOpenCodeToolEnvironment,
  applyOpenCodeToolEnvironment,
  type OpenCodeToolEnvironment,
} from './toolEnvironment';
import type { AgentAiConfig } from '../config/store';
import type { AgentActivityEvent } from './types';

const MAX_STDIO_BUFFER = 20000;

export interface OpenCodeSidecarStageEvent {
  stage: string;
  status: 'running' | 'success' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

export type OpenCodeSidecarStageHandler = (event: OpenCodeSidecarStageEvent) => void;

export interface OpenCodeSidecarExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
}

export interface OpenCodeSidecar {
  baseUrl: string;
  authHeader: string;
  port: number;
  aiProxyBaseUrl: string;
  aiProxyPort: number;
  workspaceDir: string;
  runtimeRoot: string;
  pid: number;
  requestLog: unknown[];
  getStderrTail(size?: number): string;
  getStdoutTail(size?: number): string;
  getProxyStatus(): { active: number; queued: number; limit: number };
  close(): Promise<void>;
}

export interface StartOpenCodeSidecarOptions {
  binPath: string;
  runtimeRoot: string;
  workspaceDir: string;
  timeoutMs?: number | string;
  diagnostics?: AgentProxyDiagnostics;
  onStage?: OpenCodeSidecarStageHandler;
  onActivity?: (event: AgentActivityEvent) => void;
  getActivityContext?: () => AgentProxyActivityContext | null;
  onExit?: (info: OpenCodeSidecarExitInfo) => void;
  loadConfig: () => AgentAiConfig | null;
}

function createBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function ensureExecutable(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OpenCode binary 不存在：${filePath}`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o755);
    } catch {
      /* ignore */
    }
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('无法分配本地端口'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

// 最小化子进程 env：仅保留 PATH/系统目录/语言等运行必需变量，其余由 spawn 显式注入。
// 隔离 HOME/XDG 指向 sidecar 专用目录，避免污染服务器用户环境。
function buildMinimalChildEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  const keepKeys = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'ComSpec', 'PATHEXT'];
  const env: Record<string, string | undefined> = {};
  for (const key of keepKeys) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function createRingBuffer(limit = MAX_STDIO_BUFFER) {
  let value = '';
  return {
    push(chunk: Buffer | string) {
      value += String(chunk || '');
      if (value.length > limit) value = value.slice(-limit);
    },
    tail(size = 4000) {
      return value.slice(-size);
    },
  };
}

function emitStage(onStage: OpenCodeSidecarStageHandler | undefined, stage: string, status: 'running' | 'success' | 'error', message: string, meta: Record<string, unknown> = {}): void {
  try {
    onStage?.({ stage, status, message, meta });
  } catch {
    /* 自检阶段回调不能影响 sidecar 启动 */
  }
}

function getFetchCauseMessage(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  if (!cause) return '';
  return [cause.code, cause.message].filter(Boolean).join('：');
}

interface ChildState {
  spawnError: Error | null;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  healthPassed: boolean;
  meta: Record<string, unknown>;
}

function attachOpenCodeDiagnostics(error: unknown, meta: Record<string, unknown> = {}): Error {
  const err = error as Error & Record<string, unknown>;
  if (!err || typeof err !== 'object') return err;
  const stderrBuffer = meta.stderrBuffer as { tail?: (n?: number) => string } | undefined;
  const stdoutBuffer = meta.stdoutBuffer as { tail?: (n?: number) => string } | undefined;
  err.openCodeBinaryPath = meta.opencodeBin || err.openCodeBinaryPath || '';
  err.openCodeWorkspaceDir = meta.workspaceDir || err.openCodeWorkspaceDir || '';
  err.openCodeRuntimeRoot = meta.runtimeRoot || err.openCodeRuntimeRoot || '';
  err.openCodeBaseUrl = meta.baseUrl || err.openCodeBaseUrl || '';
  err.openCodePort = meta.port || err.openCodePort || 0;
  const exitInfo = meta.exitInfo as { code?: number | null; signal?: NodeJS.Signals | null } | undefined;
  err.openCodeExitCode = exitInfo?.code ?? err.openCodeExitCode;
  err.openCodeExitSignal = exitInfo?.signal || err.openCodeExitSignal || '';
  const spawnError = meta.spawnError as Error | undefined;
  err.openCodeSpawnError = spawnError?.message || err.openCodeSpawnError || '';
  err.openCodeStderrTail = stderrBuffer?.tail?.(8000) || (err.openCodeStderrTail as string | undefined) || '';
  err.openCodeStdoutTail = stdoutBuffer?.tail?.(8000) || (err.openCodeStdoutTail as string | undefined) || '';
  const lastError = meta.lastError as Error | undefined;
  err.openCodeLastHealthError = lastError?.message || err.openCodeLastHealthError || '';
  err.openCodeLastHealthCause = getFetchCauseMessage(lastError) || err.openCodeLastHealthCause || '';
  return err;
}

function createOpenCodeStartError(message: string, meta: Record<string, unknown> = {}): Error {
  const stderrBuffer = meta.stderrBuffer as { tail?: (n?: number) => string } | undefined;
  const stdoutBuffer = meta.stdoutBuffer as { tail?: (n?: number) => string } | undefined;
  const details: string[] = [];
  const cause = getFetchCauseMessage(meta.lastError);
  const lastError = meta.lastError as Error | undefined;
  if (lastError?.message) details.push(`lastError: ${lastError.message}${cause ? ` (${cause})` : ''}`);
  const exitInfo = meta.exitInfo as { code?: number | null; signal?: NodeJS.Signals | null } | undefined;
  if (exitInfo) details.push(`exit: code=${exitInfo.code ?? 'null'} signal=${exitInfo.signal || 'null'}`);
  const spawnError = meta.spawnError as Error | undefined;
  if (spawnError?.message) details.push(`spawnError: ${spawnError.message}`);
  const stdoutTail = stdoutBuffer?.tail?.(4000) || '';
  const stderrTail = stderrBuffer?.tail?.(4000) || '';
  if (stdoutTail) details.push(`stdout:\n${stdoutTail}`);
  if (stderrTail) details.push(`stderr:\n${stderrTail}`);
  const error = new Error(`${message}${details.length ? `\n${details.join('\n')}` : ''}`);
  return attachOpenCodeDiagnostics(error, meta);
}

async function waitForOpenCodeHealth(params: {
  baseUrl: string;
  authHeader: string;
  childState: ChildState;
  timeoutMs?: number;
}): Promise<boolean> {
  const { baseUrl, authHeader, childState } = params;
  const timeoutMs = params.timeoutMs ?? 30000;
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (childState.spawnError) {
      throw createOpenCodeStartError('OpenCode Server 启动失败：无法启动 OpenCode 进程', {
        ...childState.meta,
        spawnError: childState.spawnError,
        lastError,
      });
    }
    if (childState.exitInfo) {
      throw createOpenCodeStartError('OpenCode Server 启动失败：OpenCode 进程在健康检查通过前退出', {
        ...childState.meta,
        exitInfo: childState.exitInfo,
        lastError,
      });
    }
    try {
      const response = await fetch(`${baseUrl}/global/health`, { headers: { Authorization: authHeader } });
      if (response.ok) return true;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw createOpenCodeStartError(`OpenCode Server 启动超时：${(lastError as Error)?.message || 'unknown error'}`, {
    ...childState.meta,
    exitInfo: childState.exitInfo,
    spawnError: childState.spawnError,
    lastError,
  });
}

function killChild(child: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function startOpenCodeSidecar(options: StartOpenCodeSidecarOptions): Promise<OpenCodeSidecar> {
  const { binPath, runtimeRoot, workspaceDir, onStage, onExit, loadConfig } = options;
  const agentTimeoutMs = normalizeConfigTimeout(options.timeoutMs);
  ensureExecutable(binPath);

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const toolEnvironment = ensureOpenCodeToolEnvironment({
    workspaceDir,
    logger: (msg) => emitStage(onStage, 'tool-environment', 'running', msg),
  });

  const tempHome = path.join(runtimeRoot, 'home');
  const configDir = path.join(tempHome, '.config', 'opencode');
  const dataHome = path.join(tempHome, '.local', 'share');
  const cacheHome = path.join(getAgentCacheDir(), 'opencode-cache');
  const opencodeConfigPath = path.join(runtimeRoot, 'opencode.json');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(cacheHome, { recursive: true });

  const stderrBuffer = createRingBuffer();
  const stdoutBuffer = createRingBuffer();
  let aiProxy: ReturnType<typeof createAiServiceOpenAiProxy> | null = null;
  let child: ChildProcess | null = null;

  try {
    emitStage(onStage, 'ai-proxy-start', 'running', '正在启动 OpenCode AI proxy');
    aiProxy = createAiServiceOpenAiProxy({
      loadConfig,
      timeoutMs: agentTimeoutMs,
      diagnostics: options.diagnostics,
      onActivity: options.onActivity,
      getActivityContext: options.getActivityContext,
    });
    const aiProxyInfo = await aiProxy.start();
    emitStage(onStage, 'ai-proxy-start', 'success', aiProxyInfo.baseUrl, { port: aiProxyInfo.port, baseUrl: aiProxyInfo.baseUrl });

    emitStage(onStage, 'opencode-config-write', 'running', '正在写入 OpenCode 常驻配置');
    const contextLengthLimit = loadConfig()?.context_length_limit;
    const opencodeConfig = writeOpenCodeConfig(opencodeConfigPath, {
      proxyBaseUrl: aiProxyInfo.baseUrl,
      contextLengthLimit,
      timeoutMs: agentTimeoutMs,
    });
    emitStage(onStage, 'opencode-config-write', 'success', opencodeConfigPath);

    const port = await findFreePort();
    const username = 'yibiao';
    const password = crypto.randomBytes(24).toString('base64url');
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = createBasicAuth(username, password);
    const childState: ChildState = {
      spawnError: null,
      exitInfo: null,
      healthPassed: false,
      meta: { opencodeBin: binPath, workspaceDir, runtimeRoot, baseUrl, port },
    };

    const env = applyOpenCodeToolEnvironment(
      buildMinimalChildEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        XDG_CONFIG_HOME: path.join(tempHome, '.config'),
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        OPENCODE_CONFIG: opencodeConfigPath,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
        OPENCODE_PERMISSION: JSON.stringify((opencodeConfig as unknown as Record<string, unknown>).permission),
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        YIBIAO_OPENCODE_PROXY_TOKEN: aiProxyInfo.token,
      }),
      toolEnvironment,
    );

    emitStage(onStage, 'opencode-server-start', 'running', `正在启动 OpenCode Server：${baseUrl}`);
    child = spawn(binPath, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: workspaceDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => stdoutBuffer.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrBuffer.push(chunk));

    child.once('error', (error: Error) => {
      childState.spawnError = error;
      emitStage(onStage, 'opencode-server-start', 'error', error?.message || String(error));
      stderrBuffer.push(`\n[spawn error] ${error?.message || String(error)}\n`);
    });

    child.once('exit', (code, signal) => {
      childState.exitInfo = { code, signal };
      if (!childState.healthPassed && code !== 0) {
        emitStage(onStage, 'opencode-server-start', 'error', `OpenCode 进程退出：code=${code ?? 'null'} signal=${signal || 'null'}`);
        console.warn('[opencode] server exited', {
          code,
          signal,
          stdout: stdoutBuffer.tail(4000),
          stderr: stderrBuffer.tail(4000),
        });
      }
      onExit?.({
        code,
        signal,
        stdoutTail: stdoutBuffer.tail(8000),
        stderrTail: stderrBuffer.tail(8000),
      });
    });

    emitStage(onStage, 'opencode-health', 'running', `正在检查 OpenCode Server 健康状态：${baseUrl}`);
    await waitForOpenCodeHealth({ baseUrl, authHeader, childState });
    childState.healthPassed = true;
    emitStage(onStage, 'opencode-health', 'success', baseUrl, { port, baseUrl });

    const proxyHandle = aiProxy;
    return {
      baseUrl,
      authHeader,
      port,
      aiProxyBaseUrl: aiProxyInfo.baseUrl,
      aiProxyPort: aiProxyInfo.port,
      workspaceDir,
      runtimeRoot,
      pid: child.pid ?? 0,
      requestLog: [],
      getStderrTail(size = 4000) {
        return stderrBuffer.tail(size);
      },
      getStdoutTail(size = 4000) {
        return stdoutBuffer.tail(size);
      },
      getProxyStatus() {
        return proxyHandle.getStatus();
      },
      async close() {
        await killChild(child);
        try {
          await proxyHandle.close();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (error) {
    await killChild(child);
    if (aiProxy) {
      try {
        await aiProxy.close();
      } catch {
        /* ignore */
      }
    }
    throw attachOpenCodeDiagnostics(error, {
      opencodeBin: binPath,
      workspaceDir,
      runtimeRoot,
      stderrBuffer,
      stdoutBuffer,
    });
  }
}

export async function closeOpenCodeSidecar(sidecar: OpenCodeSidecar | null): Promise<void> {
  if (!sidecar) return;
  try {
    await sidecar.close();
  } catch {
    /* ignore */
  }
}
