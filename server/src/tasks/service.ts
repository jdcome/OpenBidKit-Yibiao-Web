// M1-P6 Layer 3：任务引擎（taskService）。忠实移植自 client/electron/services/taskService.cjs，
// 适配 Web 多项目 + Prisma 异步 + EventBus 广播。
//
// 桌面是单用户单进程：activeTasks/activeTaskControls 是模块级 Map（按 type 索引）。
// Web 是多项目：改成 Map<projectId, ProjectTaskState>，每项目独立的 activeTasks/controls，
// A 项目的任务不阻塞 B 项目，事件也按 projectId 隔离广播。
//
// 引擎职责（与桌面一致）：
//  - group-exclusive 锁：同组任务互斥（技术方案 5 个任务不能并行；废标项 2 个互斥；查重 1 个）。
//  - startManagedTask：建任务 → 写初始状态 → fire-and-forget 调 runner → catch 标 error。
//  - updateTask：runner 回调用，合并 + 写库 + 广播 {task, ...snapshot} 到 'tasks' 通道。
//  - 崩溃恢复：进程重启后内存 activeTasks 丢失，DB 里残留 running/pausing 任务；getActiveTasks
//    时把它们标 error（content-generation 特殊：标 paused，可点继续恢复），再返回。
//
// runner 注入：L3 注册表为空（start* 抛 "执行器未注册"）；L4 调 registerRunner 落入 9 个 runner。
// runner 不引用 ctx.projectId，全靠引擎预绑定的 workspaceStore 门面（按 projectId 绑定）。
import { randomUUID, createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { eventBus } from '../events/bus';
import { buildMerged } from '../config/store';
import { createDocumentSignature, createRejectionCheckInputSignature } from '../rejection-check/store';
import type { AiService } from '../ai/service';
import type { AgentService } from '../agent/types';
import type { KnowledgeBaseStore } from '../knowledge-base/store';
import type {
  BackgroundTaskState,
  DesktopAiService,
  TaskControl,
  TaskDefinition,
  TaskEvent,
  TaskGroup,
  TaskRunner,
  TaskRunnerContext,
  TaskSnapshot,
  TaskType,
} from './types';

// duplicate-analysis 的负载签名：文件集合变了才允许重跑，否则复用（移植自桌面）。
function createDuplicateCheckPayloadSignature(payload: Record<string, unknown> | undefined): string {
  const tenderFiles = Array.isArray(payload?.tenderFiles) ? payload!.tenderFiles : [payload?.tenderFile].filter(Boolean);
  const files = [...(tenderFiles as unknown[]), ...(Array.isArray(payload?.bidFiles) ? payload!.bidFiles : [])]
    .filter(Boolean)
    .map((file) => {
      const f = file as Record<string, unknown>;
      return `${f.file_path}|${f.size}|${f.modified_at}`;
    });
  return createHash('sha1').update(files.join('\n')).digest('hex');
}

// ---- 工作区 store 适配（engine 只依赖这组方法，不直接耦合具体 store 实现） ----
interface WorkspaceStoreAdapter {
  stateKey: 'technicalPlan' | 'rejectionCheck' | 'duplicateCheck' | 'responseDeviation';
  load(projectId: number): Promise<Record<string, unknown>>;
  update(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface TaskServiceDeps {
  prisma: PrismaClient;
  aiService: AiService;
  agentService?: AgentService;
  technicalPlanStore: {
    loadTechnicalPlan(projectId: number): Promise<Record<string, unknown>>;
    updateTechnicalPlan(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>>;
    readTenderMarkdown(projectId: number): Promise<string>;
    readOriginalTenderMarkdown(projectId: number): Promise<string>;
    readOriginalPlanMarkdown(projectId: number): Promise<string>;
    prepareBidSectionExtraction(projectId: number): Promise<Record<string, unknown>>;
  };
  rejectionCheckStore: {
    loadRejectionCheck(projectId: number): Promise<Record<string, unknown>>;
    updateRejectionCheck(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>>;
    readDocumentMarkdown(projectId: number, roleOrDocumentId?: string): Promise<string>;
  };
  duplicateCheckStore: {
    loadDuplicateCheck(projectId: number): Promise<Record<string, unknown>>;
    updateDuplicateCheck(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  responseDeviationStore: {
    loadResponseDeviation(projectId: number): Promise<Record<string, unknown>>;
    updateResponseDeviation(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>>;
    getWorkspace(projectId: number): Promise<unknown>;
    saveGeneratedRows(args: Record<string, unknown>): Promise<unknown>;
  };
  tenderSourceService: {
    getSnapshot(projectId: number): Promise<unknown>;
  };
  knowledgeBaseService: KnowledgeBaseStore;
  aiDiagnostics?: ReturnType<typeof import('../ai-diagnostics/service').createAiDiagnosticsService>;
}

const TASK_DEFINITIONS: Record<string, TaskDefinition> = {
  'bid-section-extraction': { label: '多标段识别', group: 'technical-plan', groupLabel: '技术方案', step: 2, lockPolicy: 'group-exclusive', stateKey: 'technicalPlan', field: 'bidSectionExtractionTask' },
  'bid-analysis': { label: '招标文件解析', group: 'technical-plan', groupLabel: '技术方案', step: 2, lockPolicy: 'group-exclusive', stateKey: 'technicalPlan', field: 'bidAnalysisTask' },
  'outline-generation': { label: '目录生成', group: 'technical-plan', groupLabel: '技术方案', step: 3, lockPolicy: 'group-exclusive', stateKey: 'technicalPlan', field: 'outlineGenerationTask' },
  'global-facts-generation': { label: '全局事实设定', group: 'technical-plan', groupLabel: '技术方案', step: 4, lockPolicy: 'group-exclusive', stateKey: 'technicalPlan', field: 'globalFactsTask' },
  'content-generation': { label: '正文生成', group: 'technical-plan', groupLabel: '技术方案', step: 5, lockPolicy: 'group-exclusive', stateKey: 'technicalPlan', field: 'contentGenerationTask' },
  'rejection-items-extraction': { label: '无效与废标项解析', group: 'rejection-check', groupLabel: '废标项检查', step: 1, lockPolicy: 'group-exclusive', stateKey: 'rejectionCheck', field: 'extractionTask' },
  'rejection-check-run': { label: '废标项检查', group: 'rejection-check', groupLabel: '废标项检查', step: 2, lockPolicy: 'group-exclusive', stateKey: 'rejectionCheck', field: 'checkTask' },
  'duplicate-analysis': { label: '标书查重分析', group: 'duplicate-check', groupLabel: '标书查重', step: 2, lockPolicy: 'group-exclusive', stateKey: 'duplicateCheck', field: 'analysisTask' },
  'response-deviation-generation': { label: '技术响应与偏离表生成', group: 'response-deviation', groupLabel: '响应与偏离表', step: 1, lockPolicy: 'group-exclusive', stateKey: 'responseDeviation', field: 'generationTask' },
};

function now(): string {
  return new Date().toISOString();
}

function getTaskDefinition(type: string): TaskDefinition {
  return TASK_DEFINITIONS[type] || { label: type, group: 'technical-plan' as TaskGroup, groupLabel: '技术方案', step: 0, lockPolicy: 'none', stateKey: 'technicalPlan' };
}

function getScopeId(payload: Record<string, unknown> | undefined): string {
  const scopeId = payload?.scopeId ?? payload?.scope_id;
  return scopeId === undefined || scopeId === null ? '' : String(scopeId);
}

function getPayloadSignature(type: string, payload: Record<string, unknown> | undefined): string | undefined {
  if (type === 'duplicate-analysis') {
    return createDuplicateCheckPayloadSignature(payload);
  }
  return undefined;
}

function isActiveTaskStatus(status: string | undefined): boolean {
  return status === 'running' || status === 'pausing';
}

function hasOwn(value: unknown, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function copyPatchFields(target: Record<string, unknown>, source: Record<string, unknown> | undefined, fields: string[]): void {
  for (const field of fields) {
    if (hasOwn(source || {}, field)) {
      target[field] = (source as Record<string, unknown>)[field];
    }
  }
}

function createTask(type: string, payload: Record<string, unknown> | undefined): BackgroundTaskState {
  const definition = getTaskDefinition(type);
  const scopeId = getScopeId(payload);
  const payloadSignature = getPayloadSignature(type, payload);
  return {
    task_id: randomUUID(),
    type,
    group: definition.group,
    step: definition.step,
    lock_policy: definition.lockPolicy,
    scope_id: scopeId || undefined,
    payload_signature: payloadSignature,
    status: 'running',
    progress: 0,
    logs: [],
    started_at: now(),
    updated_at: now(),
    pause_requested: false,
  } as BackgroundTaskState;
}

// ---- technicalPlan 快照构造（移植自桌面 buildTechnicalPlanSnapshot，纯函数） ----
function buildTechnicalPlanSnapshot(task: BackgroundTaskState, state: Record<string, unknown> | undefined, eventPatch: Record<string, unknown> | undefined): TaskSnapshot {
  const definition = getTaskDefinition(task.type);
  const patch: Record<string, unknown> = { ...(eventPatch?.technicalPlanPatch || {}) };
  const taskField = definition.field;
  const loaded = state || {};
  if (taskField) {
    patch[taskField] = (loaded as Record<string, unknown>)[taskField] || task;
  }

  if (task.type === 'bid-analysis') {
    copyPatchFields(patch, loaded, ['bidAnalysisMode', 'bidAnalysisProgress', 'projectOverview', 'techRequirements', 'bidAnalysisTasks']);
    if (loaded.outlineData === null) {
      copyPatchFields(patch, loaded, ['outlineData', 'outlineGenerationTask', 'globalFactsTask', 'globalFacts', 'contentGenerationTask', 'contentGenerationOptions', 'contentGenerationSections', 'contentGenerationPlans', 'contentIllustrationPlan', 'contentGenerationRuntime']);
    }
  }

  if (task.type === 'bid-section-extraction') {
    copyPatchFields(patch, loaded, ['bidSectionMode', 'bidSections', 'bidSectionExtractionStatus', 'bidSectionExtractionError', 'tenderFile', 'bidAnalysisTask', 'bidAnalysisTasks', 'bidAnalysisProgress', 'projectOverview', 'techRequirements', 'outlineData', 'outlineGenerationTask', 'referenceKnowledgeDocumentIds', 'globalFactsTask', 'globalFacts', 'contentGenerationTask', 'contentGenerationOptions', 'contentGenerationSections', 'contentGenerationPlans', 'contentIllustrationPlan', 'contentGenerationRuntime']);
  }

  if (task.type === 'outline-generation') {
    copyPatchFields(patch, loaded, ['outlineMode', 'outlineExpansionMode', 'referenceKnowledgeDocumentIds']);
    if (task.status === 'success' || loaded.outlineData === null || hasOwn(eventPatch, 'outlineData')) {
      copyPatchFields(patch, loaded, ['outlineData', 'globalFactsTask', 'globalFacts', 'contentGenerationTask', 'contentGenerationSections', 'contentGenerationPlans', 'contentIllustrationPlan', 'contentGenerationRuntime']);
    }
  }

  if (task.type === 'global-facts-generation') {
    copyPatchFields(patch, loaded, ['globalFacts']);
    if (!isActiveTaskStatus(task.status)) {
      copyPatchFields(patch, loaded, ['contentGenerationTask', 'contentGenerationSections', 'contentGenerationPlans', 'contentIllustrationPlan', 'contentGenerationRuntime']);
    }
  }

  if (task.type === 'content-generation') {
    copyPatchFields(patch, loaded, ['contentIllustrationPlan', 'contentGenerationRuntime']);
    if (!isActiveTaskStatus(task.status)) {
      copyPatchFields(patch, loaded, ['outlineData', 'contentGenerationSections', 'contentGenerationPlans', 'contentIllustrationPlan', 'contentGenerationRuntime']);
    }
  }

  if (hasOwn(eventPatch, 'outlineData')) patch.outlineData = (eventPatch as Record<string, unknown>).outlineData;
  if (hasOwn(eventPatch, 'contentRuntime')) patch.contentGenerationRuntime = (eventPatch as Record<string, unknown>).contentRuntime;

  const snapshot: TaskSnapshot = { technicalPlanPatch: patch };
  if (hasOwn(eventPatch, 'bidItem')) snapshot.bidItem = (eventPatch as Record<string, unknown>).bidItem;
  if (hasOwn(eventPatch, 'outlineData')) snapshot.outlineData = (eventPatch as Record<string, unknown>).outlineData;
  if (hasOwn(eventPatch, 'contentSection')) snapshot.contentSection = (eventPatch as Record<string, unknown>).contentSection;
  if (hasOwn(eventPatch, 'contentPlan')) snapshot.contentPlan = (eventPatch as Record<string, unknown>).contentPlan;
  if (hasOwn(eventPatch, 'contentRuntime')) snapshot.contentRuntime = (eventPatch as Record<string, unknown>).contentRuntime;
  return snapshot;
}

function buildSnapshot(task: BackgroundTaskState, state: Record<string, unknown> | undefined, eventPatch: Record<string, unknown> | undefined): TaskSnapshot {
  const definition = getTaskDefinition(task.type);
  if (definition.stateKey === 'technicalPlan') return buildTechnicalPlanSnapshot(task, state, eventPatch);
  if (definition.stateKey === 'rejectionCheck') return { rejectionCheck: state };
  if (definition.stateKey === 'duplicateCheck') return { duplicateCheck: state };
  if (definition.stateKey === 'responseDeviation') return { responseDeviation: state };
  return {};
}

// 把 web aiService（chat(config,request) 签名）包装成桌面 aiService（chat(request) 签名），
// 自动注入任务启动时快照的 config + __sseProjectId + queueScopeId。
// - __sseProjectId：上游 401/HTTP 错经 emitAiHttpError 路由给触发该任务的 projectId（SSE 通道键）。
// - queueScopeId：使 pauseQueueScope/resumeQueueScope 能 gate 该任务排队的 AI 请求（content-generation pause 用）。
// config 在任务启动时一次性 buildMerged（用 project.ownerId，对齐桌面语义；长任务期间用户改 key 不生效——
// 与桌面单机版 getConfig 读内存的行为一致，可接受）。
function wrapAiForRunner(
  aiService: AiService,
  config: Record<string, unknown>,
  projectId: number,
  queueScopeId: string,
  diagnostic?: { context: Record<string, unknown>; reporter: unknown },
): DesktopAiService {
  const baseConfig = { ...config, __sseProjectId: projectId, queueScopeId };
  const withDiagnostic = (request: Record<string, unknown>) => ({
    ...request,
    ...(diagnostic ? { diagnostic: {
      ...diagnostic,
      context: { ...diagnostic.context, operation: String(request.logTitle || request.progressLabel || diagnostic.context.operation || 'ai-json') },
    } } : {}),
  });
  return {
    chat: (request) => aiService.chat({ ...baseConfig }, withDiagnostic(request)),
    requestJson: (request) => aiService.requestJson({ ...baseConfig }, withDiagnostic(request)),
    collectJsonResponse: (request) => aiService.collectJsonResponse({ ...baseConfig }, withDiagnostic(request)),
    parseJsonResponseContent: (request, content) => aiService.parseJsonResponseContent({ ...baseConfig }, withDiagnostic(request), content),
    getConfig: () => config,
    isDeveloperMode: () => false,
    listModels: (cfg) => aiService.listModels(cfg || config),
    testImageModel: (cfg) => aiService.testImageModel(cfg || config),
  };
}

// ---- 引擎 ----

interface ProjectTaskState {
  activeTasks: Map<string, BackgroundTaskState>;
  activeTaskControls: Map<string, TaskControl>;
}

export class TaskService {
  private projects = new Map<number, ProjectTaskState>();
  private runners = new Map<string, TaskRunner>();
  private readonly deps: TaskServiceDeps;

  constructor(deps: TaskServiceDeps) {
    this.deps = deps;
  }

  /** L4 注册 runner：把某 task type 的真实生成逻辑落入引擎。 */
  registerRunner(type: TaskType, runner: TaskRunner): void {
    this.runners.set(type, runner);
  }

  /** L4 注销 runner（测试/重载用）。 */
  unregisterRunner(type: TaskType): void {
    this.runners.delete(type);
  }

  private projectState(projectId: number): ProjectTaskState {
    let s = this.projects.get(projectId);
    if (!s) {
      s = { activeTasks: new Map(), activeTaskControls: new Map() };
      this.projects.set(projectId, s);
    }
    return s;
  }

  private storeFor(definition: TaskDefinition): WorkspaceStoreAdapter {
    if (definition.stateKey === 'technicalPlan') {
      return { stateKey: 'technicalPlan', load: (p) => this.deps.technicalPlanStore.loadTechnicalPlan(p), update: (p, d) => this.deps.technicalPlanStore.updateTechnicalPlan(p, d) };
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { stateKey: 'rejectionCheck', load: (p) => this.deps.rejectionCheckStore.loadRejectionCheck(p), update: (p, d) => this.deps.rejectionCheckStore.updateRejectionCheck(p, d) };
    }
    if (definition.stateKey === 'responseDeviation') {
      return { stateKey: 'responseDeviation', load: (p) => this.deps.responseDeviationStore.loadResponseDeviation(p), update: (p, d) => this.deps.responseDeviationStore.updateResponseDeviation(p, d) };
    }
    return { stateKey: 'duplicateCheck', load: (p) => this.deps.duplicateCheckStore.loadDuplicateCheck(p), update: (p, d) => this.deps.duplicateCheckStore.updateDuplicateCheck(p, d) };
  }

  // runner 专用 workspaceStore 门面：把多项目 store（首参 projectId）绑成桌面单用户语义
  // （loadRejectionCheck() 无 projectId），并挂上纯函数助手（createDocumentSignature 等）。
  // 桌面 taskService.cjs:531-535 按 definition.stateKey 选 technicalPlanStore/rejectionCheckStore/
  // duplicateCheckStore 注入 runner；web 等价地按 stateKey 返回该域的项目绑定视图。
  // technicalPlan/duplicateCheck 门面随对应 runner 移植逐步补方法（当前仅 load/update）。
  private buildRunnerWorkspaceStore(stateKey: TaskDefinition['stateKey'], projectId: number): Record<string, unknown> {
    if (stateKey === 'rejectionCheck') {
      const rs = this.deps.rejectionCheckStore;
      return {
        loadRejectionCheck: () => rs.loadRejectionCheck(projectId),
        updateRejectionCheck: (partial: Record<string, unknown>) => rs.updateRejectionCheck(projectId, partial),
        readDocumentMarkdown: (roleOrId?: string) => rs.readDocumentMarkdown(projectId, roleOrId),
        createDocumentSignature,
        createRejectionCheckInputSignature,
      };
    }
    if (stateKey === 'technicalPlan') {
      const ts = this.deps.technicalPlanStore;
      return {
        loadTechnicalPlan: () => ts.loadTechnicalPlan(projectId),
        updateTechnicalPlan: (partial: Record<string, unknown>) => ts.updateTechnicalPlan(projectId, partial),
        readTenderMarkdown: () => ts.readTenderMarkdown(projectId),
        readOriginalTenderMarkdown: () => ts.readOriginalTenderMarkdown(projectId),
        readOriginalPlanMarkdown: () => ts.readOriginalPlanMarkdown(projectId),
        prepareBidSectionExtraction: () => ts.prepareBidSectionExtraction(projectId),
      };
    }
    if (stateKey === 'responseDeviation') {
      const rs = this.deps.responseDeviationStore;
      return {
        getTenderSourceSnapshot: () => this.deps.tenderSourceService.getSnapshot(projectId),
        getWorkspace: () => rs.getWorkspace(projectId),
        saveGeneratedRows: (args: Record<string, unknown>) => rs.saveGeneratedRows({ ...args, projectId }),
        loadResponseDeviation: () => rs.loadResponseDeviation(projectId),
        updateResponseDeviation: (partial: Record<string, unknown>) => rs.updateResponseDeviation(projectId, partial),
      };
    }
    const ds = this.deps.duplicateCheckStore;
    return {
      loadDuplicateCheck: () => ds.loadDuplicateCheck(projectId),
      updateDuplicateCheck: (partial: Record<string, unknown>) => ds.updateDuplicateCheck(projectId, partial),
    };
  }

  private emit(projectId: number, task: BackgroundTaskState, snapshot: TaskSnapshot): void {
    const event: TaskEvent = { task, ...snapshot };
    eventBus.emit(String(projectId), 'tasks', event);
  }

  private async getSnapshotForTask(projectId: number, task: BackgroundTaskState): Promise<TaskSnapshot> {
    const definition = getTaskDefinition(task.type);
    const store = this.storeFor(definition);
    const state = await store.load(projectId);
    return buildSnapshot(task, state, undefined);
  }

  private getActiveTaskConflict(projectId: number, type: string, payload: Record<string, unknown> | undefined): { task: BackgroundTaskState; definition: TaskDefinition } | null {
    const definition = getTaskDefinition(type);
    if (definition.lockPolicy === 'none' || !definition.group) return null;
    const nextScopeId = getScopeId(payload);
    const ps = this.projectState(projectId);
    for (const task of ps.activeTasks.values()) {
      if (!isActiveTaskStatus(task.status) || task.type === type) continue;
      const activeDefinition = getTaskDefinition(task.type);
      if (activeDefinition.group !== definition.group) continue;
      if (definition.lockPolicy === 'group-exclusive' || activeDefinition.lockPolicy === 'group-exclusive') {
        return { task, definition: activeDefinition };
      }
      if (definition.lockPolicy === 'scope-exclusive' && nextScopeId && task.scope_id === nextScopeId) {
        return { task, definition: activeDefinition };
      }
    }
    return null;
  }

  private async assertTaskCanStart(projectId: number, type: string, payload: Record<string, unknown> | undefined): Promise<void> {
    const conflict = this.getActiveTaskConflict(projectId, type, payload);
    if (!conflict) {
      const definition = getTaskDefinition(type);
      if (definition.group === 'technical-plan') {
        const technicalPlan = (await this.deps.technicalPlanStore.loadTechnicalPlan(projectId)) || {};
        const pausedContentTask = technicalPlan.contentGenerationTask as BackgroundTaskState | undefined;
        if (pausedContentTask?.status === 'paused') {
          if (type === 'content-generation' && payload?.resume) return;
          throw new Error('正文生成已暂停，请先继续当前正文生成任务或重置技术方案后再启动新的任务。');
        }
      }
      return;
    }
    const definition = getTaskDefinition(type);
    throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${conflict.definition.label || conflict.task.type}”，请完成后再启动“${definition.label || type}”。`);
  }

  // 核心启动器。runner 必须已注册（start* 包装层已校验）。
  private async startManagedTask(
    projectId: number,
    type: string,
    payload: Record<string, unknown> | undefined,
    runner: TaskRunner,
    initialPartial: Record<string, unknown> = {},
  ): Promise<BackgroundTaskState> {
    const ps = this.projectState(projectId);
    const existingTask = ps.activeTasks.get(type);
    if (existingTask && isActiveTaskStatus(existingTask.status)) {
      const nextPayloadSignature = getPayloadSignature(type, payload);
      if (existingTask.payload_signature && nextPayloadSignature && existingTask.payload_signature !== nextPayloadSignature) {
        const definition = getTaskDefinition(type);
        throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${definition.label || type}”，请等待当前任务完成后再重新分析新的文件集合。`);
      }
      const snap = await this.getSnapshotForTask(projectId, existingTask);
      this.emit(projectId, existingTask, snap);
      return { ...existingTask, reused: true };
    }

    await this.assertTaskCanStart(projectId, type, payload);

    const definition = getTaskDefinition(type);
    const task = createTask(type, payload);
    task.diagnostic_trace_id = randomUUID();
    const queueScopeId = `${type}:${task.task_id}`;
    ps.activeTasks.set(type, task);
    const taskField = definition.field;
    const store = this.storeFor(definition);
    let currentTask = task;

    const engine = this;

    const taskControl: TaskControl = {
      queueScopeId,
      pauseRequested: false,
      isPauseRequested() {
        return this.pauseRequested;
      },
      async requestPause() {
        this.pauseRequested = true;
        const pausedLogs = currentTask.logs?.length ? currentTask.logs : ['已请求暂停，正在等待当前 AI 请求完成。'];
        const pausingTask = await updateTask({ status: 'pausing', pause_requested: true, logs: pausedLogs }, true);
        return pausingTask;
      },
    };
    ps.activeTaskControls.set(type, taskControl);

    const updateTask = async (partial: Partial<BackgroundTaskState>, shouldPersist?: boolean, eventPatch?: Record<string, unknown>): Promise<BackgroundTaskState> => {
      const nextStatus = currentTask.status === 'pausing' && partial.status === 'running' ? 'pausing' : partial.status || currentTask.status;
      currentTask = {
        ...currentTask,
        ...partial,
        status: nextStatus,
        pause_requested: partial.pause_requested === false ? false : taskControl.pauseRequested || Boolean(partial.pause_requested),
        logs: partial.logs ? partial.logs : currentTask.logs,
        updated_at: now(),
      } as BackgroundTaskState;
      ps.activeTasks.set(type, currentTask);
      if (shouldPersist) {
        const persistedState = taskField ? await store.update(projectId, { [taskField]: currentTask }) : await store.load(projectId);
        const snapshot = buildSnapshot(currentTask, persistedState, eventPatch);
        engine.emit(projectId, currentTask, snapshot);
      }
      return currentTask;
    };

    const previousState = await store.load(projectId);
    const state = await store.update(projectId, { ...initialPartial, ...(taskField ? { [taskField]: currentTask } : {}) });
    this.emit(projectId, currentTask, buildSnapshot(currentTask, state, undefined));

    // config（含 DeepSeek key）仍按用户存：取项目 owner 的合并配置快照。
    const project = await this.deps.prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    if (!project) throw new Error('项目不存在，无法启动任务');
    const config = await buildMerged(this.deps.prisma, project.ownerId);
    const diagnosticContext = {
      traceId: task.diagnostic_trace_id!, projectId, userId: project.ownerId,
      taskId: task.task_id, taskType: type, operation: type,
    };
    await this.deps.aiDiagnostics?.startRun(diagnosticContext, {
      provider: String(config.text_model_provider || ''), model: String(config.model_name || ''),
      requestMode: String(config.request_mode || ''), status: 'running', stage: 'request',
    });
    const runnerAiService = wrapAiForRunner(this.deps.aiService, config, projectId, queueScopeId, this.deps.aiDiagnostics
      ? { context: diagnosticContext, reporter: this.deps.aiDiagnostics }
      : undefined);

    const ctx: TaskRunnerContext = {
      projectId,
      prisma: this.deps.prisma,
      aiService: runnerAiService,
      agentService: this.deps.agentService,
      workspaceStore: this.buildRunnerWorkspaceStore(definition.stateKey, projectId),
      knowledgeBaseService: this.deps.knowledgeBaseService,
      config,
      updateTask,
      payload: payload || {},
      taskControl,
      previousState,
      diagnosticTraceId: task.diagnostic_trace_id,
      aiDiagnostics: this.deps.aiDiagnostics,
    };

    // fire-and-forget：runner 自驱推进度，完成/失败各自 updateTask。
    Promise.resolve()
      .then(() => runner(ctx))
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const diagnosticError = error as { diagnosticCode?: string; diagnosticStage?: string };
        await this.deps.aiDiagnostics?.finishRun(task.diagnostic_trace_id!, {
          status: 'error', stage: diagnosticError.diagnosticStage || 'complete',
          errorCode: diagnosticError.diagnosticCode || 'AI_UNKNOWN_ERROR', errorMessage: message,
        });
        const failedTask = await updateTask({ status: 'error', error: message || '任务执行失败' }, true);
        ps.activeTasks.delete(type);
        ps.activeTaskControls.delete(type);
        return failedTask;
      })
      .then((finalTask) => {
        // 成功路径：runner 已自行 updateTask({status:'success'})。确保内存清理。
        void finalTask;
        if (currentTask.status !== 'error') {
          void this.deps.aiDiagnostics?.finishRun(task.diagnostic_trace_id!, {
            status: currentTask.degraded ? 'degraded' : 'success', stage: 'complete', degraded: Boolean(currentTask.degraded),
          });
        }
        const aiWithQueue = this.deps.aiService as unknown as { resumeQueueScope?: (scope: string) => void };
        if (aiWithQueue?.resumeQueueScope) aiWithQueue.resumeQueueScope(queueScopeId);
        ps.activeTasks.delete(type);
        ps.activeTaskControls.delete(type);
      });

    return currentTask;
  }

  // ---- 崩溃恢复（进程重启后内存丢失，DB 残留 running/pausing） ----
  private async recoverInterruptedContentGenerationTask(projectId: number): Promise<void> {
    const ps = this.projectState(projectId);
    if (ps.activeTasks.has('content-generation')) return;
    const technicalPlan = (await this.deps.technicalPlanStore.loadTechnicalPlan(projectId)) || {};
    const contentTask = technicalPlan.contentGenerationTask as BackgroundTaskState | undefined;
    if (!isActiveTaskStatus(contentTask?.status)) return;
    // content-generation 特殊：标 paused（可点继续恢复），其余任务标 error。
    // 桌面 normalizeInterruptedContentSections 把 running 子节标 error + 推断 phase；这里保持一致。
    const message = '上次正文生成因应用关闭而暂停，可点击继续恢复。';
    const pausedTask: BackgroundTaskState = {
      ...contentTask!,
      status: 'paused',
      pause_requested: false,
      logs: [...(Array.isArray(contentTask!.logs) ? contentTask!.logs : []), message],
      stats: { ...((contentTask!.stats as Record<string, unknown>) || {}), content: { ...(((contentTask!.stats as { content?: Record<string, unknown> })?.content) || {}), phase: 'generating' } },
      updated_at: now(),
    } as BackgroundTaskState;
    const state = await this.deps.technicalPlanStore.updateTechnicalPlan(projectId, { contentGenerationTask: pausedTask });
    this.emit(projectId, pausedTask, buildSnapshot(pausedTask, state, undefined));
  }

  private async recoverInterruptedSimpleTask(projectId: number, type: string, taskField: string, message: string, extraPartial?: Record<string, unknown>): Promise<void> {
    const ps = this.projectState(projectId);
    if (ps.activeTasks.has(type)) return;
    const technicalPlan = (await this.deps.technicalPlanStore.loadTechnicalPlan(projectId)) || {};
    const task = technicalPlan[taskField] as BackgroundTaskState | undefined;
    if (!isActiveTaskStatus(task?.status)) return;
    const recoveredTask: BackgroundTaskState = {
      ...task!,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(task!.logs) ? task!.logs : []), message],
      updated_at: now(),
    } as BackgroundTaskState;
    const state = await this.deps.technicalPlanStore.updateTechnicalPlan(projectId, { [taskField]: recoveredTask, ...(extraPartial || {}) });
    this.emit(projectId, recoveredTask, buildSnapshot(recoveredTask, state, undefined));
  }

  private async recoverInterruptedBidAnalysisTask(projectId: number): Promise<void> {
    const ps = this.projectState(projectId);
    if (ps.activeTasks.has('bid-analysis')) return;
    const technicalPlan = (await this.deps.technicalPlanStore.loadTechnicalPlan(projectId)) || {};
    const bidAnalysisTask = technicalPlan.bidAnalysisTask as BackgroundTaskState | undefined;
    if (!isActiveTaskStatus(bidAnalysisTask?.status)) return;
    const message = '上次招标文件解析未完成，请重新解析';
    const bidAnalysisTasks = (technicalPlan.bidAnalysisTasks as Record<string, { status?: string; error?: string }>) || {};
    const nextBidAnalysisTasks: Record<string, { status?: string; error?: string }> = {};
    let hasInterruptedItem = false;
    for (const [itemId, item] of Object.entries(bidAnalysisTasks)) {
      if (item?.status === 'running') {
        nextBidAnalysisTasks[itemId] = { ...item, status: 'error', error: message };
        hasInterruptedItem = true;
      } else {
        nextBidAnalysisTasks[itemId] = item;
      }
    }
    const logs = Array.isArray(bidAnalysisTask!.logs) ? bidAnalysisTask!.logs : [];
    const recoveredTask: BackgroundTaskState = {
      ...bidAnalysisTask!,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: logs.includes(message) ? logs : [...logs, message],
      updated_at: now(),
    } as BackgroundTaskState;
    const partial = hasInterruptedItem ? { bidAnalysisTask: recoveredTask, bidAnalysisTasks: nextBidAnalysisTasks } : { bidAnalysisTask: recoveredTask };
    const state = await this.deps.technicalPlanStore.updateTechnicalPlan(projectId, partial);
    this.emit(projectId, recoveredTask, buildSnapshot(recoveredTask, state, undefined));
  }

  private async recoverInterruptedRejectionCheckTasks(projectId: number): Promise<void> {
    const ps = this.projectState(projectId);
    const state = (await this.deps.rejectionCheckStore.loadRejectionCheck(projectId)) || {};
    const partial: Record<string, unknown> = {};
    const staleExtractionMessage = '上次解析未完成，请重新解析';
    const staleCheckMessage = '上次检查未完成，请重新检查';

    if (!ps.activeTasks.has('rejection-items-extraction')) {
      const extractionTask = state.extractionTask as BackgroundTaskState | undefined;
      if (extractionTask?.status === 'running') {
        partial.extractionTask = { ...extractionTask, status: 'error', progress: 100, error: staleExtractionMessage, logs: [staleExtractionMessage], updated_at: now() };
      }
    }
    if (!ps.activeTasks.has('rejection-check-run')) {
      const checkTask = state.checkTask as BackgroundTaskState | undefined;
      if (checkTask?.status === 'running') {
        partial.checkTask = { ...checkTask, status: 'error', progress: 100, error: staleCheckMessage, logs: [staleCheckMessage], updated_at: now() };
      }
    }
    if (Object.keys(partial).length) {
      const nextState = await this.deps.rejectionCheckStore.updateRejectionCheck(projectId, partial);
      if (partial.extractionTask) this.emit(projectId, partial.extractionTask as BackgroundTaskState, { rejectionCheck: nextState });
      if (partial.checkTask) this.emit(projectId, partial.checkTask as BackgroundTaskState, { rejectionCheck: nextState });
    }
  }

  private async recoverInterruptedDuplicateCheckTask(projectId: number): Promise<void> {
    const ps = this.projectState(projectId);
    if (ps.activeTasks.has('duplicate-analysis')) return;
    const state = (await this.deps.duplicateCheckStore.loadDuplicateCheck(projectId)) || {};
    const analysisTask = state.analysisTask as BackgroundTaskState | undefined;
    if (analysisTask?.status !== 'running') return;
    const message = '上次标书查重分析未完成，请重新分析';
    const recoveredTask: BackgroundTaskState = { ...analysisTask, status: 'error', progress: 100, logs: [message], error: message, updated_at: now() } as BackgroundTaskState;
    const nextState = await this.deps.duplicateCheckStore.updateDuplicateCheck(projectId, { analysisTask: recoveredTask });
    this.emit(projectId, recoveredTask, { duplicateCheck: nextState });
  }

  private async recoverInterruptedResponseDeviationTask(projectId: number): Promise<void> {
    const ps = this.projectState(projectId);
    if (ps.activeTasks.has('response-deviation-generation')) return;
    const state = (await this.deps.responseDeviationStore.loadResponseDeviation(projectId)) || {};
    const generationTask = state.generationTask as BackgroundTaskState | undefined;
    if (!generationTask || !isActiveTaskStatus(generationTask.status)) return;
    const message = '上次偏离表生成未完成，请重新生成';
    const recoveredTask: BackgroundTaskState = { ...generationTask, status: 'error', progress: 100, logs: [message], error: message, updated_at: now() } as BackgroundTaskState;
    const nextState = await this.deps.responseDeviationStore.updateResponseDeviation(projectId, { generationTask: recoveredTask });
    this.emit(projectId, recoveredTask, { responseDeviation: nextState });
  }

  /** 全量崩溃恢复（某项目）：getActiveTasks 与 boot 扫描调用。 */
  async recoverAllInterruptedTasks(projectId: number): Promise<void> {
    await this.recoverInterruptedSimpleTask(projectId, 'bid-section-extraction', 'bidSectionExtractionTask', '上次多标段识别未完成，请重新识别', { bidSectionExtractionStatus: 'error', bidSectionExtractionError: '上次多标段识别未完成，请重新识别' });
    await this.recoverInterruptedBidAnalysisTask(projectId);
    await this.recoverInterruptedSimpleTask(projectId, 'outline-generation', 'outlineGenerationTask', '上次目录生成未完成，请重新生成目录；如旧方案目录提取已有进度，将自动继续。');
    await this.recoverInterruptedContentGenerationTask(projectId);
    await this.recoverInterruptedSimpleTask(projectId, 'global-facts-generation', 'globalFactsTask', '上次全局事实设定未完成，请重新解析');
    await this.recoverInterruptedRejectionCheckTasks(projectId);
    await this.recoverInterruptedDuplicateCheckTask(projectId);
    await this.recoverInterruptedResponseDeviationTask(projectId);
  }

  // ---- 公开 API（对齐桌面 taskService 返回，全部加 projectId 首参） ----

  async getActiveTasks(projectId: number): Promise<BackgroundTaskState[]> {
    await this.recoverAllInterruptedTasks(projectId);
    const ps = this.projectState(projectId);
    return Array.from(ps.activeTasks.values());
  }

  private async startTyped(projectId: number, type: TaskType, payload: Record<string, unknown> | undefined, initialPartial: Record<string, unknown>): Promise<BackgroundTaskState> {
    const runner = this.runners.get(type);
    if (!runner) {
      const definition = getTaskDefinition(type);
      throw new Error(`${definition.label}任务的执行器尚未注册（待 P6-L4 移植）`);
    }
    return this.startManagedTask(projectId, type, payload, runner, initialPartial);
  }

  startBidSectionExtraction(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return this.startTyped(projectId, 'bid-section-extraction', payload, {
      bidSectionMode: 'multiple', bidSections: [], bidSectionExtractionStatus: 'running', bidSectionExtractionError: undefined,
      bidAnalysisTask: undefined, bidAnalysisTasks: {}, bidAnalysisProgress: 0, projectOverview: '', techRequirements: '',
      outlineData: null, outlineGenerationTask: undefined, referenceKnowledgeDocumentIds: [], globalFactsTask: undefined, globalFacts: [],
      contentGenerationTask: undefined, contentGenerationOptions: undefined, contentGenerationSections: {}, contentGenerationPlans: {}, contentGenerationRuntime: undefined,
    });
  }

  startBidAnalysis(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return this.startTyped(projectId, 'bid-analysis', payload, {});
  }

  startOutlineGeneration(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    const p = payload || {};
    return this.startTyped(projectId, 'outline-generation', payload, {
      outlineMode: 'aligned',
      outlineExpansionMode: p.outline_expansion_mode === 'original-only' ? 'original-only' : 'ai-complement',
      referenceKnowledgeDocumentIds: Array.isArray(p.reference_knowledge_document_ids) ? p.reference_knowledge_document_ids : [],
      mirrorProcurement: p.mirror_procurement !== false,
    });
  }

  startGlobalFactsGeneration(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return this.startTyped(projectId, 'global-facts-generation', payload, { globalFacts: [], contentGenerationTask: undefined, contentGenerationSections: {}, contentGenerationPlans: {}, contentGenerationRuntime: undefined });
  }

  startContentGeneration(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return this.startTyped(projectId, 'content-generation', payload, {});
  }

  async pauseContentGeneration(projectId: number): Promise<BackgroundTaskState> {
    const ps = this.projectState(projectId);
    const task = ps.activeTasks.get('content-generation');
    const control = ps.activeTaskControls.get('content-generation');
    const aiWithQueue = this.deps.aiService as unknown as { pauseQueueScope?: (scope: string) => void };
    if (task && isActiveTaskStatus(task.status) && control) {
      if (control.queueScopeId && aiWithQueue?.pauseQueueScope) aiWithQueue.pauseQueueScope(control.queueScopeId);
      return control.requestPause();
    }
    const technicalPlan = (await this.deps.technicalPlanStore.loadTechnicalPlan(projectId)) || {};
    const contentTask = technicalPlan.contentGenerationTask as BackgroundTaskState | undefined;
    if (contentTask?.status === 'paused' || contentTask?.status === 'pausing') return contentTask;
    throw new Error('当前没有正在生成的正文任务。');
  }

  startRejectionItemsExtraction(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    const p = payload || {};
    return this.startTyped(projectId, 'rejection-items-extraction', payload, (p.workspaceState as Record<string, unknown>) || {});
  }

  startRejectionCheck(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    const p = payload || {};
    return this.startTyped(projectId, 'rejection-check-run', payload, (p.workspaceState as Record<string, unknown>) || {});
  }

  startDuplicateAnalysis(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return this.startTyped(projectId, 'duplicate-analysis', payload, {});
  }

  startResponseDeviationGeneration(projectId: number, payload?: Record<string, unknown>): Promise<BackgroundTaskState> {
    return this.startTyped(projectId, 'response-deviation-generation', payload, { status: 'detecting' });
  }
}
