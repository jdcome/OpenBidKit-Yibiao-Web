// Web 版 window.yibiao 桥接 shim。
// 复刻 client/electron/preload.cjs 暴露的 window.yibiao 形状，底层走 shared/api(http/SSE)。
// 仅在 Web 构建（无 preload 注入）安装；Electron 构建保留 preload.cjs 的 contextBridge，不覆盖。
//
// 迁移策略：每个业务 namespace 在其 server 路由落地后于此处接入。
// 注意：window.yibiao 一旦安装，单层可选链 window.yibiao?.method() 不会短路——
// 缺失的成员会抛 TypeError。故桌面专属能力（update/GPU/license/agent 等）一律装
// 显式 no-op stub（见 installWebBridge 内「桌面专属降级 stub」段），而非留 undefined。
// 仅 database 故意不装：WorkspaceDatabaseGate 在 !database 时短路 ready。
// platform/appName 给 Web 静态值。
import { fetchConfig, saveConfig, saveUserConfig } from './config';
import { aiApi } from './ai';
import { templatesApi } from './templates';
import { technicalPlanApi } from './technical-plan';
import type { ImportResult } from './technical-plan';
import { knowledgeBaseApi } from './knowledge-base';
import { duplicateCheckApi } from './duplicate-check';
import { rejectionCheckApi } from './rejection-check';
import { exportWord } from './export';
import type { WordExportProgressEvent } from './export';
import { tasksApi } from './tasks';
import { sseManager } from './sse';
import { pickFiles, DOCUMENT_ACCEPT, DUPLICATE_CHECK_ACCEPT } from './filePicker';
import type {
  KnowledgeBaseIndex,
  KnowledgeBaseIndexMutationResult,
  KnowledgeBaseMutationResult,
  KnowledgeBaseRetryDocumentResult,
  KnowledgeBaseUploadResult,
  KnowledgeDocumentDto,
  KnowledgeFolderDto,
} from './knowledge-base';
import type {
  DuplicateCheckClearResult,
  DuplicateCheckFilePayload,
  DuplicateCheckUiStatePayload,
  DuplicateCheckWorkspaceState,
  FileSelectionResult,
} from './duplicate-check';
import type {
  RejectionCheckClearResult,
  RejectionCheckImportResult,
  RejectionCheckRemoveDocumentPayload,
  RejectionCheckWorkspaceState,
} from './rejection-check';

type TechnicalPlanState = Record<string, unknown>;

interface TemplateDto {
  template_id: string;
  template_name: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  is_shared: boolean;
  owner_id?: number;
  owner_name?: string | null;
  can_edit?: boolean;
}

interface WebBridge {
  platform: string;
  appName: string;
  getVersion: () => Promise<string>;
  openExternal: (url: string) => Promise<{ success: boolean; message?: string }>;
  config: {
    load: () => Promise<unknown>;
    save: (config: unknown) => Promise<unknown>;
    savePlatform: (config: unknown) => Promise<unknown>;
    saveUser: (patch: unknown) => Promise<unknown>;
    listModels: (config?: unknown) => Promise<unknown>;
    openConfigFolder: () => Promise<{ success: boolean; message: string }>;
  };
  ai: {
    chat: (request: unknown) => Promise<string>;
    requestJson: <T = unknown>(request: unknown) => Promise<T>;
    testImageModel: (config: unknown) => Promise<unknown>;
    onHttpError: (listener: (event: unknown) => void) => () => void;
  };
  templates: {
    list: () => Promise<TemplateDto[]>;
    get: (templateId: string) => Promise<TemplateDto | null>;
    create: (config: unknown, isShared?: boolean) => Promise<TemplateDto>;
    update: (templateId: string, config: unknown) => Promise<TemplateDto>;
    delete: (templateId: string) => Promise<{ success: boolean; message: string }>;
    setShared: (templateId: string, isShared: boolean) => Promise<TemplateDto>;
  };
  technicalPlan: {
    loadState: () => Promise<TechnicalPlanState>;
    importTenderDocument: () => Promise<ImportResult>;
    importOriginalPlanDocument: () => Promise<ImportResult>;
    checkBidSections: () => Promise<unknown>;
    selectBidSection: (selectedSection: unknown) => Promise<{ success: boolean; message?: string; state: TechnicalPlanState; markdown: string }>;
    readTenderMarkdown: () => Promise<string>;
    readTenderSourceMarkdown: (sourceId: string) => Promise<string>;
    readOriginalPlanMarkdown: () => Promise<string>;
    updateStep: (step: string) => Promise<TechnicalPlanState>;
    setWorkflowKind: (workflowKind: string) => Promise<TechnicalPlanState>;
    switchWorkflowKind: (workflowKind: string) => Promise<TechnicalPlanState>;
    saveBidAnalysisConfig: (payload: { mode: string; selectedTaskIds: string[]; bidSectionMode?: string }) => Promise<TechnicalPlanState>;
    saveOutlineConfig: (payload: { referenceKnowledgeDocumentIds: string[]; outlineExpansionMode?: string; mirrorProcurementEnabled?: boolean; outlineWordControlOptions?: unknown }) => Promise<TechnicalPlanState>;
    saveOutline: (payload: unknown) => Promise<TechnicalPlanState>;
    saveGlobalFacts: (globalFacts: unknown) => Promise<TechnicalPlanState>;
    saveContentGenerationOptions: (options: unknown) => Promise<TechnicalPlanState>;
    saveChapterContent: (payload: { nodeId: string; content: string }) => Promise<TechnicalPlanState>;
    clear: () => Promise<{ success: boolean; message?: string; state: TechnicalPlanState }>;
  };
  knowledgeBase: {
    getMigrationStatus: () => Promise<Record<string, unknown>>;
    migrateLegacy: () => Promise<never>;
    list: () => Promise<KnowledgeBaseIndex>;
    createFolder: (name: string) => Promise<KnowledgeFolderDto>;
    renameFolder: (folderId: string, name: string) => Promise<KnowledgeFolderDto>;
    reorderFolder: (draggedFolderId: string, targetFolderId: string, position: 'before' | 'after') => Promise<KnowledgeBaseIndexMutationResult>;
    deleteFolder: (folderId: string) => Promise<KnowledgeBaseMutationResult>;
    deleteDocument: (documentId: string) => Promise<KnowledgeBaseMutationResult>;
    moveDocument: (documentId: string, targetFolderId: string, targetDocumentId?: string | null, position?: 'before' | 'after') => Promise<KnowledgeBaseIndexMutationResult>;
    uploadDocuments: (folderId: string) => Promise<KnowledgeBaseUploadResult>;
    retryDocument: (documentId: string) => Promise<KnowledgeBaseRetryDocumentResult>;
    startMatching: (documentId: string, batchSize: number) => Promise<never>;
    readMarkdown: (documentId: string) => Promise<string>;
    readItems: (documentId: string) => Promise<unknown[]>;
    readAnalysis: (documentId: string) => Promise<Record<string, unknown>>;
    onEvent: (callback: (event: { document: KnowledgeDocumentDto }) => void) => () => void;
  };
  duplicateCheck: {
    loadState: () => Promise<DuplicateCheckWorkspaceState>;
    saveFiles: (payload: DuplicateCheckFilePayload) => Promise<DuplicateCheckWorkspaceState>;
    saveUiState: (payload: DuplicateCheckUiStatePayload) => Promise<DuplicateCheckWorkspaceState>;
    updateState: (partial: Record<string, unknown>) => Promise<DuplicateCheckWorkspaceState>;
    clear: () => Promise<DuplicateCheckClearResult>;
  };
  rejectionCheck: {
    loadState: () => Promise<RejectionCheckWorkspaceState>;
    importDocument: (role: string) => Promise<RejectionCheckImportResult>;
    importTenderFromTechnicalPlan: () => Promise<RejectionCheckImportResult>;
    removeDocument: (payload: RejectionCheckRemoveDocumentPayload) => Promise<RejectionCheckWorkspaceState>;
    saveUiState: (payload: Record<string, unknown>) => Promise<RejectionCheckWorkspaceState>;
    updateState: (partial: Record<string, unknown>) => Promise<RejectionCheckWorkspaceState>;
    clear: () => Promise<RejectionCheckClearResult>;
  };
  file: {
    selectDuplicateCheckFiles: (options?: { multiple?: boolean }) => Promise<FileSelectionResult>;
  };
  export: {
    exportWord: (payload: unknown) => Promise<{ canceled: boolean; message: string; warnings: string[]; path?: string }>;
    openFile: (filePath: string) => Promise<{ success: boolean; message?: string }>;
    onWordExportProgress: (callback: (event: WordExportProgressEvent) => void) => () => void;
  };
  // 任务引擎命名空间（对齐 preload tasks）：9 个 start-* + pause + get-active + onTaskEvent。
  // 进度经 SSE 'tasks' 通道推送；onTaskEvent 注册监听器分发到渲染器各页。
  tasks: {
    startBidSectionExtraction: (payload?: unknown) => Promise<unknown>;
    startBidAnalysis: (payload?: unknown) => Promise<unknown>;
    startOutlineGeneration: (payload?: unknown) => Promise<unknown>;
    startGlobalFactsGeneration: (payload?: unknown) => Promise<unknown>;
    startContentGeneration: (payload?: unknown) => Promise<unknown>;
    pauseContentGeneration: () => Promise<unknown>;
    startRejectionItemsExtraction: (payload?: unknown) => Promise<unknown>;
    startRejectionCheck: (payload?: unknown) => Promise<unknown>;
    startDuplicateAnalysis: (payload?: unknown) => Promise<unknown>;
    getActiveTasks: () => Promise<unknown[]>;
    onTaskEvent: (callback: (event: unknown) => void) => () => void;
  };
  [key: string]: unknown;
}

export function installWebBridge(): void {
  const w = window as unknown as { yibiao?: WebBridge };
  if (w.yibiao) return; // Electron preload 已注入，不覆盖

  w.yibiao = {
    // 顶层（桌面 shell 相关）：给 Web 静态/降级值，update/GPU 簇不定义（可选链 no-op）
    platform: 'web',
    appName: '金盾标书编制系统',
    getVersion: () => Promise.resolve(import.meta.env.VITE_APP_VERSION || '0.1.0-web'),
    openExternal: (url: string) => {
      try {
        window.open(url, '_blank', 'noopener');
      } catch {
        /* ignore */
      }
      return Promise.resolve({ success: true });
    },

    // ── 桌面专属降级 stub（update / GPU / license / requiredOnlineServices / agent / dev 工具）──
    // 这些能力在桌面走 Electron main 或外部服务，Web 版无对应能力。装显式 no-op stub 是为了
    // 「window.yibiao 已安装 → 单层 ?. 不短路 → 调 undefined 抛 TypeError」的防线。
    // 消费这些成员的桌面组件已在 App 树 / SettingsPage 裁剪（P8-2/P8-3），stub 仅作兜底。
    // database 故意不装（WorkspaceDatabaseGate 在 !database 时短路 ready）。

    // update 簇：Web 自动更新由部署侧管理，恒报「未启用」。
    checkUpdate: () => Promise.resolve({ enabled: false, updateAvailable: false, downloaded: false, version: '' }),
    startUpdate: () => Promise.resolve({ enabled: false, updateAvailable: false, downloaded: false, version: '' }),
    quitAndInstall: () => Promise.resolve({ success: false }),
    getLatestVersion: () => Promise.resolve(null),
    getUpdateDownloadUrl: () => Promise.resolve(''),
    onUpdateProgress: () => () => {},
    onUpdateDownloaded: () => () => {},
    onUpdateError: () => () => {},

    // GPU 硬件加速：桌面专属，Web 恒报「未启用 / 无试用」。
    getGpuHardwareAccelerationStatus: () => Promise.resolve({ trial: false, currentEnabled: false, configured: false }),
    saveGpuHardwareAccelerationPreference: () => Promise.resolve({ success: true, enabled: false, configured: false, restartRequired: false }),
    startGpuHardwareAccelerationTrial: () => Promise.resolve({ success: false }),
    relaunchWithGpuHardwareAccelerationDisabled: () => Promise.resolve({ success: true }),

    // requiredOnlineServices：桌面探测分析 / license 服务器可达性；Web 服务就在本机，恒「全可达」。
    requiredOnlineServices: {
      getStatus: () => Promise.resolve({ allReachable: true, services: [] }),
    },

    // license：桌面 per-machine ECDSA 免费 trial（零功能门禁），Web 走 JWT 账号体系，恒报「已激活」。
    license: {
      getStatus: () => Promise.resolve({ activated: true, valid: true, plan: 'enterprise_premium', expiresAt: null, source: 'web' }),
      refresh: () => Promise.resolve({ activated: true, valid: true, plan: 'enterprise_premium', expiresAt: null, source: 'web' }),
      importOfflineFile: () => Promise.reject(new Error('Web 版无需激活')),
      activateOfflineCode: () => Promise.reject(new Error('Web 版无需激活')),
    },

    // agent：OpenCode 运行时（M1-P7 延后，linux 二进制硬阻塞）。状态恒空闲；主动操作友好报错。
    agent: {
      getStatus: () => Promise.resolve({ running: false, enabled: false, state: 'stopped' }),
      onStatus: () => () => {},
      restart: () => Promise.resolve({ running: false, enabled: false, state: 'stopped' }),
      run: () => Promise.reject(new Error('Agent 服务未部署（M1-P7 延后）')),
      selfCheck: () => Promise.reject(new Error('Agent 服务未部署（M1-P7 延后）')),
      exportSelfCheckReport: () => Promise.reject(new Error('Agent 服务未部署（M1-P7 延后）')),
    },

    // dev 工具（仅开发者模式页面）：Web 无桌面 token 浮窗 / 原生字体枚举，返 benign 默认。
    developerTokenStats: {
      openWindow: () => Promise.resolve({ success: false }),
      get: () => Promise.resolve(null),
      reset: () => Promise.resolve(null),
      onChanged: () => () => {},
    },
    developerExpansionReplaceTest: {
      run: () => Promise.reject(new Error('Web 版暂不支持该开发测试')),
    },
    systemFonts: {
      list: () => Promise.resolve([]),
    },

    // config 命名空间：已接入真实 GET /api/config
    config: {
      load: () => fetchConfig(),
      // 桌面 config.save 语义在 Web 拆成两层：默认走个人偏好；savePlatform 给管理员
      save: (patch: unknown) => saveUserConfig(patch as never),
      saveUser: (patch: unknown) => saveUserConfig(patch as never),
      savePlatform: (config: unknown) => saveConfig(config as never),
      listModels: (config?: unknown) => aiApi.listModels(config),
      openConfigFolder: () =>
        Promise.resolve({ success: true, message: 'Web 版不支持打开配置文件夹' }),
    },

    // ai 命名空间：服务端代理上游（持真实 key）。chat 内部走流式聚合，返回完整字符串。
    // onHttpError 订阅 SSE 的 ai-http-error 通道（仅 HTML 类错误，用于弹窗展示原始返回）。
    ai: {
      chat: (request: unknown) => aiApi.chat(request as never),
      requestJson: <T = unknown>(request: unknown) => aiApi.requestJson<T>(request as never),
      testImageModel: (config: unknown) => aiApi.testImageModel(config),
      onHttpError: (listener: (event: unknown) => void) =>
        sseManager.subscribe('ai-http-error', (data) => listener(data)),
    },

    // templates 命名空间：导出模板 CRUD + 共享开关。
    // 普通用户看"自己 + 共享"；admin 看全量；admin 建模板默认共享。
    templates: {
      list: () => templatesApi.list(),
      get: (templateId: string) => templatesApi.get(templateId),
      create: (config: unknown, isShared?: boolean) =>
        templatesApi.create(config as Record<string, unknown>, isShared),
      update: (templateId: string, config: unknown) =>
        templatesApi.update(templateId, config as Record<string, unknown>),
      delete: (templateId: string) => templatesApi.delete(templateId),
      setShared: (templateId: string, isShared: boolean) => templatesApi.setShared(templateId, isShared),
    },

    // file 命名空间：桌面 file:select-duplicate-check-files 通道（标书查重选文件）。
    // pickFiles 模拟桌面 dialog → multipart 上传原始字节（不解析，查重解析留 P6）→ 服务端按内容 sha1 落盘。
    file: {
      selectDuplicateCheckFiles: async (options?: { multiple?: boolean }) => {
        const multiple = options?.multiple !== false;
        const files = await pickFiles({ accept: DUPLICATE_CHECK_ACCEPT, multiple });
        if (!files?.length) {
          return { success: false, message: '已取消选择', files: [] };
        }
        return duplicateCheckApi.selectFiles(files);
      },
    },

    // export 命名空间：服务端渲染 docx → blob 下载。
    // 进度走 SSE export-progress 通道（服务端 onProgress 经 EventBus 推送，按 requestId 过滤）；
    // openFile：Web 由浏览器自管下载，无需打开本地文件 → no-op 成功（按钮亦不显示）。
    export: {
      onWordExportProgress: (callback: (event: WordExportProgressEvent) => void) =>
        sseManager.subscribe('export-progress', (data) => callback(data as WordExportProgressEvent)),
      exportWord: async (payload: unknown) => exportWord(payload as never),
      openFile: (_filePath: string) =>
        Promise.resolve({ success: true, message: 'Web 版由浏览器自动下载，无需手动打开文件' }),
    },

    // tasks 命名空间：任务引擎（9 start + pause + get-active + onTaskEvent）。
    // start-* 触发服务端 fire-and-forget runner（L3 骨架，runner 注册表 L4 落入；未注册时返回 501）。
    // onTaskEvent 订阅 SSE 'tasks' 通道，分发 {task, technicalPlanPatch?, ...} 给渲染器各页。
    tasks: {
      startBidSectionExtraction: (payload?: unknown) => tasksApi.startBidSectionExtraction(payload as Record<string, unknown> | undefined),
      startBidAnalysis: (payload?: unknown) => tasksApi.startBidAnalysis(payload as Record<string, unknown> | undefined),
      startOutlineGeneration: (payload?: unknown) => tasksApi.startOutlineGeneration(payload as Record<string, unknown> | undefined),
      startGlobalFactsGeneration: (payload?: unknown) => tasksApi.startGlobalFactsGeneration(payload as Record<string, unknown> | undefined),
      startContentGeneration: (payload?: unknown) => tasksApi.startContentGeneration(payload as Record<string, unknown> | undefined),
      pauseContentGeneration: () => tasksApi.pauseContentGeneration(),
      startRejectionItemsExtraction: (payload?: unknown) => tasksApi.startRejectionItemsExtraction(payload as Record<string, unknown> | undefined),
      startRejectionCheck: (payload?: unknown) => tasksApi.startRejectionCheck(payload as Record<string, unknown> | undefined),
      startDuplicateAnalysis: (payload?: unknown) => tasksApi.startDuplicateAnalysis(payload as Record<string, unknown> | undefined),
      getActiveTasks: () => tasksApi.getActiveTasks(),
      onTaskEvent: (callback: (event: unknown) => void) =>
        sseManager.subscribe('tasks', (data) => callback(data)),
    },

    // technicalPlan 命名空间：技术方案状态读写（PG-backed，按用户隔离）。
    // 导入：pickFiles 模拟桌面 dialog → multipart 上传 → 服务端解析+落盘。tasks:* 未接（P6 SSE）。
    technicalPlan: {
      loadState: () => technicalPlanApi.loadState(),
      importTenderDocument: async () => {
        const files = await pickFiles({ accept: DOCUMENT_ACCEPT, multiple: true });
        if (!files?.length) {
          return { success: false, message: '已取消选择', state: await technicalPlanApi.loadState(), markdown: '' };
        }
        return technicalPlanApi.importTenderDocument(files);
      },
      importOriginalPlanDocument: async () => {
        const files = await pickFiles({ accept: DOCUMENT_ACCEPT, multiple: false });
        if (!files?.length) {
          return { success: false, message: '已取消选择', state: await technicalPlanApi.loadState(), markdown: '' };
        }
        return technicalPlanApi.importOriginalPlanDocument(files);
      },
      checkBidSections: () => technicalPlanApi.checkBidSections(),
      selectBidSection: (selectedSection: unknown) => technicalPlanApi.selectBidSection(selectedSection),
      readTenderMarkdown: () => technicalPlanApi.readTenderMarkdown(),
      readTenderSourceMarkdown: (sourceId: string) => technicalPlanApi.readTenderSourceMarkdown(sourceId),
      readOriginalPlanMarkdown: () => technicalPlanApi.readOriginalPlanMarkdown(),
      updateStep: (step: string) => technicalPlanApi.updateStep(step),
      setWorkflowKind: (workflowKind: string) => technicalPlanApi.setWorkflowKind(workflowKind),
      switchWorkflowKind: (workflowKind: string) => technicalPlanApi.switchWorkflowKind(workflowKind),
      saveBidAnalysisConfig: (payload) => technicalPlanApi.saveBidAnalysisConfig(payload),
      saveOutlineConfig: (payload) => technicalPlanApi.saveOutlineConfig(payload),
      saveOutline: (payload: unknown) => technicalPlanApi.saveOutline(payload),
      saveGlobalFacts: (globalFacts: unknown) => technicalPlanApi.saveGlobalFacts(globalFacts),
      saveContentGenerationOptions: (options: unknown) => technicalPlanApi.saveContentGenerationOptions(options),
      saveChapterContent: (payload) => technicalPlanApi.saveChapterContent(payload),
      clear: () => technicalPlanApi.clear(),
    },

    // knowledgeBase 命名空间：公司共享知识库 CRUD + 读路径（PG-backed，不按用户隔离）。
    // upload/retry/startMatching/migrateLegacy 待 P4 文件上传 + P6 任务引擎；
    // onEvent 推送待 P6 SSE（此处返回 no-op 退订函数）。
    knowledgeBase: {
      getMigrationStatus: () => knowledgeBaseApi.getMigrationStatus(),
      migrateLegacy: () => Promise.reject(new Error('web 版暂未实现，待 P4/P6')),
      list: () => knowledgeBaseApi.list(),
      createFolder: (name: string) => knowledgeBaseApi.createFolder(name),
      renameFolder: (folderId: string, name: string) => knowledgeBaseApi.renameFolder(folderId, name),
      reorderFolder: (draggedFolderId, targetFolderId, position) =>
        knowledgeBaseApi.reorderFolder(draggedFolderId, targetFolderId, position),
      deleteFolder: (folderId: string) => knowledgeBaseApi.deleteFolder(folderId),
      deleteDocument: (documentId: string) => knowledgeBaseApi.deleteDocument(documentId),
      moveDocument: (documentId, targetFolderId, targetDocumentId, position) =>
        knowledgeBaseApi.moveDocument(documentId, targetFolderId, targetDocumentId ?? null, position),
      uploadDocuments: async (folderId: string) => {
        const files = await pickFiles({ accept: DUPLICATE_CHECK_ACCEPT, multiple: true });
        if (!files || !files.length) {
          return { success: false, message: '已取消选择', documents: [] };
        }
        return knowledgeBaseApi.uploadDocuments(folderId, files);
      },
      retryDocument: (documentId: string) => knowledgeBaseApi.retryDocument(documentId),
      startMatching: (documentId: string, batchSize: number) => knowledgeBaseApi.startMatching(documentId, batchSize),
      readMarkdown: (documentId: string) => knowledgeBaseApi.readMarkdown(documentId),
      readItems: (documentId: string) => knowledgeBaseApi.readItems(documentId),
      readAnalysis: (documentId: string) => knowledgeBaseApi.readAnalysis(documentId),
      onEvent: (callback: (event: { document: KnowledgeDocumentDto }) => void) =>
        sseManager.subscribe('kb-document', (data) => callback(data as { document: KnowledgeDocumentDto })),
    },

    // duplicateCheck 命名空间：标书查重工作区状态读写（PG-backed，按用户隔离）。
    // runAnalysisTask（tasks.startDuplicate-analysis）属 P6 任务引擎；selectDuplicateCheckFiles
    // 属 P4 文件上传——均不在此定义（渲染器侧可选链 no-op）。
    duplicateCheck: {
      loadState: () => duplicateCheckApi.loadState(),
      saveFiles: (payload) => duplicateCheckApi.saveFiles(payload),
      saveUiState: (payload) => duplicateCheckApi.saveUiState(payload),
      updateState: (partial) => duplicateCheckApi.updateState(partial),
      clear: () => duplicateCheckApi.clear(),
    },

    // rejectionCheck 命名空间：废标项检查工作区状态读写（PG-backed，按用户隔离）。
    // importDocument(role)：pickFiles 模拟桌面 dialog（bid 多选 / tender 多选合并）→ multipart 上传。
    // importTenderFromTechnicalPlan：跨域从技术方案读招标文件（无文件上传，纯服务端跨 store 读）。
    // tasks.startRejection* 属 P6 任务引擎，不在此定义（渲染器可选链 no-op）。
    rejectionCheck: {
      loadState: () => rejectionCheckApi.loadState(),
      importDocument: async (role: string) => {
        const isBid = role === 'bid';
        const files = await pickFiles({ accept: DOCUMENT_ACCEPT, multiple: true });
        if (!files?.length) {
          return { success: false, message: '已取消选择', state: await rejectionCheckApi.loadState() };
        }
        return rejectionCheckApi.importDocument(isBid ? 'bid' : 'tender', files);
      },
      importTenderFromTechnicalPlan: () => rejectionCheckApi.importTenderFromTechnicalPlan(),
      removeDocument: (payload) => rejectionCheckApi.removeDocument(payload),
      saveUiState: (payload) => rejectionCheckApi.saveUiState(payload),
      updateState: (partial) => rejectionCheckApi.updateState(partial),
      clear: () => rejectionCheckApi.clear(),
    },
  };
}
