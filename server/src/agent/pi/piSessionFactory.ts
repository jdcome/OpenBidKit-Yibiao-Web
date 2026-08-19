// Pi Session 工厂（移植自桌面 electron/services/pi/piSessionFactory.cjs）。
// 动态 import ESM SDK（惰性缓存），注册 yibiao provider 指向 aiProxy，装 8 工具（含 3 自定义），createAgentSession。
// 动态 import 而非静态：opencode 回退路径永不加载 pi SDK（包缺失时仅 pi boot 失败，不崩主服务）。

import { createPiJsonValidationTool, type PiTypeBuilder } from './piJsonValidationTool';
import { createPiUserQuestionTool, type RequestUserQuestion } from './piUserQuestionTool';
import { createPiRetryErrorNormalizer } from './piRetryErrorNormalizer';
import type { PreparedPiEnvironment } from './piEnvironment';

// ---- pi SDK 模块形状（按桌面用法固化；包真实类型未校验，用 as unknown as 解耦）----

interface PiModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow: number;
  maxTokens: number;
  cost?: Record<string, number>;
  compat?: Record<string, unknown>;
}
interface PiModel {
  provider?: string;
  id?: string;
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}
interface PiModelRuntime {
  registerProvider(id: string, config: { name?: string; baseUrl: string; api: string; models: PiModelConfig[] }): void;
  setRuntimeApiKey(id: string, token: string): Promise<void>;
  getModel(provider: string, id: string): PiModel | null;
}
export interface PiSession {
  sessionFile?: string;
  getActiveToolNames?(): string[];
  // prompt / 事件订阅由 piRuntimeService 使用，那里按需强类型
  [key: string]: unknown;
}
interface PiSessionManager {
  getSessionFile?(): string;
}
interface PiResourceLoader {
  reload(): Promise<void>;
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content?: string }> };
  getSkills(): { skills: Array<{ name: string }> };
  getPrompts(): { prompts: Array<{ name: string }> };
  getExtensions(): { extensions: Array<{ path: string }> };
}
interface PiSettingsManager {
  [key: string]: unknown;
}
interface PiToolDefinition {
  [key: string]: unknown;
}
interface PiCodingAgentModule {
  VERSION?: string;
  ModelRuntime: {
    create(opts: {
      credentials: unknown;
      modelsStore: unknown;
      modelsPath: string | null;
      allowModelNetwork: boolean;
    }): Promise<PiModelRuntime>;
  };
  SettingsManager: {
    inMemory(settings: Record<string, unknown>, opts?: Record<string, unknown>): PiSettingsManager;
  };
  DefaultResourceLoader: new (opts: Record<string, unknown>) => PiResourceLoader;
  createBashToolDefinition(workspaceDir: string, opts: Record<string, unknown>): PiToolDefinition;
  defineTool(tool: unknown): PiToolDefinition;
  SessionManager: {
    open(sessionFile: string, sessionsDir: string, workspaceDir: string): PiSessionManager;
    create(workspaceDir: string, sessionsDir: string): PiSessionManager;
    inMemory(workspaceDir: string): PiSessionManager;
  };
  createAgentSession(opts: Record<string, unknown>): Promise<{ session: PiSession }>;
}
interface PiAiModule {
  InMemoryCredentialStore: new () => unknown;
  InMemoryModelsStore: new () => unknown;
}
export interface PiModules {
  codingAgent: PiCodingAgentModule;
  piAi: PiAiModule;
  typebox: { Type: PiTypeBuilder };
}

let piModulesPromise: Promise<PiModules> | null = null;

// 延迟加载 ESM pi SDK（缓存首次结果）。失败抛 → 调用方（ensureStarted）转降级。
export async function loadPiModules(): Promise<PiModules> {
  if (!piModulesPromise) {
    piModulesPromise = (async () => {
      const [codingAgentMod, piAiMod, typeboxMod] = await Promise.all([
        import('@earendil-works/pi-coding-agent'),
        import('@earendil-works/pi-ai'),
        import('typebox'),
      ]);
      return {
        codingAgent: codingAgentMod as unknown as PiCodingAgentModule,
        piAi: piAiMod as unknown as PiAiModule,
        typebox: typeboxMod as unknown as { Type: PiTypeBuilder },
      };
    })();
  }
  return piModulesPromise;
}

function normalizeContextLimit(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 400000;
}

function normalizeOutputLimit(contextLength: unknown): number {
  const normalizedContextLength = normalizeContextLimit(contextLength);
  return Math.min(32768, normalizedContextLength);
}

export interface PiProxyInfo {
  baseUrl: string;
  port: number;
  token: string;
}

export interface CreatePiSessionParams {
  workspaceDir: string;
  sessionsDir?: string;
  sessionFile?: string;
  environment: PreparedPiEnvironment;
  proxyInfo: PiProxyInfo;
  config: { context_length_limit?: number | string };
  timeoutMs: number;
  jsonValidationSchemas?: Record<string, object>;
  requestUserQuestion: RequestUserQuestion;
}

export interface PiSessionSnapshot {
  sdk_version: string;
  model: {
    provider: string;
    id: string;
    api: string;
    base_url: string;
    context_window: number;
    max_tokens: number;
  };
  transport: {
    proxy_base_url: string;
    proxy_port: number;
    provider_timeout_ms: number;
    http_idle_timeout_ms: number;
  };
  context_files: string[];
  skills: string[];
  prompts: string[];
  extensions: string[];
  active_tools: string[];
}

export interface PiSessionHandle {
  session: PiSession;
  sessionFile: string;
  snapshot: PiSessionSnapshot;
}

// 创建隔离的 pi Session；持久任务可在后续执行中用 sessionFile 重开原 Session。
export async function createPiSession(params: CreatePiSessionParams): Promise<PiSessionHandle> {
  const { workspaceDir, sessionsDir, sessionFile, environment, proxyInfo, config, timeoutMs, jsonValidationSchemas, requestUserQuestion } = params;
  const { codingAgent, piAi, typebox } = await loadPiModules();

  const credentials = new piAi.InMemoryCredentialStore();
  const modelsStore = new piAi.InMemoryModelsStore();
  const modelRuntime = await codingAgent.ModelRuntime.create({
    credentials,
    modelsStore,
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider('yibiao', {
    name: 'Yibiao AI',
    baseUrl: `${proxyInfo.baseUrl}/v1`,
    api: 'openai-completions',
    models: [
      {
        id: 'default',
        name: 'Yibiao Current Text Model',
        reasoning: false,
        input: ['text'],
        contextWindow: normalizeContextLimit(config.context_length_limit),
        maxTokens: normalizeOutputLimit(config.context_length_limit),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
          maxTokensField: 'max_tokens',
        },
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey('yibiao', proxyInfo.token);
  const model = modelRuntime.getModel('yibiao', 'default');
  if (!model) throw new Error('Pi Agent 模型注册失败');

  const settingsManager = codingAgent.SettingsManager.inMemory(
    {
      defaultProvider: 'yibiao',
      defaultModel: 'default',
      defaultThinkingLevel: 'off',
      defaultProjectTrust: 'never',
      retry: { enabled: true, provider: { maxRetries: 0, timeoutMs } },
      compaction: { enabled: true },
      images: { autoResize: false, blockImages: true },
      enableInstallTelemetry: false,
      enableAnalytics: false,
      shellPath: environment.shellPath,
      httpIdleTimeoutMs: timeoutMs,
    },
    { projectTrusted: false },
  );

  const resourceLoader = new codingAgent.DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: environment.layout.agentDir,
    settingsManager,
    extensionFactories: [createPiRetryErrorNormalizer()],
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({
      agentsFiles: [{ path: '<yibiao-agent-workspace>', content: environment.instructions }],
    }),
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const bashTool = codingAgent.createBashToolDefinition(workspaceDir, {
    shellPath: environment.shellPath,
    commandPrefix: environment.shellCommandPrefix,
    spawnHook: ({ command, cwd, env }: { command: string; cwd: string; env: Record<string, unknown> }) => ({
      command,
      cwd,
      env: { ...env, ...environment.env },
    }),
  });
  const jsonValidationTool = codingAgent.defineTool(
    createPiJsonValidationTool({
      workspaceDir,
      Type: typebox.Type,
      validationSchemas: jsonValidationSchemas,
    }),
  );
  const userQuestionTool = codingAgent.defineTool(
    createPiUserQuestionTool({
      Type: typebox.Type,
      requestUserQuestion,
    }),
  );

  const sessionManager = sessionFile
    ? codingAgent.SessionManager.open(sessionFile, sessionsDir!, workspaceDir)
    : sessionsDir
      ? codingAgent.SessionManager.create(workspaceDir, sessionsDir)
      : codingAgent.SessionManager.inMemory(workspaceDir);

  const { session } = await codingAgent.createAgentSession({
    cwd: workspaceDir,
    agentDir: environment.layout.agentDir,
    model,
    modelRuntime,
    thinkingLevel: 'off',
    tools: ['read', 'bash', 'edit', 'write', 'find', 'ls', 'json-validation', 'ask-user'],
    customTools: [bashTool, jsonValidationTool, userQuestionTool],
    resourceLoader,
    settingsManager,
    sessionManager,
  });

  return {
    session,
    sessionFile: (session.sessionFile as string) || sessionManager.getSessionFile?.() || '',
    snapshot: {
      sdk_version: codingAgent.VERSION || '',
      model: {
        provider: model.provider || '',
        id: model.id || '',
        api: model.api || '',
        base_url: model.baseUrl || '',
        context_window: Number(model.contextWindow || 0),
        max_tokens: Number(model.maxTokens || 0),
      },
      transport: {
        proxy_base_url: proxyInfo.baseUrl,
        proxy_port: Number(proxyInfo.port || 0),
        provider_timeout_ms: Number(timeoutMs || 0),
        http_idle_timeout_ms: Number(timeoutMs || 0),
      },
      context_files: resourceLoader.getAgentsFiles().agentsFiles.map((item) => item.path),
      skills: resourceLoader.getSkills().skills.map((item) => item.name),
      prompts: resourceLoader.getPrompts().prompts.map((item) => item.name),
      extensions: resourceLoader.getExtensions().extensions.map((item) => item.path),
      active_tools: session.getActiveToolNames?.() ?? [],
    },
  };
}
