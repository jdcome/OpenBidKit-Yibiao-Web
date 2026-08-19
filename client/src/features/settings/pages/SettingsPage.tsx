import { useEffect, useRef, useState } from 'react';
import { FloatingToolbar, InputWithAction, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import { useSystemSettings, useSaveSystemSettings } from '../../../shared/api/system-settings';
import { useAuth } from '../../../shared/api/auth';
import { useAgentStatus, useRunAgentSelfCheck, useRestartAgent, agentPhaseMeta, agentStepStatusMeta, type AgentSelfCheckReport } from '../../../shared/api/agent';
import logoUrl from '../../../../assets/icon_256.png';
import type { AgentModeScenariosConfig, AiRequestMode, ClientConfig, ConfiguredTextModelProvider, FileParserProvider, ImageModelConfig, ImageModelProfiles, ImageModelProvider, ImageModelSize, ImageModelStatus, TextModelConfig, TextModelProfiles, TextModelProvider, UpdateChannel } from '../../../shared/types';
import type { SettingsPageState } from '../types';
import { AiDiagnosticsPanel } from '../components/AiDiagnosticsPanel';

type SettingsTab = 'basic' | 'general' | 'text-model' | 'image-model' | 'file-parser' | 'agent' | 'ai-diagnostics';
type AgentSelfCheckUiStatus = 'untested' | 'checking' | 'normal' | 'busy' | 'error';

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'basic', label: '基本设置' },
  { id: 'general', label: '通用' },
  { id: 'text-model', label: '文本模型' },
  { id: 'image-model', label: '生图模型' },
  { id: 'file-parser', label: '文件解析' },
  { id: 'agent', label: '智能体配置' },
  { id: 'ai-diagnostics', label: 'AI 任务诊断' },
];

const agentSelfCheckStatusMeta: Record<AgentSelfCheckUiStatus, { label: string; description: string }> = {
  untested: { label: '未检测', description: '点击自检后，会验证 OpenCode Server、AI proxy、已集成命令工具、当前文本模型和智能体输出链路。' },
  checking: { label: '检测中', description: '正在清理上一轮自检日志，并校验工具环境与极简智能体任务。' },
  normal: { label: '正常', description: '智能体链路和关键集成工具已通过自检，可以用于目录修复等 Agent 能力。' },
  busy: { label: '忙碌', description: 'Agent 正在处理其他任务，本次自检已跳过；这不是 OpenCode 故障。' },
  error: { label: '异常', description: '智能体链路自检失败，请查看下方错误详情。' },
};

const updateChannelOptions: Array<{ value: UpdateChannel; label: string; description: string }> = [
  { value: 'github', label: 'GitHub', description: '使用 GitHub Release 检查和下载更新' },
  { value: 'cloudflare', label: 'Cloudflare', description: '使用 Cloudflare R2 镜像检查和下载更新' },
];

const defaultAgentModeScenarios: AgentModeScenariosConfig = {
  existing_plan_expansion_original_outline_extraction: true,
};

function normalizeUpdateChannel(value?: string): UpdateChannel {
  return value === 'cloudflare' ? 'cloudflare' : 'github';
}

function normalizeAgentModeScenarios(value?: Partial<AgentModeScenariosConfig>): AgentModeScenariosConfig {
  return {
    existing_plan_expansion_original_outline_extraction: value?.existing_plan_expansion_original_outline_extraction === undefined
      ? defaultAgentModeScenarios.existing_plan_expansion_original_outline_extraction
      : Boolean(value.existing_plan_expansion_original_outline_extraction),
  };
}

const textModelProviders: Array<{ value: TextModelProvider; label: string }> = [
  { value: 'jinlong', label: '金龙中转站【推荐】' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'agnes', label: 'Agnes AI' },
  { value: 'custom', label: '自定义' },
];

const aiRequestModeOptions: Array<{ value: AiRequestMode; label: string }> = [
  { value: 'normal', label: '普通请求' },
  { value: 'stream', label: '流式请求' },
];

const DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT = 400000;
const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;
const DEFAULT_TEXT_REQUEST_QUEUE_LIMIT = 24;

const textProviderDefaults: Record<ConfiguredTextModelProvider, TextModelConfig> = {
  jinlong: { api_key: '', base_url: 'https://jlaudeapi.com/v1', model_name: 'gpt-3.5-turbo', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  volcengine: { api_key: '', base_url: 'https://ark.cn-beijing.volces.com/api/v3', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  deepseek: { api_key: '', base_url: 'https://api.deepseek.com', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  longcat: { api_key: '', base_url: 'https://api.longcat.chat/openai/v1', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  agnes: { api_key: '', base_url: 'https://apihub.agnes-ai.com/v1', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  custom: { api_key: '', base_url: '', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
};

const textProviderApiKeyUrls: Partial<Record<ConfiguredTextModelProvider, string>> = {
  jinlong: 'https://s.markup.com.cn/jl',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  agnes: 'https://platform.agnes-ai.com/settings/apiKeys',
};

function createDefaultTextModelProfiles(): TextModelProfiles {
  return textModelProviders.reduce((profiles, provider) => ({
    ...profiles,
    [provider.value]: { ...textProviderDefaults[provider.value] },
  }), {} as TextModelProfiles);
}

function normalizeAiRequestMode(value?: AiRequestMode): AiRequestMode {
  return value === 'normal' ? 'normal' : 'stream';
}

function normalizeTextContextLengthLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT;
}

function normalizeTextConcurrencyLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : DEFAULT_TEXT_CONCURRENCY_LIMIT;
}

function parseTextContextLengthInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : '';
}

function parseTextConcurrencyLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : '';
}

function normalizeTextRequestQueueLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : DEFAULT_TEXT_REQUEST_QUEUE_LIMIT;
}

function parseTextRequestQueueLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : '';
}

function normalizeTextModelProfile(provider: ConfiguredTextModelProvider, profile?: Partial<TextModelConfig>): TextModelConfig {
  const defaults = textProviderDefaults[provider];
  const baseUrl = provider === 'custom' ? profile?.base_url ?? defaults.base_url : defaults.base_url;
  return {
    api_key: profile?.api_key ?? defaults.api_key,
    base_url: baseUrl,
    model_name: profile?.model_name ?? defaults.model_name,
    context_length_limit: normalizeTextContextLengthLimit(profile?.context_length_limit ?? defaults.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(profile?.concurrency_limit ?? defaults.concurrency_limit),
    request_mode: normalizeAiRequestMode(profile?.request_mode ?? defaults.request_mode),
  };
}

function normalizeTextModelProfiles(
  profiles?: Partial<Record<ConfiguredTextModelProvider, TextModelConfig>>,
  activeProvider?: ConfiguredTextModelProvider,
): TextModelProfiles {
  const nextProfiles = textModelProviders.reduce((normalizedProfiles, provider) => ({
    ...normalizedProfiles,
    [provider.value]: normalizeTextModelProfile(provider.value, profiles?.[provider.value]),
  }), {} as TextModelProfiles);

  if (activeProvider === 'longcat' || profiles?.longcat) {
    nextProfiles.longcat = normalizeTextModelProfile('longcat', profiles?.longcat);
  }

  return nextProfiles;
}

function textProfileFromState(textModel: SettingsPageState['textModel']): TextModelConfig {
  return {
    api_key: textModel.api_key,
    base_url: textModel.provider === 'custom' ? textModel.base_url : textProviderDefaults[textModel.provider].base_url,
    model_name: textModel.model_name,
    context_length_limit: normalizeTextContextLengthLimit(textModel.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(textModel.concurrency_limit),
    request_mode: textModel.request_mode,
  };
}

const imageProviders: Array<{ value: ImageModelProvider; label: string }> = [
  { value: 'jinlong', label: '金龙中转站【推荐】' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'google-ai-studio', label: 'Google AI Studio' },
  { value: 'agnes', label: 'Agnes AI' },
  { value: 'custom', label: '自定义 OpenAI-like' },
];

const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;

const openAICompatibleImageSizeOptions: Array<{ value: ImageModelSize; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: '1024x1024', label: '1024×1024（1K 方图）' },
  { value: '1536x1024', label: '1536×1024（1K 横图）' },
  { value: '1024x1536', label: '1024×1536（1K 竖图）' },
  { value: '2048x2048', label: '2048×2048（2K 方图）' },
  { value: '2048x1152', label: '2048×1152（2K 横图）' },
  { value: '3840x2160', label: '3840×2160（4K 横图）' },
  { value: '2160x3840', label: '2160×3840（4K 竖图）' },
];

const googleImageSizeOptions: Array<{ value: ImageModelSize; label: string }> = [
  { value: '512', label: '512' },
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

function getImageSizeOptions(provider: ImageModelProvider) {
  return provider === 'google-ai-studio' ? googleImageSizeOptions : openAICompatibleImageSizeOptions;
}

function normalizeImageSize(provider: ImageModelProvider, value?: string): ImageModelSize {
  const options = getImageSizeOptions(provider);
  const candidate = String(value || '').trim() as ImageModelSize;
  return options.some((option) => option.value === candidate)
    ? candidate
    : provider === 'google-ai-studio' ? '1K' : '1024x1024';
}

const imageProviderDefaults: ImageModelProfiles = {
  jinlong: {
    provider: 'jinlong',
    base_url: 'https://img-api.jlaudeapi.com/v1',
    api_key: '',
    model_name: 'gpt-image-2',
    image_size: '1024x1024',
    request_mode: 'normal',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  volcengine: {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  'google-ai-studio': {
    provider: 'google-ai-studio',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: '',
    model_name: 'gemini-3.1-flash-image-preview',
    image_size: '1K',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  agnes: {
    provider: 'agnes',
    base_url: 'https://apihub.agnes-ai.com/v1',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  custom: {
    provider: 'custom',
    base_url: '',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
};

const imageProviderApiKeyUrls: Record<ImageModelProvider, string> = {
  jinlong: 'https://s.markup.com.cn/jl',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  'google-ai-studio': 'https://aistudio.google.com/api-keys',
  agnes: 'https://platform.agnes-ai.com/settings/apiKeys',
  custom: '',
};

const imageProviderLabels: Record<ImageModelProvider, string> = {
  jinlong: '金龙中转站',
  volcengine: '火山方舟',
  'google-ai-studio': 'Google AI Studio',
  agnes: 'Agnes AI',
  custom: '自定义生图服务',
};

function getImageBaseUrlDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '金龙中转站 OpenAI 兼容接口地址';
  if (provider === 'volcengine') return '火山方舟 OpenAI 兼容接口地址';
  if (provider === 'agnes') return 'Agnes AI OpenAI 兼容接口地址';
  if (provider === 'custom') return '填写兼容 OpenAI /images/generations 的接口地址';
  return 'Google Gemini API REST 地址';
}

function getImageApiKeyDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '用于调用金龙中转站图片生成 API';
  if (provider === 'volcengine') return '用于调用火山方舟图片生成 API';
  if (provider === 'agnes') return '用于调用 Agnes AI 图片生成 API';
  if (provider === 'custom') return '用于调用自定义 OpenAI-like 生图接口';
  return '用于调用 Google AI Studio Gemini API';
}

function getImageModelDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '填写金龙中转站已开通的生图模型名称';
  if (provider === 'volcengine') return '填写火山方舟控制台中已开通的模型或推理接入点 ID';
  if (provider === 'agnes') return '填写 Agnes AI 已开通的生图模型名称';
  if (provider === 'custom') return '填写自定义接口支持的生图模型名称';
  return '选择或填写支持图片生成的 Gemini 模型';
}

function getImageModelPlaceholder(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '请输入已开通的生图模型名称';
  if (provider === 'volcengine') return '请输入已开通的模型或推理接入点 ID';
  if (provider === 'agnes') return '请输入 Agnes AI 生图模型名称';
  if (provider === 'custom') return '请输入 OpenAI-like 生图模型名称';
  return 'gemini-3.1-flash-image-preview';
}

function createDefaultImageModelProfiles(): ImageModelProfiles {
  return imageProviders.reduce((profiles, provider) => ({
    ...profiles,
    [provider.value]: { ...imageProviderDefaults[provider.value] },
  }), {} as ImageModelProfiles);
}

function normalizeImageModelProfile(provider: ImageModelProvider, profile?: Partial<ImageModelConfig>): ImageModelConfig {
  const defaults = imageProviderDefaults[provider];
  const useProviderDefaultImageModel = provider === 'jinlong' && !String(profile?.model_name ?? '').trim();
  return {
    provider,
    base_url: provider === 'custom' ? profile?.base_url ?? defaults.base_url : defaults.base_url,
    api_key: profile?.api_key ?? defaults.api_key,
    model_name: useProviderDefaultImageModel ? defaults.model_name : profile?.model_name ?? defaults.model_name,
    image_size: normalizeImageSize(provider, useProviderDefaultImageModel ? defaults.image_size : profile?.image_size ?? defaults.image_size),
    request_mode: normalizeAiRequestMode(useProviderDefaultImageModel ? defaults.request_mode : profile?.request_mode ?? defaults.request_mode),
    concurrency_limit: normalizeImageConcurrencyLimit(profile?.concurrency_limit ?? defaults.concurrency_limit),
    status: useProviderDefaultImageModel ? defaults.status : profile?.status ?? defaults.status,
    tested_at: useProviderDefaultImageModel ? defaults.tested_at : profile?.tested_at ?? defaults.tested_at,
    last_error: useProviderDefaultImageModel ? defaults.last_error : profile?.last_error ?? defaults.last_error,
  };
}

function normalizeImageConcurrencyLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : DEFAULT_IMAGE_CONCURRENCY_LIMIT;
}

function parseImageConcurrencyLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : '';
}

function normalizeImageModelProfiles(profiles?: Partial<ImageModelProfiles>): ImageModelProfiles {
  return imageProviders.reduce((nextProfiles, provider) => ({
    ...nextProfiles,
    [provider.value]: normalizeImageModelProfile(provider.value, profiles?.[provider.value]),
  }), {} as ImageModelProfiles);
}

function imageProfileFromState(imageModel: SettingsPageState['imageModel']): ImageModelConfig {
  return {
    provider: imageModel.provider,
    base_url: imageModel.provider === 'custom' ? imageModel.base_url || '' : imageProviderDefaults[imageModel.provider].base_url,
    api_key: imageModel.api_key,
    model_name: imageModel.model_name,
    image_size: normalizeImageSize(imageModel.provider, imageModel.image_size),
    request_mode: imageModel.request_mode,
    concurrency_limit: normalizeImageConcurrencyLimit(imageModel.concurrency_limit),
    status: imageModel.status || 'untested',
    tested_at: imageModel.tested_at || '',
    last_error: imageModel.last_error || '',
  };
}

const imageStatusMeta: Record<ImageModelStatus, { label: string; description: string }> = {
  untested: {
    label: '未测试',
    description: '请点击测试确认当前生图模型可用，正文生成时只有可用状态才会自动配图。',
  },
  available: {
    label: '可用',
    description: '当前生图模型已通过测试，正文生成时会按内容需要自动配图。',
  },
  unavailable: {
    label: '不可用',
    description: '当前生图模型测试失败，正文生成会跳过配图。',
  },
};

function resetImageModelStatus(imageModel: SettingsPageState['imageModel']): SettingsPageState['imageModel'] {
  return {
    ...imageModel,
    status: 'untested',
    tested_at: '',
    last_error: '',
  };
}

function formatImageTestTime(value?: string) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString('zh-CN', { hour12: false });
}

const fileParserProviders: Array<{ value: FileParserProvider; label: string }> = [
  { value: 'local', label: '本地解析' },
  { value: 'mineru-accurate-api', label: 'MinerU-精准解析 API' },
  { value: 'mineru-agent-api', label: 'MinerU-Agent 轻量解析 API' },
];

const parserOptions = [
  {
    title: '本地解析',
    badge: '推荐默认',
    tone: 'primary',
    summary: '覆盖大多数 Word、Excel 和带文字层 PDF，速度快、无调用限制。',
    items: [
      ['Token', '无需'],
      ['解析速度', '快'],
      ['支持格式', 'pdf、docx、doc、wps、md、xls、xlsx'],
      ['大小/页数', '无限制'],
      ['解析质量', '高'],
      ['扫描件', '不支持'],
    ],
  },
  {
    title: 'MinerU 精准解析 API',
    badge: '扫描件兜底',
    tone: 'accent',
    summary: '解析质量高，适合本地解析失败或扫描件质量要求高的文档。',
    items: [
      ['Token', '需要'],
      ['解析速度', '慢'],
      ['支持格式', 'pdf、doc、docx、ppt、pptx、图片、html；xls/xlsx 自动本地解析'],
      ['大小/页数', '≤ 200MB / ≤ 200 页'],
      ['解析质量', '高'],
      ['扫描件', '支持'],
    ],
  },
  {
    title: 'MinerU-Agent 轻量解析 API',
    badge: '轻量备用',
    tone: 'muted',
    summary: '无需 Token 但存在 IP 限频，适合轻量文档的备用解析。',
    items: [
      ['Token', '无需（IP 限频）'],
      ['解析速度', '中等'],
      ['支持格式', 'pdf、doc、docx、ppt、pptx、图片；xls/xlsx 自动本地解析'],
      ['大小/页数', '≤ 10MB / ≤ 20 页'],
      ['解析质量', '中'],
      ['扫描件', '质量差'],
    ],
  },
];

const initialState: SettingsPageState = {
  textModel: {
    provider: 'jinlong',
    ...textProviderDefaults.jinlong,
  },
  textModelProfiles: createDefaultTextModelProfiles(),
  imageModel: {
    ...imageProviderDefaults.jinlong,
  },
  imageModelProfiles: createDefaultImageModelProfiles(),
  fileParser: {
    provider: 'local',
    mineru_token: '',
  },
  agentModeScenarios: { ...defaultAgentModeScenarios },
  general: {
    developer_mode: false,
    developer_token_stats_auto_open: false,
    update_channel: 'github',
    gpu_hardware_acceleration_enabled: true,
    gpu_hardware_acceleration_configured: true,
    text_request_queue_limit: DEFAULT_TEXT_REQUEST_QUEUE_LIMIT,
  },
};

interface SettingsPageProps {
  onDeveloperModeChange?: (developerMode: boolean) => void;
}

function SettingsPage({ onDeveloperModeChange }: SettingsPageProps) {
  const [state, setState] = useState<SettingsPageState>(initialState);
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic');
  const [savedConfig, setSavedConfig] = useState<ClientConfig | null>(null);
  const [textModels, setTextModels] = useState<string[]>([]);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState<'text' | 'image' | null>(null);
  const [testingTextModel, setTestingTextModel] = useState(false);
  const [testingImageModel, setTestingImageModel] = useState(false);
  const [imageTestPreview, setImageTestPreview] = useState<{ src: string; title: string } | null>(null);
  const [selfCheckReport, setSelfCheckReport] = useState<AgentSelfCheckReport | null>(null);
  const { showToast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // 智能体运维：sidecar 状态轮询（仅 agent tab 激活时）+ 自检/重启 mutation。
  // 桌面 bridge 的 window.yibiao.agent.* 在 Web 是 no-op，这里直连 server routes/agent.ts。
  const agentStatusQuery = useAgentStatus(activeTab === 'agent');
  const selfCheckMutation = useRunAgentSelfCheck();
  const restartMutation = useRestartAgent();

  // 基本设置（系统名称 + Logo）：独立于模型配置 state，走 system-settings 接口。
  const { data: systemSettings } = useSystemSettings();
  const saveSystemSettingsMutation = useSaveSystemSettings();
  const [draftSystemName, setDraftSystemName] = useState('');
  const [draftLogoDataUrl, setDraftLogoDataUrl] = useState<string | null>(null);
  const [basicDirty, setBasicDirty] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadTextConfig();
  }, []);

  // 基本设置：服务端配置首次载入（或保存后刷新）时，同步到本地草稿。
  useEffect(() => {
    if (systemSettings) {
      setDraftSystemName(systemSettings.systemName);
      setDraftLogoDataUrl(systemSettings.logoDataUrl);
      setBasicDirty(false);
    }
  }, [systemSettings]);

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('请选择图片文件', 'error');
      return;
    }
    // 限制 1MB：data URL 直接入库 + 每次接口带回，过大会撑大 app_config 与请求体。
    if (file.size > 1024 * 1024) {
      showToast('Logo 图片不能超过 1MB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setDraftLogoDataUrl(typeof reader.result === 'string' ? reader.result : null);
      setBasicDirty(true);
    };
    reader.onerror = () => showToast('读取图片失败', 'error');
    reader.readAsDataURL(file);
    // 清空 value 允许重复选同一文件再次触发 change。
    e.target.value = '';
  };

  const handleClearLogo = () => {
    setDraftLogoDataUrl(null);
    setBasicDirty(true);
  };

  const handleSaveBasic = async () => {
    const trimmed = draftSystemName.trim();
    if (!trimmed) {
      showToast('系统名称不能为空', 'error');
      return;
    }
    try {
      await saveSystemSettingsMutation.mutateAsync({ systemName: trimmed, logoDataUrl: draftLogoDataUrl });
      showToast('基本设置已保存', 'success');
      setBasicDirty(false);
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } };
      showToast(e.response?.data?.message || '保存失败', 'error');
    }
  };

  const loadTextConfig = async () => {
    try {
      const config = await window.yibiao?.config.load();
      if (!config) {
        return;
      }

      const textModelProfiles = normalizeTextModelProfiles(config.text_model_profiles, config.text_model_provider);
      const activeTextProfile = normalizeTextModelProfile(config.text_model_provider, textModelProfiles[config.text_model_provider]);
      const imageModelProfiles = normalizeImageModelProfiles(config.image_model_profiles);
      const activeImageProfile = normalizeImageModelProfile(config.image_model.provider, config.image_model);
      imageModelProfiles[activeImageProfile.provider] = activeImageProfile;

      setState((prev) => ({
        ...prev,
        textModel: {
          provider: config.text_model_provider,
          ...activeTextProfile,
        },
        textModelProfiles,
        imageModel: activeImageProfile,
        imageModelProfiles,
        fileParser: {
          provider: config.file_parser.provider,
          mineru_token: config.file_parser.mineru_token || '',
        },
        agentModeScenarios: normalizeAgentModeScenarios(config.agent_mode_scenarios),
        general: {
          developer_mode: Boolean(config.developer_mode),
          developer_token_stats_auto_open: Boolean(config.developer_token_stats_auto_open),
          update_channel: normalizeUpdateChannel(config.update_channel),
          gpu_hardware_acceleration_enabled: Boolean(config.gpu_hardware_acceleration_enabled),
          gpu_hardware_acceleration_configured: Boolean(config.gpu_hardware_acceleration_configured),
          text_request_queue_limit: normalizeTextRequestQueueLimit(config.text_request_queue_limit),
        },
      }));
      setSavedConfig(config);
      onDeveloperModeChange?.(Boolean(config.developer_mode));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '加载客户端配置失败';
      showToast(errorMessage, 'error');
    }
  };

  const getCurrentTextModelProfiles = (): TextModelProfiles => ({
    ...state.textModelProfiles,
    [state.textModel.provider]: textProfileFromState(state.textModel),
  });

  const getCurrentImageModelProfiles = (): ImageModelProfiles => ({
    ...state.imageModelProfiles,
    [state.imageModel.provider]: imageProfileFromState(state.imageModel),
  });

  const createClientConfig = (): ClientConfig => {
    const textModelProfiles = getCurrentTextModelProfiles();
    const activeTextProfile = textModelProfiles[state.textModel.provider]
      || normalizeTextModelProfile(state.textModel.provider);
    const imageModelProfiles = getCurrentImageModelProfiles();
    const activeImageProfile = imageModelProfiles[state.imageModel.provider];

    return {
      text_model_provider: state.textModel.provider,
      text_model_profiles: textModelProfiles,
      api_key: activeTextProfile.api_key,
      base_url: activeTextProfile.base_url,
      model_name: activeTextProfile.model_name,
      context_length_limit: activeTextProfile.context_length_limit,
      concurrency_limit: activeTextProfile.concurrency_limit,
      request_mode: activeTextProfile.request_mode,
      image_model: activeImageProfile,
      image_model_profiles: imageModelProfiles,
      file_parser: {
        provider: state.fileParser.provider,
        mineru_token: state.fileParser.mineru_token || '',
      },
      agent_mode_scenarios: state.agentModeScenarios,
      update_channel: state.general.update_channel,
      gpu_hardware_acceleration_enabled: state.general.gpu_hardware_acceleration_enabled,
      gpu_hardware_acceleration_configured: state.general.gpu_hardware_acceleration_configured,
      developer_mode: state.general.developer_mode,
      developer_token_stats_auto_open: state.general.developer_token_stats_auto_open,
      text_request_queue_limit: normalizeTextRequestQueueLimit(state.general.text_request_queue_limit),
    };
  };

  const updateImageModelConfig = (partial: Partial<Omit<SettingsPageState['imageModel'], 'provider'>>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      setImageModels([]);
    }

    setState((prev) => ({
      ...prev,
      ...(() => {
        const imageModel = resetImageModelStatus({ ...prev.imageModel, ...partial });
        return {
          imageModel,
          imageModelProfiles: {
            ...prev.imageModelProfiles,
            [prev.imageModel.provider]: imageProfileFromState(imageModel),
          },
        };
      })(),
    }));
  };

  const updateImageModelProvider = (provider: ImageModelProvider) => {
    setImageModels([]);
    setImageTestPreview(null);
    setState((prev) => ({
      ...prev,
      imageModelProfiles: {
        ...prev.imageModelProfiles,
        [prev.imageModel.provider]: imageProfileFromState(prev.imageModel),
      },
      imageModel: normalizeImageModelProfile(provider, prev.imageModelProfiles[provider]),
    }));
  };

  // 按角色选择保存通道：管理员→平台配置（PUT /config，落 api_key/base_url/并发/全局队列上限等
  // 平台级字段）；普通用户→个人偏好白名单（PUT /config/user，仅 provider 选择等）。这是
  // text_request_queue_limit 等平台字段能真正落库 + 热生效的唯一路径（getLiveTextRequestQueueLimit
  // 读 appConfigCache，只有 saveAppConfig 会刷新它）。
  const persistConfig = (config: ClientConfig) => {
    const bridge = window.yibiao?.config;
    const saveFn = isAdmin ? bridge?.savePlatform : bridge?.save;
    return saveFn?.(config);
  };

  const saveClientConfig = async (config: ClientConfig) => {
    try {
      const result = await persistConfig(config);
      showToast(result?.success ? '配置已保存' : result?.message || '配置保存失败', result?.success ? 'success' : 'error');
      if (result?.success) {
        setSavedConfig(config);
        onDeveloperModeChange?.(Boolean(config.developer_mode));
      }
      return Boolean(result?.success);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '配置保存失败';
      showToast(errorMessage, 'error');
      return false;
    }
  };

  const saveTextConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const updateDeveloperMode = (developerMode: boolean) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, developer_mode: developerMode },
    }));
    onDeveloperModeChange?.(developerMode);
  };

  const updateDeveloperTokenStatsAutoOpen = (autoOpen: boolean) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, developer_token_stats_auto_open: autoOpen },
    }));
  };

  const updateUpdateChannel = (updateChannel: UpdateChannel) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, update_channel: updateChannel },
    }));
  };

  const updateGpuHardwareAcceleration = (enabled: boolean) => {
    setState((prev) => ({
      ...prev,
      general: {
        ...prev.general,
        gpu_hardware_acceleration_enabled: enabled,
        gpu_hardware_acceleration_configured: true,
      },
    }));
  };

  const updateAgentModeScenario = (key: keyof AgentModeScenariosConfig, enabled: boolean) => {
    setState((prev) => ({
      ...prev,
      agentModeScenarios: {
        ...prev.agentModeScenarios,
        [key]: enabled,
      },
    }));
  };

  const updateTextModelProvider = (provider: TextModelProvider) => {
    setTextModels([]);
    setState((prev) => ({
      ...prev,
      textModelProfiles: {
        ...prev.textModelProfiles,
        [prev.textModel.provider]: textProfileFromState(prev.textModel),
      },
      textModel: {
        provider,
        ...normalizeTextModelProfile(provider, prev.textModelProfiles[provider]),
      },
    }));
  };

  const updateTextModelConfig = (partial: Partial<Omit<SettingsPageState['textModel'], 'provider'>>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      setTextModels([]);
    }

    setState((prev) => ({
      ...prev,
      ...(() => {
        const textModel = { ...prev.textModel, ...partial };
        return {
          textModel,
          textModelProfiles: {
            ...prev.textModelProfiles,
            [prev.textModel.provider]: textProfileFromState(textModel),
          },
        };
      })(),
    }));
  };

  const openTextProviderApiKeyPage = async () => {
    const url = textProviderApiKeyUrls[state.textModel.provider];
    if (!url) {
      showToast('自定义服务商没有预置 API Key 获取页面', 'info');
      return;
    }

    try {
      const result = await window.yibiao?.openExternal(url);
      if (result && !result.success) {
        showToast(result.message || '打开 API Key 获取页面失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 API Key 获取页面失败', 'error');
    }
  };

  const openImageProviderApiKeyPage = async () => {
    const url = imageProviderApiKeyUrls[state.imageModel.provider];
    if (!url) {
      showToast('自定义生图服务没有预置 API Key 获取页面', 'info');
      return;
    }

    try {
      const result = await window.yibiao?.openExternal(url);
      if (result && !result.success) {
        showToast(result.message || '打开生图服务 API Key 获取页面失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开生图服务 API Key 获取页面失败', 'error');
    }
  };

  const testTextConfig = async () => {
    try {
      setTestingTextModel(true);
      const config = createClientConfig();
      const result = await persistConfig(config);
      if (result?.success) {
        setSavedConfig(config);
      }
      const content = await window.yibiao?.ai.chat({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        timeout_ms: 30000,
        timeout_message: '文本模型测试超时，请检查 Base URL、API Key 或模型名称',
        logTitle: '文本模型测试',
      });
      const reply = (content || '').trim();
      showToast(reply ? `测试成功：${reply.slice(0, 160)}` : '测试成功', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '测试失败', 'error');
    } finally {
      setTestingTextModel(false);
    }
  };

  const runAgentSelfCheck = async () => {
    if (selfCheckMutation.isPending) return;

    try {
      setSelfCheckReport(null);

      const config = createClientConfig();
      const saveResult = await persistConfig(config);
      if (!saveResult?.success) {
        throw new Error(saveResult?.message || '保存当前文本模型配置失败，无法执行智能体自检');
      }
      setSavedConfig(config);
      onDeveloperModeChange?.(Boolean(config.developer_mode));

      const report = await selfCheckMutation.mutateAsync();
      setSelfCheckReport(report);
      const ok = report.overall === 'pass';
      const skipped = report.overall === 'warn';
      showToast(
        ok ? '智能体自检通过' : skipped ? 'Agent 正忙，自检已跳过' : '智能体自检失败',
        ok ? 'success' : skipped ? 'info' : 'error'
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : '智能体自检失败', 'error');
    }
  };

  const exportAgentSelfCheckReport = () => {
    if (!selfCheckReport) return;
    try {
      const blob = new Blob([JSON.stringify(selfCheckReport, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `agent-self-check-${(selfCheckReport.finished_at || new Date().toISOString()).replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      showToast('智能体自检报告已导出', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出智能体自检报告失败', 'error');
    }
  };

  const restartAgentSidecar = async () => {
    if (restartMutation.isPending) return;
    try {
      await restartMutation.mutateAsync();
      showToast('Agent sidecar 重启指令已发出', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重启 Agent sidecar 失败', 'error');
    }
  };

  const saveImageConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const testImageConfig = async () => {
    try {
      setTestingImageModel(true);
      const config = createClientConfig();
      const result = await window.yibiao?.ai.testImageModel(config);
      if (!result?.success) {
        throw new Error(result?.message || '生图模型测试失败');
      }
      const testedImageModel: ImageModelConfig = {
        ...config.image_model,
        status: 'available',
        tested_at: new Date().toISOString(),
        last_error: '',
      };
      const testedConfig: ClientConfig = {
        ...config,
        image_model: testedImageModel,
        image_model_profiles: {
          ...config.image_model_profiles,
          [testedImageModel.provider]: testedImageModel,
        },
      };
      await persistConfig(testedConfig as ClientConfig);
      setState((prev) => ({
        ...prev,
        imageModel: testedConfig.image_model,
        imageModelProfiles: {
          ...prev.imageModelProfiles,
          [testedConfig.image_model.provider]: imageProfileFromState(testedConfig.image_model),
        },
      }));
      setSavedConfig(testedConfig);
      const previewSrc = result?.image_url || (result?.image_data ? `data:${result.mime_type || 'image/png'};base64,${result.image_data}` : '');

      if (previewSrc) {
        setImageTestPreview({ src: previewSrc, title: `${imageProviderLabels[state.imageModel.provider]} 测试图片` });
      }

      showToast(result?.message || '生图模型测试成功', result?.success ? 'success' : 'error');
    } catch (error) {
      const message = error instanceof Error ? error.message : '生图模型测试失败';
      const config = createClientConfig();
      const failedImageModel: ImageModelConfig = {
        ...config.image_model,
        status: 'unavailable',
        tested_at: new Date().toISOString(),
        last_error: message,
      };
      const failedConfig: ClientConfig = {
        ...config,
        image_model: failedImageModel,
        image_model_profiles: {
          ...config.image_model_profiles,
          [failedImageModel.provider]: failedImageModel,
        },
      };
      await persistConfig(failedConfig).catch(() => undefined);
      setState((prev) => ({
        ...prev,
        imageModel: failedConfig.image_model,
        imageModelProfiles: {
          ...prev.imageModelProfiles,
          [failedConfig.image_model.provider]: imageProfileFromState(failedConfig.image_model),
        },
      }));
      setSavedConfig(failedConfig);
      showToast(message, 'error');
    } finally {
      setTestingImageModel(false);
    }
  };

  const saveFileParserConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const openConfigFolder = async () => {
    try {
      await window.yibiao?.config.openConfigFolder();
      showToast('已打开配置文件夹', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开配置文件夹失败', 'error');
    }
  };

  const fetchTextModels = async () => {
    try {
      setLoadingModels('text');
      const result = await window.yibiao?.config.listModels(createClientConfig());
      const models = result?.models || [];
      setTextModels(models);
      if (result?.success && models.length > 0) {
        setState((prev) => ({
          ...prev,
          ...(() => {
            const textModel = models.includes(prev.textModel.model_name)
              ? prev.textModel
              : { ...prev.textModel, model_name: models[0] };
            return {
              textModel,
              textModelProfiles: {
                ...prev.textModelProfiles,
                [prev.textModel.provider]: textProfileFromState(textModel),
              },
            };
          })(),
        }));
      }
      showToast(result?.message || `获取到 ${result?.models.length || 0} 个文本模型`, result?.success ? 'success' : 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取文本模型失败', 'error');
    } finally {
      setLoadingModels(null);
    }
  };

  const fetchImageModels = async () => {
    try {
      setLoadingModels('image');
      if (state.imageModel.provider === 'jinlong' || state.imageModel.provider === 'volcengine' || state.imageModel.provider === 'agnes' || state.imageModel.provider === 'custom') {
        const providerLabel = imageProviderLabels[state.imageModel.provider];
        const baseUrl = state.imageModel.provider === 'custom'
          ? state.imageModel.base_url || ''
          : state.imageModel.base_url || imageProviderDefaults[state.imageModel.provider].base_url || '';

        if (!state.imageModel.api_key.trim()) {
          setImageModels([]);
          showToast(`请先填写${providerLabel} API Key`, 'info');
          return;
        }

        if (!baseUrl.trim()) {
          setImageModels([]);
          showToast(`请先填写${providerLabel} Base URL`, 'info');
          return;
        }

        const config = createClientConfig();
        const result = await window.yibiao?.config.listModels({
          ...config,
          api_key: state.imageModel.api_key,
          base_url: baseUrl,
          model_name: state.imageModel.model_name,
        });
        const models = result?.models || [];
        setImageModels(models);
        if (result?.success && models.length > 0) {
          setState((prev) => ({
            ...prev,
            ...(() => {
              const imageModel = models.includes(prev.imageModel.model_name)
                ? prev.imageModel
                : resetImageModelStatus({ ...prev.imageModel, model_name: models[0] });
              return {
                imageModel,
                imageModelProfiles: {
                  ...prev.imageModelProfiles,
                  [prev.imageModel.provider]: imageProfileFromState(imageModel),
                },
              };
            })(),
          }));
        }
        showToast(result?.message || `获取到 ${models.length} 个${providerLabel}模型`, result?.success ? 'success' : 'info');
        return;
      }

      if (state.imageModel.provider === 'google-ai-studio') {
        const models = [
          'gemini-3.1-flash-image-preview',
          'gemini-3-pro-image-preview',
          'gemini-2.5-flash-image',
        ];
        setImageModels(models);
        setState((prev) => ({
          ...prev,
          ...(() => {
            const imageModel = models.includes(prev.imageModel.model_name)
              ? prev.imageModel
              : resetImageModelStatus({ ...prev.imageModel, model_name: models[0] });
            return {
              imageModel,
              imageModelProfiles: {
                ...prev.imageModelProfiles,
                [prev.imageModel.provider]: imageProfileFromState(imageModel),
              },
            };
          })(),
        }));
        showToast('已载入 Google AI Studio 生图模型', 'success');
        return;
      }

      setImageModels([]);
      showToast('该服务商模型列表接口暂未接入。');
    } finally {
      setLoadingModels(null);
    }
  };

  const isActiveTabDirty = () => {
    if (!savedConfig) {
      return false;
    }

    if (activeTab === 'text-model') {
      return JSON.stringify({
        provider: state.textModel.provider,
        profiles: getCurrentTextModelProfiles(),
        text_request_queue_limit: normalizeTextRequestQueueLimit(state.general.text_request_queue_limit),
      }) !== JSON.stringify({
        provider: savedConfig.text_model_provider,
        profiles: normalizeTextModelProfiles(savedConfig.text_model_profiles, savedConfig.text_model_provider),
        text_request_queue_limit: normalizeTextRequestQueueLimit(savedConfig.text_request_queue_limit),
      });
    }

    if (activeTab === 'general') {
      return JSON.stringify({
        developer_mode: Boolean(state.general.developer_mode),
        developer_token_stats_auto_open: Boolean(state.general.developer_token_stats_auto_open),
        update_channel: state.general.update_channel,
        gpu_hardware_acceleration_enabled: Boolean(state.general.gpu_hardware_acceleration_enabled),
        gpu_hardware_acceleration_configured: Boolean(state.general.gpu_hardware_acceleration_configured),
      }) !== JSON.stringify({
        developer_mode: Boolean(savedConfig.developer_mode),
        developer_token_stats_auto_open: Boolean(savedConfig.developer_token_stats_auto_open),
        update_channel: normalizeUpdateChannel(savedConfig.update_channel),
        gpu_hardware_acceleration_enabled: Boolean(savedConfig.gpu_hardware_acceleration_enabled),
        gpu_hardware_acceleration_configured: Boolean(savedConfig.gpu_hardware_acceleration_configured),
      });
    }

    if (activeTab === 'image-model') {
      return JSON.stringify({
        provider: state.imageModel.provider,
        profiles: getCurrentImageModelProfiles(),
      }) !== JSON.stringify({
        provider: savedConfig.image_model.provider,
        profiles: normalizeImageModelProfiles(savedConfig.image_model_profiles),
      });
    }

    if (activeTab === 'file-parser') {
      return JSON.stringify(state.fileParser) !== JSON.stringify(savedConfig.file_parser);
    }

    if (activeTab === 'agent') {
      return JSON.stringify(state.agentModeScenarios) !== JSON.stringify(normalizeAgentModeScenarios(savedConfig.agent_mode_scenarios));
    }

    return false;
  };

  const openDeveloperTokenStatsWindow = async () => {
    const nextConfig = createClientConfig();
    if (!nextConfig.developer_mode) {
      showToast('请先开启开发者模式', 'info');
      return;
    }

    if (!savedConfig?.developer_mode || isActiveTabDirty()) {
      const saved = await saveClientConfig(nextConfig);
      if (!saved) {
        return;
      }
    }

    try {
      const result = await window.yibiao?.developerTokenStats.openWindow();
      showToast(result?.success ? '已打开 Token 统计小窗' : '打开 Token 统计小窗失败', result?.success ? 'success' : 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 Token 统计小窗失败', 'error');
    }
  };

  const saveActiveTabConfig = async () => {
    if (activeTab === 'general') {
      const nextConfig = createClientConfig();
      const previousGpuEnabled = Boolean(savedConfig?.gpu_hardware_acceleration_enabled);
      const nextGpuEnabled = Boolean(state.general.gpu_hardware_acceleration_enabled);

      if (!previousGpuEnabled && nextGpuEnabled) {
        const saved = await saveClientConfig({
          ...nextConfig,
          gpu_hardware_acceleration_enabled: false,
          gpu_hardware_acceleration_configured: true,
        });
        if (saved) {
          try {
            const result = await window.yibiao?.startGpuHardwareAccelerationTrial();
            if (!result?.success) {
              throw new Error('GPU 硬件加速试启用失败');
            }
            showToast('即将重启试用 GPU 硬件加速', 'info');
          } catch (error) {
            setState((prev) => ({
              ...prev,
              general: {
                ...prev.general,
                gpu_hardware_acceleration_enabled: false,
                gpu_hardware_acceleration_configured: true,
              },
            }));
            const message = error instanceof Error ? error.message : 'GPU 硬件加速试启用失败';
            showToast(`${message}，已保持关闭，请稍后重试。`, 'error');
          }
        }
        return;
      }

      const saved = await saveClientConfig(nextConfig);
      if (saved && previousGpuEnabled !== nextGpuEnabled) {
        showToast(nextGpuEnabled ? 'GPU 硬件加速将在重启后启用' : 'GPU 硬件加速将在重启后关闭', 'info');
      }
      return;
    }
    if (activeTab === 'text-model') {
      await saveTextConfig();
      return;
    }
    if (activeTab === 'image-model') {
      await saveImageConfig();
      return;
    }
    if (activeTab === 'file-parser') {
      await saveFileParserConfig();
      return;
    }
    if (activeTab === 'agent') {
      await saveClientConfig(createClientConfig());
    }
  };

  const canSaveActiveTab = activeTab === 'general' || activeTab === 'text-model' || activeTab === 'image-model' || activeTab === 'file-parser' || activeTab === 'agent';
  const activeTabDirty = isActiveTabDirty();
  const currentTextProviderDefault = textProviderDefaults[state.textModel.provider];
  const imageModelStatus: ImageModelStatus = state.imageModel.status || 'untested';
  const currentImageStatus = imageStatusMeta[imageModelStatus];
  const agentSelfCheckStatus: AgentSelfCheckUiStatus = selfCheckMutation.isPending
    ? 'checking'
    : !selfCheckReport
      ? 'untested'
      : selfCheckReport.overall === 'pass'
        ? 'normal'
        : selfCheckReport.overall === 'warn'
          ? 'busy'
          : 'error';
  const currentAgentSelfCheckStatus = agentSelfCheckStatusMeta[agentSelfCheckStatus];
  const imageTestTime = formatImageTestTime(state.imageModel.tested_at);
  const settingsToolbarGroups: FloatingToolbarGroup[] = canSaveActiveTab
    ? [
        {
          id: 'settings-save-state',
          actions: [
            {
              id: 'save-state',
              label: activeTabDirty ? '未保存' : '已保存',
              variant: 'ghost',
              disabled: true,
              onClick: () => undefined,
            },
          ],
        },
        {
          id: 'settings-save-action',
          actions: [
            {
              id: 'save',
              label: '保存',
              variant: 'primary',
              disabled: !activeTabDirty,
              tooltip: activeTabDirty ? '保存当前设置' : '当前设置已保存',
              onClick: saveActiveTabConfig,
            },
          ],
        },
      ]
    : [];

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <div className="settings-tab-shell" role="tablist" aria-label="设置分类">
          {settingsTabs.filter((tab) => tab.id !== 'ai-diagnostics' || user?.role === 'admin').map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={activeTab === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>

      {activeTab === 'basic' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>基本设置</strong>
          </div>
          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>系统 Logo</strong>
                <span>显示在侧边栏与登录页。建议正方形 PNG/SVG，不超过 1MB；留空将使用默认图标。</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <img
                  src={draftLogoDataUrl || logoUrl}
                  alt=""
                  style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 12, border: '1px solid var(--yb-border-soft)', background: '#fafafa' }}
                />
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleLogoFileChange}
                  style={{ display: 'none' }}
                />
                <button type="button" className="inline-action" onClick={() => logoInputRef.current?.click()}>
                  选择图片
                </button>
                {draftLogoDataUrl && (
                  <button type="button" className="inline-action" onClick={handleClearLogo}>
                    清除
                  </button>
                )}
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>系统名称</strong>
                <span>显示在侧边栏品牌区与登录页标题。</span>
              </div>
              <input
                type="text"
                value={draftSystemName}
                onChange={(e) => { setDraftSystemName(e.target.value); setBasicDirty(true); }}
                placeholder="金盾标书编制系统"
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-copy" />
              <div className="settings-action-cell">
                <button
                  type="button"
                  className="inline-action"
                  onClick={() => void handleSaveBasic()}
                  disabled={saveSystemSettingsMutation.isPending || !basicDirty}
                >
                  {saveSystemSettingsMutation.isPending ? '保存中…' : '保存基本设置'}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {activeTab === 'general' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>通用</strong>
          </div>
          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>显示语言</strong>
                <span>选择界面的显示语言</span>
              </div>
              <select value="zh-CN" disabled>
                <option value="zh-CN">简体中文</option>
              </select>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>应用主题</strong>
                <span>切换深色或浅色模式</span>
              </div>
              <select value="system" disabled>
                <option value="system">跟随系统</option>
              </select>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>侧边栏布局</strong>
                <span>保持当前经典布局，后续可扩展为紧凑布局</span>
              </div>
              <select value="classic" disabled>
                <option value="classic">经典布局</option>
              </select>
            </div>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>自动更新渠道</strong>
                <span>{updateChannelOptions.find((option) => option.value === state.general.update_channel)?.description || '选择自动检查更新和下载客户端安装包的来源'}</span>
              </div>
              <select
                value={state.general.update_channel}
                onChange={(event) => updateUpdateChannel(event.target.value as UpdateChannel)}
              >
                {updateChannelOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>GPU 硬件加速</strong>
                <span>启用后界面可能更流畅；极少数电脑启用后会闪退，关闭后兼容性更好。修改后需重启生效。</span>
              </div>
              <span className="yb-switch-control">
                <input
                  type="checkbox"
                  checked={state.general.gpu_hardware_acceleration_enabled}
                  onChange={(event) => updateGpuHardwareAcceleration(event.target.checked)}
                />
                <span className="yb-switch-track" aria-hidden="true">
                  <span className="yb-switch-thumb" />
                </span>
              </span>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>开发者模式</strong>
                <span>会打乱既有工作流，生成大量日志占用磁盘空间，<strong>非专业人士请勿开启</strong></span>
              </div>
              <span className="yb-switch-control">
                <input
                  type="checkbox"
                  checked={state.general.developer_mode}
                  onChange={(event) => updateDeveloperMode(event.target.checked)}
                />
                <span className="yb-switch-track" aria-hidden="true">
                  <span className="yb-switch-thumb" />
                </span>
              </span>
            </label>
            {state.general.developer_mode && (
              <>
                <label className="settings-row">
                  <div className="settings-row-copy">
                    <strong>默认打开 Token 统计小窗</strong>
                    <span>开启后，应用下次启动时自动打开开发者 Token 统计悬浮窗</span>
                  </div>
                  <span className="yb-switch-control">
                    <input
                      type="checkbox"
                      checked={state.general.developer_token_stats_auto_open}
                      onChange={(event) => updateDeveloperTokenStatsAutoOpen(event.target.checked)}
                    />
                    <span className="yb-switch-track" aria-hidden="true">
                      <span className="yb-switch-thumb" />
                    </span>
                  </span>
                </label>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>Token 统计小窗</strong>
                    <span>半透明悬浮展示文本模型输入、输出、总量、缓存命中和请求次数</span>
                  </div>
                  <div className="settings-action-cell">
                    <button type="button" className="inline-action" onClick={openDeveloperTokenStatsWindow}>
                      打开 Token 统计小窗
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>配置文件夹</strong>
                    <span>打开本机配置、工作区缓存和开发者日志所在目录</span>
                  </div>
                  <div className="settings-action-cell">
                    <button type="button" className="inline-action" onClick={openConfigFolder}>
                      打开配置文件夹
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {activeTab === 'text-model' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>文本模型配置</strong>
          </div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>服务提供商</strong>
                <span>选择服务商会自动使用预置 Base URL；只有自定义服务商允许修改</span>
              </div>
              <select
                value={state.textModel.provider}
                onChange={(event) => updateTextModelProvider(event.target.value as TextModelProvider)}
              >
                {state.textModel.provider === 'longcat' && (
                  <option value="longcat" disabled>龙猫（历史配置）</option>
                )}
                {textModelProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Base URL</strong>
                <span>OpenAI Like 接口地址，用于文本生成和分析任务</span>
              </div>
              <input
                type="text"
                value={state.textModel.base_url}
                placeholder={currentTextProviderDefault.base_url || '例如 https://api.openai.com/v1'}
                onChange={(event) => updateTextModelConfig({ base_url: event.target.value }, { clearModels: true })}
                disabled={state.textModel.provider !== 'custom'}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>API Key</strong>
                <span>仅保存在本机配置文件中，不暴露给 Renderer 以外的原始能力</span>
              </div>
              <InputWithAction
                type="password"
                value={state.textModel.api_key}
                placeholder="请输入文本模型 API Key"
                onChange={(event) => updateTextModelConfig({ api_key: event.target.value }, { clearModels: true })}
                actionLabel="获取"
                actionTitle="打开当前服务商的 API Key 获取页面"
                actionDisabled={!textProviderApiKeyUrls[state.textModel.provider]}
                onAction={() => { void openTextProviderApiKeyPage(); }}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>模型名称</strong>
                <span>可手动录入，也可从当前 Base URL 拉取可用模型</span>
              </div>
              <div className="settings-control-with-action">
                {textModels.length > 0 ? (
                  <select
                    value={state.textModel.model_name}
                    onChange={(event) => updateTextModelConfig({ model_name: event.target.value })}
                  >
                    {textModels.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={state.textModel.model_name}
                    placeholder="例如 deepseek-chat"
                    onChange={(event) => updateTextModelConfig({ model_name: event.target.value })}
                  />
                )}
                <button
                  type="button"
                  className="inline-action"
                  onClick={fetchTextModels}
                  disabled={loadingModels === 'text'}
                >
                  {loadingModels === 'text' && <span className="inline-spinner" aria-hidden="true" />}
                  {loadingModels === 'text' ? '获取中' : '获取'}
                </button>
                <button type="button" className="inline-action" onClick={testTextConfig} disabled={testingTextModel}>
                  {testingTextModel && <span className="inline-spinner" aria-hidden="true" />}
                  {testingTextModel ? '测试中' : '测试'}
                </button>
              </div>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>上下文长度限制</strong>
                <span>配置所选模型的上下文长度，在处理长文本时会自动截断，分批处理</span>
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={state.textModel.context_length_limit}
                placeholder="400000"
                onChange={(event) => updateTextModelConfig({ context_length_limit: parseTextContextLengthInput(event.target.value) })}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>任务并发上限</strong>
                <span>单个正文生成任务同时并发的章节数（任务级）</span>
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={state.textModel.concurrency_limit}
                placeholder="10"
                onChange={(event) => updateTextModelConfig({ concurrency_limit: parseTextConcurrencyLimitInput(event.target.value) })}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>全局请求队列上限</strong>
                <span>全局·进程级·影响所有并发任务：所有任务共享的上游 AI 请求并发池上限，超出后自动排队（热生效，无需重启）</span>
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={state.general.text_request_queue_limit}
                placeholder="24"
                onChange={(event) => setState((prev) => ({ ...prev, general: { ...prev.general, text_request_queue_limit: parseTextRequestQueueLimitInput(event.target.value) } }))}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>请求方式</strong>
                <span>流式请求只影响后端调用方式，应用仍等待完整结果后继续流程</span>
              </div>
              <select
                value={state.textModel.request_mode}
                onChange={(event) => updateTextModelConfig({ request_mode: event.target.value as AiRequestMode })}
              >
                {aiRequestModeOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}

      {activeTab === 'image-model' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>生图模型配置</strong>
          </div>
          <div className={`image-model-status is-${imageModelStatus}`}>
            <div>
              <strong>接口状态：{currentImageStatus.label}</strong>
              <span>{currentImageStatus.description}</span>
              {imageTestTime && <small>最近测试：{imageTestTime}</small>}
              {imageModelStatus === 'unavailable' && state.imageModel.last_error && <small>失败原因：{state.imageModel.last_error}</small>}
            </div>
            <em>{currentImageStatus.label}</em>
          </div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>服务提供商</strong>
                <span>各家生图接口不统一，先选择服务商再配置模型</span>
              </div>
              <select
                value={state.imageModel.provider}
                onChange={(event) => {
                  const provider = event.target.value as ImageModelProvider;
                  updateImageModelProvider(provider);
                }}
              >
                {imageProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>Base URL</strong>
                <span>{getImageBaseUrlDescription(state.imageModel.provider)}</span>
              </div>
              <input
                type="text"
                value={state.imageModel.base_url || ''}
                placeholder={state.imageModel.provider === 'custom' ? 'https://api.example.com/v1' : imageProviderDefaults[state.imageModel.provider].base_url}
                onChange={(event) => updateImageModelConfig({ base_url: event.target.value }, { clearModels: true })}
                disabled={state.imageModel.provider !== 'custom'}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>API Key</strong>
                <span>{getImageApiKeyDescription(state.imageModel.provider)}</span>
              </div>
              <InputWithAction
                type="password"
                value={state.imageModel.api_key}
                placeholder="请输入生图服务 API Key"
                onChange={(event) => updateImageModelConfig({ api_key: event.target.value }, { clearModels: true })}
                actionLabel="获取"
                actionTitle="打开当前生图服务商的 API Key 获取页面"
                onAction={() => { void openImageProviderApiKeyPage(); }}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>模型名称</strong>
                <span>{getImageModelDescription(state.imageModel.provider)}</span>
              </div>
              <div className="settings-control-with-action">
                {imageModels.length > 0 ? (
                  <select
                    value={state.imageModel.model_name}
                    onChange={(event) => updateImageModelConfig({ model_name: event.target.value })}
                  >
                    {imageModels.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={state.imageModel.model_name}
                    placeholder={getImageModelPlaceholder(state.imageModel.provider)}
                    onChange={(event) => updateImageModelConfig({ model_name: event.target.value })}
                  />
                )}
                <button
                  type="button"
                  className="inline-action"
                  onClick={fetchImageModels}
                  disabled={loadingModels === 'image'}
                >
                  {loadingModels === 'image' && <span className="inline-spinner" aria-hidden="true" />}
                  {loadingModels === 'image' ? '获取中' : '获取'}
                </button>
                <button type="button" className="inline-action" onClick={testImageConfig} disabled={testingImageModel}>
                  {testingImageModel && <span className="inline-spinner" aria-hidden="true" />}
                  {testingImageModel ? '测试中' : '测试'}
                </button>
              </div>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>图片尺寸</strong>
                <span>{state.imageModel.provider === 'google-ai-studio' ? '使用 Google AI Studio 官方 imageSize 枚举' : '使用 OpenAI Image API 官方常用尺寸枚举'}</span>
              </div>
              <select
                value={normalizeImageSize(state.imageModel.provider, state.imageModel.image_size)}
                onChange={(event) => updateImageModelConfig({ image_size: event.target.value as ImageModelSize })}
              >
                {getImageSizeOptions(state.imageModel.provider).map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>并发上限</strong>
                <span>全局生图 AI 请求同时执行的最大数量，超出后自动排队</span>
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={state.imageModel.concurrency_limit}
                placeholder="2"
                onChange={(event) => updateImageModelConfig({ concurrency_limit: parseImageConcurrencyLimitInput(event.target.value) })}
              />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>请求方式</strong>
                <span>流式请求只影响后端调用方式，应用仍等待完整图片生成后继续流程</span>
              </div>
              <select
                value={state.imageModel.request_mode}
                onChange={(event) => updateImageModelConfig({ request_mode: event.target.value as AiRequestMode })}
              >
                {aiRequestModeOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          {imageTestPreview && (
            <div className="image-test-preview">
              <div>
                <strong>{imageTestPreview.title}</strong>
                <span>用于确认当前生图配置可用</span>
              </div>
              <img src={imageTestPreview.src} alt="生图模型测试结果" />
            </div>
          )}
        </section>
      )}

      {activeTab === 'file-parser' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>文件解析配置</strong>
          </div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>文件解析方式</strong>
                <span>优先使用本地解析，复杂扫描件可尝试 MinerU 精准解析 API</span>
              </div>
              <select
                value={state.fileParser.provider}
                onChange={(event) => setState((prev) => ({
                ...prev,
                fileParser: { ...prev.fileParser, provider: event.target.value as FileParserProvider },
              }))}
            >
              {fileParserProviders.map((provider) => (
                  <option value={provider.value} key={provider.value}>{provider.label}</option>
                ))}
              </select>
            </label>
            {state.fileParser.provider === 'mineru-accurate-api' && (
              <label className="settings-row">
                <div className="settings-row-copy">
                  <strong>MinerU Token</strong>
                  <span>仅精准解析 API 需要 Token；轻量解析和本地解析无需填写</span>
                </div>
                <input
                  type="password"
                  value={state.fileParser.mineru_token || ''}
                  placeholder="请输入 MinerU Token"
                  onChange={(event) => setState((prev) => ({
                    ...prev,
                    fileParser: { ...prev.fileParser, mineru_token: event.target.value },
                  }))}
                />
              </label>
            )}
          </div>

          <div className="parser-compare">
            {parserOptions.map((option) => (
              <article className={`parser-card parser-card-${option.tone}`} key={option.title}>
                <div className="parser-card-head">
                  <div>
                    <strong>{option.title}</strong>
                    <p>{option.summary}</p>
                  </div>
                  <span>{option.badge}</span>
                </div>
                <dl className="parser-metrics">
                  {option.items.map(([label, value]) => (
                    <div key={`${option.title}-${label}`}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
          <div className="parser-note">
            招标文件大多数是 Word 或 Word 导出的带文字层 PDF，本地解析可以适应 95% 以上的情况；如果解析失败，再尝试 MinerU 精准解析 API。
          </div>
        </section>
      )}

      {activeTab === 'agent' && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>智能体配置</strong>
          </div>
          {(() => {
            const phase = agentStatusQuery.data?.phase || 'stopped';
            const phaseMeta = agentPhaseMeta[phase];
            const statusData = agentStatusQuery.data;
            const statusText = statusData
              ? (statusData.message || (statusData.available ? 'Agent sidecar 在线' : 'Agent sidecar 不可用——Agent 路径将自动降级'))
              : '正在读取 sidecar 状态…';
            return (
              <div className={`agent-self-check-status ${phaseMeta.cls}`}>
                <div>
                  <strong>Sidecar 状态：{phaseMeta.label}</strong>
                  <span>{statusText}</span>
                  {statusData?.active_task && (
                    <small>活动任务：{statusData.active_task.title}（{statusData.active_task.progress_text || statusData.active_task.stage || '进行中'}）</small>
                  )}
                  {statusData && !statusData.available && (
                    <small>未配置 YIBIAO_OPENCODE_BIN 或 sidecar 启动失败时显示「未启动/异常」，此时目录修复等 Agent 能力自动降级为 LLM 兜底，不影响主流程。</small>
                  )}
                </div>
                <em>{phaseMeta.label}</em>
              </div>
            );
          })()}
          <div className={`agent-self-check-status is-${agentSelfCheckStatus}`}>
            <div>
              <strong>智能体自检</strong>
              <span>{currentAgentSelfCheckStatus.description}</span>
            </div>
            <em>{currentAgentSelfCheckStatus.label}</em>
          </div>
          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>自检 / 重启</strong>
                <span>自检跑一个极简 Agent 任务，验证 OpenCode Server、AI proxy、命令工具、当前文本模型和输出校验链路；重启会终止当前 sidecar 并重新拉起（仅管理员）。</span>
              </div>
              <div className="settings-action-cell">
                <button type="button" className="inline-action" onClick={runAgentSelfCheck} disabled={selfCheckMutation.isPending || !isAdmin}>
                  {selfCheckMutation.isPending && <span className="inline-spinner" aria-hidden="true" />}
                  {selfCheckMutation.isPending ? '自检中' : '自检'}
                </button>
                <button type="button" className="inline-action" onClick={restartAgentSidecar} disabled={restartMutation.isPending || !isAdmin}>
                  {restartMutation.isPending && <span className="inline-spinner" aria-hidden="true" />}
                  {restartMutation.isPending ? '重启中' : '重启'}
                </button>
              </div>
            </div>
          </div>
          <div className="settings-section-title">
            <span />
            <strong>在以下场景启用智能体模式</strong>
          </div>
          <div className="settings-list">
            <label className="settings-row">
              <div className="settings-row-copy">
                <strong>已有方案扩写-旧目录提取</strong>
                <span>开启后，已有方案扩写会把原方案交给智能体完成旧目录提取和补漏；关闭后使用原有分段提取流程。</span>
              </div>
              <span className="yb-switch-control">
                <input
                  type="checkbox"
                  checked={state.agentModeScenarios.existing_plan_expansion_original_outline_extraction}
                  onChange={(event) => updateAgentModeScenario('existing_plan_expansion_original_outline_extraction', event.target.checked)}
                />
                <span className="yb-switch-track" aria-hidden="true">
                  <span className="yb-switch-thumb" />
                </span>
              </span>
            </label>
          </div>
          {selfCheckReport && (() => {
            const report = selfCheckReport;
            const overallCls = report.overall === 'pass' ? 'is-normal' : report.overall === 'warn' ? 'is-busy' : 'is-error';
            const headLabel = report.overall === 'pass' ? '自检通过' : report.overall === 'warn' ? '自检跳过' : '自检失败';
            const diag = (report.diagnostics || {}) as Record<string, unknown>;
            const summary = report.overall === 'pass'
              ? '智能体链路自检通过，可用于目录修复等 Agent 能力'
              : report.overall === 'warn'
                ? (diag.reason === 'busy' ? 'Agent 正在执行任务，自检已跳过（非故障）' : '自检已跳过')
                : String(diag.error || diag.stderr_tail || '智能体自检失败，请查看步骤详情');
            const startedMs = Date.parse(report.started_at);
            const finishedMs = Date.parse(report.finished_at);
            const durationSec = Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, Math.round((finishedMs - startedMs) / 1000)) : null;
            return (
              <div className={`agent-self-check-result ${overallCls}`}>
                <div className="agent-self-check-result-head">
                  <div>
                    <strong>{headLabel}</strong>
                    <span>{summary}</span>
                  </div>
                  <div className="agent-self-check-result-actions">
                    <small>{durationSec !== null ? `${durationSec} 秒` : report.finished_at}</small>
                    <button type="button" className="inline-action" onClick={exportAgentSelfCheckReport}>
                      导出报告
                    </button>
                  </div>
                </div>
                {report.steps.length > 0 && (
                  <div className="agent-self-check-steps">
                    {report.steps.map((step) => {
                      const meta = agentStepStatusMeta[step.status];
                      return (
                        <div className={`agent-self-check-step ${meta.cls}`} key={step.id}>
                          <strong>{step.label}</strong>
                          <span>{step.message || meta.label}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {report.overall !== 'pass' && Object.keys(diag).length > 0 && (
                  <pre>{JSON.stringify(diag, null, 2)}</pre>
                )}
              </div>
            );
          })()}
        </section>
      )}

      {activeTab === 'ai-diagnostics' && user?.role === 'admin' && <AiDiagnosticsPanel />}

      </div>
      <FloatingToolbar groups={settingsToolbarGroups} label="设置保存工具条" />
    </div>
  );
}

export default SettingsPage;
