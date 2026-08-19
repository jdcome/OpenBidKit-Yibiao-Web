import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DocumentAnalysisPage from './DocumentAnalysisPage';
import BidAnalysisPage from './BidAnalysisPage';
import OutlineEditPage from './OutlineEditPage';
import GlobalFactsPage from './GlobalFactsPage';
import ContentEditPage from './ContentEditPage';
import AgentQuestionDialog from '../components/AgentQuestionDialog';
import { TemplatePreview } from '../../export-format/pages/ExportFormatPage';
import { useTechnicalPlanWorkflow } from '../hooks/useTechnicalPlanWorkflow';
import { useBidAnalysisCatalog } from '../hooks/useBidAnalysisCatalog';
import { FloatingToolbar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, useToast } from '../../../shared/ui';
import { useProject } from '../../../app/ProjectContext';
import { updateProject } from '../../../shared/api/projects';
import { answerAgentQuestion, getPendingAgentQuestion, type AgentPendingQuestion } from '../../../shared/api/agent';
import { sseManager } from '../../../shared/api/sse';
import type { BackgroundTaskState, BidAnalysisTasks, ContentGenerationOptions, GlobalFactGroupState, SaveOutlineRequest, TechnicalPlanState, TechnicalPlanStep, TechnicalPlanWorkflowKind } from '../types';
import type { OutlineData, OutlineItem, WordExportProgressEvent } from '../../../shared/types';
import type { ExportFormatConfig, ExportTemplateRecord } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import type { SectionId } from '../../../shared/types/navigation';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { shouldBlockSubjectIdentityBeforeNext } from '../utils/subjectIdentity';
import { responseDeviationApi } from '../../../shared/api/response-deviation';
import type { ResponseDeviationAvailability } from '../../response-deviation/types';
import { writeResponseDeviationIntent } from '../../response-deviation/utils/navigationIntent';

interface TechnicalPlanHomeProps {
  workflowKind: TechnicalPlanWorkflowKind;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  onSectionChange?: (section: SectionId) => void;
}

interface OutlineSortGuard {
  hasUnsavedSort: () => boolean;
  saveSort: () => Promise<void>;
  discardSort: () => void;
}

interface WorkflowSwitchRequest {
  from: TechnicalPlanWorkflowKind;
  to: TechnicalPlanWorkflowKind;
  navigateBackOnCancel: boolean;
}

const steps: TechnicalPlanStep[] = [
  'document-analysis',
  'bid-analysis',
  'outline-generation',
  'global-facts',
  'content-edit',
  'expand',
];

const stepLabels: Record<TechnicalPlanStep, string> = {
  'document-analysis': '选择标书',
  'bid-analysis': '招标文件解析',
  'outline-generation': '目录生成',
  'global-facts': '全局事实设定',
  'content-edit': '生成正文',
  expand: '扩写改写',
};

const resetState = {
  workflowKind: 'technical-plan' as TechnicalPlanWorkflowKind,
  step: 'document-analysis' as TechnicalPlanStep,
  tenderFile: null,
  tenderFiles: [],
  originalPlanFile: null,
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key' as const,
  bidAnalysisSelectedTaskIds: [] as string[],
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  bidSectionMode: 'single' as const,
  bidSections: [],
  bidSectionExtractionStatus: 'idle' as const,
  bidSectionExtractionError: undefined,
  outlineMode: 'aligned' as const,
  outlineExpansionMode: 'ai-complement' as const,
  mirrorProcurementEnabled: true,
  outlineWordControlOptions: {
    minWordsWan: 0,
    maxWordsWan: 0,
    wordsPerSectionWan: 0,
    forceSectionWords: false,
  },
  referenceKnowledgeDocumentIds: [] as string[],
  bidSectionExtractionTask: undefined,
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  globalFactsTask: undefined,
  globalFacts: [] as GlobalFactGroupState[],
  contentGenerationTask: undefined,
  contentGenerationOptions: undefined,
  contentGenerationSections: {},
  contentGenerationPlans: {},
  contentIllustrationPlan: undefined,
  contentGenerationRuntime: undefined,
  outlineData: null,
};

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => item.children?.length ? collectLeafItems(item.children) : [item]);
}

function countMermaidDiagrams(content: string) {
  const mermaidBlocks = (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
  const mermaidInkImages = (String(content || '').match(/https:\/\/mermaid\.ink\/img\//gi) || []).length;
  return mermaidBlocks + mermaidInkImages;
}

function countOutlineMermaidDiagrams(items: OutlineItem[]) {
  return collectLeafItems(items).reduce((sum, item) => sum + countMermaidDiagrams(item.content || ''), 0);
}

interface ExportProgressState {
  open: boolean;
  running: boolean;
  progress: number;
  message: string;
  warnings: string[];
  mermaidCount: number;
  filePath?: string;
  error?: string;
}

const initialExportProgress: ExportProgressState = {
  open: false,
  running: false,
  progress: 0,
  message: '',
  warnings: [],
  mermaidCount: 0,
};

const MAX_UI_TASK_LOGS = 80;

function hasOwnField<T extends object>(value: T, field: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function trimTaskLogs(task?: BackgroundTaskState): BackgroundTaskState | undefined {
  if (!task?.logs || task.logs.length <= MAX_UI_TASK_LOGS) {
    return task;
  }

  return { ...task, logs: task.logs.slice(-MAX_UI_TASK_LOGS) };
}

function areRequiredBidAnalysisTasksReady(tasks: BidAnalysisTasks, requiredIds: string[]) {
  return requiredIds.every((id) => {
    const state = tasks[id];
    return state?.status === 'success' && state.content.trim();
  });
}

function workflowKindFromSection(section?: string): TechnicalPlanWorkflowKind | null {
  if (section === 'technical-plan') return 'technical-plan';
  if (section === 'existing-plan-expansion') return 'existing-plan-expansion';
  return null;
}

function workflowLabel(kind: TechnicalPlanWorkflowKind) {
  return kind === 'existing-plan-expansion' ? '已有方案扩写' : '生成技术方案';
}

function hasRunningTechnicalPlanTask(state: TechnicalPlanState) {
  return [state.bidSectionExtractionTask, state.bidAnalysisTask, state.outlineGenerationTask, state.globalFactsTask, state.contentGenerationTask]
    .some((task) => task?.status === 'running' || task?.status === 'pausing');
}

function hasWorkflowSpecificProgress(state: TechnicalPlanState) {
  return Boolean(
    state.originalPlanFile
    || state.bidSectionMode === 'multiple'
    || state.bidSections.length > 0
    || state.bidSectionExtractionTask
    || state.outlineData
    || state.globalFacts.length > 0
    || Object.keys(state.contentGenerationSections || {}).length > 0
    || Object.keys(state.contentGenerationPlans || {}).length > 0
    || state.contentIllustrationPlan
    || state.contentGenerationRuntime
    || state.contentGenerationOptions
    || state.outlineGenerationTask
    || state.globalFactsTask
    || state.contentGenerationTask
    || ['outline-generation', 'global-facts', 'content-edit', 'expand'].includes(state.step),
  );
}

function updateOutlineItemContent(items: OutlineItem[], itemId: string, content: string): OutlineItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return { ...item, content };
    }

    return item.children?.length
      ? { ...item, children: updateOutlineItemContent(item.children, itemId, content) }
      : item;
  });
}

function TechnicalPlanHome({ workflowKind, registerLeaveGuard, onSectionChange }: TechnicalPlanHomeProps) {
  const { hydrated, state, setState } = useTechnicalPlanWorkflow();
  const { showToast } = useToast();
  const { activeProject, refresh: refreshProject } = useProject();
  const projectId = activeProject?.id ?? null;
  const bidderName = activeProject?.bidderName ?? '';
  const subjectIdentityPromptKey = projectId ? `yibiao_subject_identity_prompt_${projectId}` : undefined;
  const handleBidderNameChange = useCallback((value: string) => {
    if (!projectId) return Promise.resolve();
    return updateProject(projectId, { bidderName: value }).then(() => {
      refreshProject();
    }).catch((error) => {
      showToast(error instanceof Error ? error.message : '保存我方公司全称失败', 'error');
      throw error;
    });
  }, [projectId, refreshProject, showToast]);
  const subjectReplacements = activeProject?.subjectReplacements ?? [];
  const handleSubjectReplacementsChange = useCallback((list: import('../../../shared/api/projects').SubjectReplacement[]) => {
    if (!projectId) return Promise.resolve();
    return updateProject(projectId, { subjectReplacements: list }).then(() => {
      refreshProject();
    }).catch((error) => {
      showToast(error instanceof Error ? error.message : '保存代称替换表失败', 'error');
      throw error;
    });
  }, [projectId, refreshProject, showToast]);
  // 采购人（甲方）名称：从投标分析 partAInfo 结果里取 company_name（扫描所有任务 JSON）。
  const bidAnalysisBuyerName = useMemo(() => {
    const tasks = state.bidAnalysisTasks;
    if (!tasks) return '';
    for (const task of Object.values(tasks)) {
      if (task.status !== 'success' || !task.content) continue;
      try {
        const obj = JSON.parse(task.content);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          const v = (obj as Record<string, unknown>).company_name;
          if (typeof v === 'string' && v.trim()) return v.trim();
        }
      } catch {
        /* 忽略非 JSON 内容 */
      }
    }
    return '';
  }, [state.bidAnalysisTasks]);
  const [tenderMarkdown, setTenderMarkdown] = useState('');
  const [originalPlanMarkdown, setOriginalPlanMarkdown] = useState('');
  const [exportProgress, setExportProgress] = useState<ExportProgressState>(initialExportProgress);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [exportTemplateDialogOpen, setExportTemplateDialogOpen] = useState(false);
  const [exportTemplates, setExportTemplates] = useState<ExportTemplateRecord[]>([]);
  const [exportTemplatesLoading, setExportTemplatesLoading] = useState(false);
  const [exportTemplateSearch, setExportTemplateSearch] = useState('');
  const [selectedExportTemplateId, setSelectedExportTemplateId] = useState('');
  const [sortLeaveDialogOpen, setSortLeaveDialogOpen] = useState(false);
  const [savingSortBeforeLeave, setSavingSortBeforeLeave] = useState(false);
  const [workflowSwitchRequest, setWorkflowSwitchRequest] = useState<WorkflowSwitchRequest | null>(null);
  const [switchingWorkflow, setSwitchingWorkflow] = useState(false);
  const [subjectIdentityOpenSignal, setSubjectIdentityOpenSignal] = useState(0);
  const [agentQuestion, setAgentQuestion] = useState<AgentPendingQuestion | null>(null);
  const [answeringAgentQuestion, setAnsweringAgentQuestion] = useState(false);
  const [responseDeviationAvailability, setResponseDeviationAvailability] = useState<ResponseDeviationAvailability | null>(null);
  const sortGuardRef = useRef<OutlineSortGuard | null>(null);
  const sortLeaveResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const workflowSwitchResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const skippedWorkflowSwitchPromptRef = useRef<TechnicalPlanWorkflowKind | null>(null);
  const lastExecutedWorkflowSwitchRef = useRef<TechnicalPlanWorkflowKind | null>(null);
  const activeIndex = steps.indexOf(state.step);
  const { tasks: bidAnalysisCatalogTasks } = useBidAnalysisCatalog();
  const requiredBidAnalysisTaskIds = useMemo(
    () => bidAnalysisCatalogTasks.filter((task) => task.required).map((task) => task.id),
    [bidAnalysisCatalogTasks],
  );
  const requiredBidAnalysisReady = areRequiredBidAnalysisTasksReady(state.bidAnalysisTasks, requiredBidAnalysisTaskIds);
  const isBidSectionExtractionRunning = state.bidSectionExtractionTask?.status === 'running' || state.bidSectionExtractionTask?.status === 'pausing';
  const isBidAnalysisTaskRunning = state.bidAnalysisTask?.status === 'running' || state.bidAnalysisTask?.status === 'pausing';
  const selectedBidSectionValid = state.bidSectionMode !== 'multiple'
    || Boolean(state.tenderFile?.selectedSectionId && state.bidSections.some((section) => section.id === state.tenderFile?.selectedSectionId));
  const bidSectionReady = state.bidSectionMode !== 'multiple'
    || (state.bidSectionExtractionStatus === 'success' && !isBidSectionExtractionRunning && selectedBidSectionValid);
  const bidAnalysisReady = requiredBidAnalysisReady && !isBidAnalysisTaskRunning && bidSectionReady;
  const globalFactsReady = state.globalFacts.length > 0 && state.globalFactsTask?.status === 'success';
  const contentTaskStatus = state.contentGenerationTask?.status;
  const isContentGenerating = contentTaskStatus === 'running' || contentTaskStatus === 'pausing';
  const isContentPaused = contentTaskStatus === 'paused';
  const isExporting = exportProgress.running;
  const shouldPromptResponseDeviation = Boolean(responseDeviationAvailability?.available
    && (!responseDeviationAvailability.workspaceExists || responseDeviationAvailability.workspaceStatus === 'stale'));
  const filteredExportTemplates = useMemo(() => {
    const keyword = exportTemplateSearch.trim().toLowerCase();
    if (!keyword) return exportTemplates;
    return exportTemplates.filter((template) => template.template_name.toLowerCase().includes(keyword));
  }, [exportTemplateSearch, exportTemplates]);

  useEffect(() => {
    if (workflowKind !== 'technical-plan' || state.step !== 'content-edit' || !projectId) {
      setResponseDeviationAvailability(null);
      return;
    }
    let alive = true;
    void responseDeviationApi.availability()
      .then((result) => { if (alive) setResponseDeviationAvailability(result); })
      .catch(() => { if (alive) setResponseDeviationAvailability(null); });
    return () => { alive = false; };
  }, [workflowKind, state.step, projectId, state.tenderFile?.selectedSectionId]);
  const selectedExportTemplate = filteredExportTemplates.find((template) => template.template_id === selectedExportTemplateId) || filteredExportTemplates[0] || null;
  const exportTemplatePreviewStyle = useMemo(() => buildExportFormatCssVars(selectedExportTemplate?.config || exportFormat), [exportFormat, selectedExportTemplate]);
  const requiresOriginalPlan = workflowKind === 'existing-plan-expansion';
  const isNextDisabled = activeIndex >= steps.length - 1
    || (state.step === 'document-analysis' && (!state.tenderFile || (requiresOriginalPlan && !state.originalPlanFile)))
    || (state.step === 'bid-analysis' && !bidAnalysisReady)
    || (state.step === 'outline-generation' && !state.outlineData)
    || (state.step === 'global-facts' && !globalFactsReady);
  const nextTooltip = state.step === 'document-analysis' && !state.tenderFile
      ? '上传完招标文件后才能进入下一步'
      : state.step === 'document-analysis' && requiresOriginalPlan && !state.originalPlanFile
        ? '上传完原方案后才能进入下一步'
        : state.step === 'bid-analysis' && isBidSectionExtractionRunning
          ? '多标段识别任务仍在运行，请等待当前任务结束'
          : state.step === 'bid-analysis' && state.bidSectionMode === 'multiple' && state.bidSectionExtractionStatus === 'error'
            ? '请重新识别标段或切回单标段'
            : state.step === 'bid-analysis' && state.bidSectionMode === 'multiple' && !selectedBidSectionValid
              ? '请先选择本次投标范围'
              : state.step === 'bid-analysis' && isBidAnalysisTaskRunning
                ? '招标文件解析任务仍在运行，请等待当前任务结束'
                : state.step === 'bid-analysis' && !requiredBidAnalysisReady
                  ? '招标文件解析完成后才能进入目录生成'
                  : state.step === 'outline-generation' && !state.outlineData
                    ? '目录生成完成后才能进入全局事实设定'
                    : state.step === 'global-facts' && !globalFactsReady
                      ? '全局事实设定完成后才能进入正文生成'
                      : activeIndex >= steps.length - 1
                        ? '当前已经是最后一步'
                        : `进入${stepLabels[steps[activeIndex + 1]]}`;

  useEffect(() => {
    let cancelled = false;
    getPendingAgentQuestion()
      .then((question) => {
        if (!cancelled) setAgentQuestion(question);
      })
      .catch(() => {
        if (!cancelled) setAgentQuestion(null);
      });
    const unsubscribe = sseManager.subscribe('agent-question', (data) => {
      if (!data || typeof data !== 'object' || !('question_id' in data)) {
        setAgentQuestion(null);
        return;
      }
      setAgentQuestion(data as AgentPendingQuestion);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);

  const submitAgentQuestionAnswer = useCallback(async (optionId: string) => {
    if (!agentQuestion || !optionId) return;
    setAnsweringAgentQuestion(true);
    try {
      await answerAgentQuestion({ question_id: agentQuestion.question_id, option_id: optionId });
      setAgentQuestion(null);
      showToast('已提交选择，后台任务将继续执行', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '提交选择失败', 'error');
    } finally {
      setAnsweringAgentQuestion(false);
    }
  }, [agentQuestion, showToast]);

  const deferAgentQuestion = useCallback(() => {
    if (!agentQuestion) return;
    const deferOption = agentQuestion.options.find((option) => option.id === 'defer' || /稍后|暂停|处理/.test(option.label || ''));
    const optionId = deferOption?.id || deferOption?.label || agentQuestion.options[0]?.id || '';
    if (optionId) {
      void submitAgentQuestionAnswer(optionId);
    }
  }, [agentQuestion, submitAgentQuestionAnswer]);

  const resolveSortLeave = (allowed: boolean) => {
    sortLeaveResolverRef.current?.(allowed);
    sortLeaveResolverRef.current = null;
    setSortLeaveDialogOpen(false);
  };

  const executeWorkflowSwitch = useCallback(async (targetWorkflowKind: TechnicalPlanWorkflowKind) => {
    if (!window.yibiao?.technicalPlan.switchWorkflowKind) {
      showToast('技术方案工作流切换服务尚未初始化', 'error');
      return false;
    }

    try {
      setSwitchingWorkflow(true);
      const saved = await window.yibiao.technicalPlan.switchWorkflowKind(targetWorkflowKind);
      lastExecutedWorkflowSwitchRef.current = targetWorkflowKind;
      setState((prev) => ({ ...prev, ...saved, workflowKind: targetWorkflowKind }));
      setOriginalPlanMarkdown('');
      showToast(`已切换到${workflowLabel(targetWorkflowKind)}`, 'success');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '切换技术方案工作流失败', 'error');
      return false;
    } finally {
      setSwitchingWorkflow(false);
    }
  }, [setState, showToast]);

  const resolveWorkflowSwitch = useCallback((allowed: boolean) => {
    const request = workflowSwitchRequest;
    workflowSwitchResolverRef.current?.(allowed);
    workflowSwitchResolverRef.current = null;
    setWorkflowSwitchRequest(null);
    if (!allowed && request?.navigateBackOnCancel) {
      skippedWorkflowSwitchPromptRef.current = request.to;
      onSectionChange?.(request.from);
    }
  }, [onSectionChange, workflowSwitchRequest]);

  const openWorkflowSwitchDialog = useCallback((targetWorkflowKind: TechnicalPlanWorkflowKind, navigateBackOnCancel: boolean) => {
    setWorkflowSwitchRequest({
      from: state.workflowKind,
      to: targetWorkflowKind,
      navigateBackOnCancel,
    });
    return new Promise<boolean>((resolve) => {
      workflowSwitchResolverRef.current = resolve;
    });
  }, [state.workflowKind]);

  const confirmSortLeaveOnly = useCallback(async () => {
    const guard = sortGuardRef.current;
    if (!guard?.hasUnsavedSort()) {
      return true;
    }

    setSortLeaveDialogOpen(true);
    return new Promise<boolean>((resolve) => {
      sortLeaveResolverRef.current = resolve;
    });
  }, []);

  const confirmPendingSortLeave = useCallback(async (nextSection?: string) => {
    const targetWorkflowKind = workflowKindFromSection(nextSection);
    if (!targetWorkflowKind || targetWorkflowKind === state.workflowKind) {
      return confirmSortLeaveOnly();
    }

    if (hasRunningTechnicalPlanTask(state)) {
      showToast('当前有技术方案任务正在运行，请等待任务结束后再切换模式', 'info');
      return false;
    }

    const sortAllowed = await confirmSortLeaveOnly();
    if (!sortAllowed) {
      return false;
    }

    if (hasWorkflowSpecificProgress(state)) {
      return openWorkflowSwitchDialog(targetWorkflowKind, false);
    }

    return executeWorkflowSwitch(targetWorkflowKind);
  }, [confirmSortLeaveOnly, executeWorkflowSwitch, openWorkflowSwitchDialog, showToast, state]);

  const continueSorting = () => {
    resolveSortLeave(false);
  };

  const discardSortAndLeave = () => {
    sortGuardRef.current?.discardSort();
    resolveSortLeave(true);
  };

  const saveSortAndLeave = async () => {
    const guard = sortGuardRef.current;
    if (!guard) {
      resolveSortLeave(true);
      return;
    }

    try {
      setSavingSortBeforeLeave(true);
      await guard.saveSort();
      resolveSortLeave(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存排序失败', 'error');
    } finally {
      setSavingSortBeforeLeave(false);
    }
  };

  const cancelWorkflowSwitch = () => {
    resolveWorkflowSwitch(false);
  };

  const confirmWorkflowSwitch = async () => {
    if (!workflowSwitchRequest) {
      return;
    }

    const switched = await executeWorkflowSwitch(workflowSwitchRequest.to);
    if (switched) {
      resolveWorkflowSwitch(true);
    }
  };

  useEffect(() => {
    if (!hydrated || state.workflowKind === workflowKind) return;
    if (skippedWorkflowSwitchPromptRef.current === workflowKind) return;
    if (lastExecutedWorkflowSwitchRef.current === state.workflowKind) return;
    if (workflowSwitchRequest || switchingWorkflow) return;

    const run = async () => {
      if (hasRunningTechnicalPlanTask(state)) {
        showToast('当前有技术方案任务正在运行，请等待任务结束后再切换模式', 'info');
        onSectionChange?.(state.workflowKind);
        return;
      }

      if (hasWorkflowSpecificProgress(state)) {
        await openWorkflowSwitchDialog(workflowKind, true);
        return;
      }

      const switched = await executeWorkflowSwitch(workflowKind);
      if (!switched) {
        onSectionChange?.(state.workflowKind);
      }
    };

    void run();
  }, [executeWorkflowSwitch, hydrated, onSectionChange, openWorkflowSwitchDialog, showToast, state, switchingWorkflow, workflowKind, workflowSwitchRequest]);

  useEffect(() => {
    if (state.workflowKind === workflowKind) {
      skippedWorkflowSwitchPromptRef.current = null;
      lastExecutedWorkflowSwitchRef.current = null;
    }
  }, [state.workflowKind, workflowKind]);

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((cfg) => {
      if (!cancelled && cfg?.export_format) {
        setExportFormat(cfg.export_format);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!registerLeaveGuard) return;
    registerLeaveGuard(confirmPendingSortLeave);
    return () => registerLeaveGuard(null);
  }, [confirmPendingSortLeave, registerLeaveGuard]);

  const switchStep = async (step: TechnicalPlanStep) => {
    if (step === state.step) {
      return;
    }
    const allowed = await confirmPendingSortLeave();
    if (!allowed) {
      return;
    }

    setState((prev) => ({ ...prev, step }));
    window.yibiao?.technicalPlan.updateStep(step).catch((error) => {
      showToast(error instanceof Error ? error.message : '保存技术方案步骤失败', 'error');
    });
  };

  const goToOffset = async (offset: number) => {
    const nextStep = steps[activeIndex + offset];
    if (nextStep) {
      if (offset > 0 && state.step === 'global-facts' && nextStep === 'content-edit') {
        const promptStatus = subjectIdentityPromptKey
          ? window.localStorage.getItem(subjectIdentityPromptKey)
          : null;
        if (shouldBlockSubjectIdentityBeforeNext(promptStatus === 'confirmed' || promptStatus === 'dismissed' ? promptStatus : null)) {
          setSubjectIdentityOpenSignal((value) => value + 1);
          showToast('请先确认投标主体与代称替换，再进入正文生成', 'info');
          return;
        }
      }
      await switchStep(nextStep);
    }
  };

  useEffect(() => {
    if (!window.yibiao?.tasks) {
      return;
    }

    const unsubscribe = window.yibiao.tasks.onTaskEvent<typeof state>((event) => {
      const taskType = (event.task as { type?: string } | undefined)?.type;
      const latestTask = trimTaskLogs(event.task as BackgroundTaskState | undefined);
      const technicalPlan = event.technicalPlanPatch || event.technicalPlan;

      if (!technicalPlan) {
        return;
      }

      setState((prev) => {
        if (taskType === 'bid-section-extraction') {
          return {
            ...prev,
            bidSectionExtractionTask: trimTaskLogs(technicalPlan.bidSectionExtractionTask) || latestTask,
            bidSectionMode: technicalPlan.bidSectionMode ?? prev.bidSectionMode,
            bidSections: Array.isArray(technicalPlan.bidSections) ? technicalPlan.bidSections : prev.bidSections,
            bidSectionExtractionStatus: technicalPlan.bidSectionExtractionStatus ?? prev.bidSectionExtractionStatus,
            bidSectionExtractionError: technicalPlan.bidSectionExtractionError ?? prev.bidSectionExtractionError,
            tenderFile: technicalPlan.tenderFile ?? prev.tenderFile,
            bidAnalysisTask: hasOwnField(technicalPlan, 'bidAnalysisTask') ? trimTaskLogs(technicalPlan.bidAnalysisTask) : prev.bidAnalysisTask,
            bidAnalysisTasks: hasOwnField(technicalPlan, 'bidAnalysisTasks') ? (technicalPlan.bidAnalysisTasks || {}) : prev.bidAnalysisTasks,
            bidAnalysisProgress: technicalPlan.bidAnalysisProgress ?? prev.bidAnalysisProgress,
            projectOverview: technicalPlan.projectOverview ?? prev.projectOverview,
            techRequirements: technicalPlan.techRequirements ?? prev.techRequirements,
            outlineData: hasOwnField(technicalPlan, 'outlineData') ? (technicalPlan.outlineData || null) : prev.outlineData,
            outlineGenerationTask: hasOwnField(technicalPlan, 'outlineGenerationTask') ? trimTaskLogs(technicalPlan.outlineGenerationTask) : prev.outlineGenerationTask,
            referenceKnowledgeDocumentIds: Array.isArray(technicalPlan.referenceKnowledgeDocumentIds) ? technicalPlan.referenceKnowledgeDocumentIds : prev.referenceKnowledgeDocumentIds,
            globalFactsTask: hasOwnField(technicalPlan, 'globalFactsTask') ? trimTaskLogs(technicalPlan.globalFactsTask) : prev.globalFactsTask,
            globalFacts: hasOwnField(technicalPlan, 'globalFacts') ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: hasOwnField(technicalPlan, 'contentGenerationTask') ? trimTaskLogs(technicalPlan.contentGenerationTask) : prev.contentGenerationTask,
            contentGenerationOptions: hasOwnField(technicalPlan, 'contentGenerationOptions') ? technicalPlan.contentGenerationOptions : prev.contentGenerationOptions,
            contentGenerationSections: hasOwnField(technicalPlan, 'contentGenerationSections') ? (technicalPlan.contentGenerationSections || {}) : prev.contentGenerationSections,
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : prev.contentGenerationPlans,
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : prev.contentIllustrationPlan,
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : prev.contentGenerationRuntime,
          };
        }

        if (taskType === 'bid-analysis') {
          const outlineDataReset = hasOwnField(technicalPlan, 'outlineData') && technicalPlan.outlineData === null;
          return {
            ...prev,
            bidAnalysisTask: trimTaskLogs(technicalPlan.bidAnalysisTask) || latestTask,
            bidAnalysisMode: technicalPlan.bidAnalysisMode ?? prev.bidAnalysisMode,
            bidAnalysisSelectedTaskIds: Array.isArray(technicalPlan.bidAnalysisSelectedTaskIds)
              ? technicalPlan.bidAnalysisSelectedTaskIds
              : prev.bidAnalysisSelectedTaskIds,
            bidAnalysisTasks: {
              ...prev.bidAnalysisTasks,
              ...(technicalPlan.bidAnalysisTasks || {}),
              ...(event.bidItem ? { [event.bidItem.id]: event.bidItem } : {}),
            },
            bidAnalysisProgress: technicalPlan.bidAnalysisProgress ?? prev.bidAnalysisProgress,
            projectOverview: technicalPlan.projectOverview ?? prev.projectOverview,
            techRequirements: technicalPlan.techRequirements ?? prev.techRequirements,
            outlineGenerationTask: outlineDataReset ? undefined : prev.outlineGenerationTask,
            globalFactsTask: outlineDataReset ? undefined : prev.globalFactsTask,
            globalFacts: outlineDataReset ? [] : prev.globalFacts,
            contentGenerationTask: outlineDataReset ? undefined : prev.contentGenerationTask,
            contentGenerationOptions: outlineDataReset ? undefined : prev.contentGenerationOptions,
            contentGenerationSections: outlineDataReset ? {} : prev.contentGenerationSections,
            contentGenerationPlans: outlineDataReset ? {} : prev.contentGenerationPlans,
            contentIllustrationPlan: outlineDataReset ? undefined : prev.contentIllustrationPlan,
            contentGenerationRuntime: outlineDataReset ? undefined : prev.contentGenerationRuntime,
            outlineData: hasOwnField(technicalPlan, 'outlineData') ? (technicalPlan.outlineData || null) : prev.outlineData,
          };
        }

        if (taskType === 'outline-generation') {
          const hasOutlineData = hasOwnField(technicalPlan, 'outlineData');
          const nextOutlineData = hasOutlineData ? (technicalPlan.outlineData || null) : prev.outlineData;
          const outlineDataChanged = nextOutlineData !== prev.outlineData;

          return {
            ...prev,
            outlineGenerationTask: trimTaskLogs(technicalPlan.outlineGenerationTask) || latestTask,
            outlineMode: technicalPlan.outlineMode ?? prev.outlineMode,
            outlineExpansionMode: technicalPlan.outlineExpansionMode ?? prev.outlineExpansionMode,
            mirrorProcurementEnabled: technicalPlan.mirrorProcurementEnabled !== false,
            referenceKnowledgeDocumentIds: Array.isArray(technicalPlan.referenceKnowledgeDocumentIds)
              ? technicalPlan.referenceKnowledgeDocumentIds
              : prev.referenceKnowledgeDocumentIds,
            outlineData: nextOutlineData,
            globalFactsTask: hasOwnField(technicalPlan, 'globalFactsTask') ? trimTaskLogs(technicalPlan.globalFactsTask) : prev.globalFactsTask,
            globalFacts: hasOwnField(technicalPlan, 'globalFacts') ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: hasOwnField(technicalPlan, 'contentGenerationTask') ? trimTaskLogs(technicalPlan.contentGenerationTask) : (outlineDataChanged ? undefined : prev.contentGenerationTask),
            contentGenerationSections: hasOwnField(technicalPlan, 'contentGenerationSections') ? (technicalPlan.contentGenerationSections || {}) : (outlineDataChanged ? {} : prev.contentGenerationSections),
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : (outlineDataChanged ? {} : prev.contentGenerationPlans),
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : (outlineDataChanged ? undefined : prev.contentIllustrationPlan),
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : (outlineDataChanged ? undefined : prev.contentGenerationRuntime),
          };
        }

        if (taskType === 'global-facts-generation') {
          const hasGlobalFacts = hasOwnField(technicalPlan, 'globalFacts');
          const globalFactsChanged = hasGlobalFacts && technicalPlan.globalFacts !== prev.globalFacts;
          return {
            ...prev,
            globalFactsTask: trimTaskLogs(technicalPlan.globalFactsTask) || latestTask,
            globalFacts: hasGlobalFacts ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: globalFactsChanged ? undefined : prev.contentGenerationTask,
            contentGenerationSections: globalFactsChanged ? {} : prev.contentGenerationSections,
            contentGenerationPlans: globalFactsChanged ? {} : prev.contentGenerationPlans,
            contentIllustrationPlan: globalFactsChanged ? undefined : prev.contentIllustrationPlan,
            contentGenerationRuntime: globalFactsChanged ? undefined : prev.contentGenerationRuntime,
          };
        }

        if (taskType === 'content-generation') {
          const hasPatchOutlineData = hasOwnField(technicalPlan, 'outlineData') || hasOwnField(event, 'outlineData');
          const patchOutlineData = hasOwnField(technicalPlan, 'outlineData') ? technicalPlan.outlineData : event.outlineData;
          const contentSection = event.contentSection;
          const nextSections = hasOwnField(technicalPlan, 'contentGenerationSections')
            ? (technicalPlan.contentGenerationSections || {})
            : contentSection
              ? { ...prev.contentGenerationSections, [contentSection.id]: contentSection }
              : prev.contentGenerationSections;
          const nextOutlineData = hasPatchOutlineData
            ? (patchOutlineData || null)
            : contentSection?.content !== undefined && prev.outlineData
              ? { ...prev.outlineData, outline: updateOutlineItemContent(prev.outlineData.outline, contentSection.id, contentSection.content) }
              : prev.outlineData;
          return {
            ...prev,
            contentGenerationTask: latestTask || trimTaskLogs(technicalPlan.contentGenerationTask),
            outlineMode: technicalPlan.outlineMode ?? prev.outlineMode,
            referenceKnowledgeDocumentIds: Array.isArray(technicalPlan.referenceKnowledgeDocumentIds)
              ? technicalPlan.referenceKnowledgeDocumentIds
              : prev.referenceKnowledgeDocumentIds,
            contentGenerationSections: nextSections,
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : prev.contentGenerationPlans,
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : prev.contentIllustrationPlan,
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : prev.contentGenerationRuntime,
            outlineData: nextOutlineData,
          };
        }

        return prev;
      });
    });
    window.yibiao.tasks.getActiveTasks().catch((error) => {
      console.warn('获取后台任务状态失败', error);
    });

    return unsubscribe;
  }, [setState]);

  useEffect(() => {
    if (state.step !== 'document-analysis') {
      return;
    }
    if (!state.tenderFile) {
      setTenderMarkdown('');
      return;
    }
    let mounted = true;
    window.yibiao?.technicalPlan.readTenderMarkdown().then((markdown) => {
      if (mounted) setTenderMarkdown(markdown || '');
    }).catch((error) => {
      if (mounted) showToast(error instanceof Error ? error.message : '读取招标文件 Markdown 失败', 'error');
    });
    return () => {
      mounted = false;
    };
  }, [showToast, state.step, state.tenderFile]);

  useEffect(() => {
    if (state.step !== 'document-analysis' || !requiresOriginalPlan) {
      setOriginalPlanMarkdown('');
      return;
    }
    if (!state.originalPlanFile) {
      setOriginalPlanMarkdown('');
      return;
    }
    let mounted = true;
    window.yibiao?.technicalPlan.readOriginalPlanMarkdown().then((markdown) => {
      if (mounted) setOriginalPlanMarkdown(markdown || '');
    }).catch((error) => {
      if (mounted) showToast(error instanceof Error ? error.message : '读取原方案 Markdown 失败', 'error');
    });
    return () => {
      mounted = false;
    };
  }, [requiresOriginalPlan, showToast, state.originalPlanFile, state.step]);

  const loadExportTemplates = useCallback(async () => {
    setExportTemplatesLoading(true);
    try {
      const templates = await window.yibiao?.templates.list();
      const nextTemplates = templates || [];
      setExportTemplates(nextTemplates);
      setSelectedExportTemplateId((prev) => nextTemplates.some((template) => template.template_id === prev) ? prev : nextTemplates[0]?.template_id || '');
    } catch (error) {
      setExportTemplates([]);
      setSelectedExportTemplateId('');
      showToast(error instanceof Error ? error.message : '读取导出模板失败', 'error');
    } finally {
      setExportTemplatesLoading(false);
    }
  }, [showToast]);

  const openExportTemplateDialog = async () => {
    if (!state.outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    setExportTemplateDialogOpen(true);
    setExportTemplateSearch('');
    await loadExportTemplates();
  };

  const runExportWord = async (latestExportFormat: ExportFormatConfig) => {
    if (!state.outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mermaidCount = countOutlineMermaidDiagrams(state.outlineData.outline);
    let unsubscribe: (() => void) | undefined;

    try {
      setExportProgress({
        open: true,
        running: true,
        progress: 2,
        message: mermaidCount
          ? `检测到 ${mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片，可能需要稍等。`
          : '正在准备导出 Word。',
        warnings: [],
        mermaidCount,
      });

      unsubscribe = window.yibiao?.export.onWordExportProgress((event: WordExportProgressEvent) => {
        if (event.requestId && event.requestId !== requestId) {
          return;
        }

        setExportProgress((prev) => ({
          ...prev,
          open: true,
          running: event.phase === 'running',
          progress: event.progress,
          message: event.message,
          warnings: event.warnings || prev.warnings,
          error: event.phase === 'error' ? event.message : undefined,
        }));
      });

      const result = await window.yibiao?.export.exportWord({
        requestId,
        project_name: state.outlineData.project_name,
        outline: state.outlineData.outline,
        export_format: latestExportFormat,
      });
      if (result?.canceled) {
        setExportProgress(initialExportProgress);
        showToast('已取消导出', 'info');
        return;
      }
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message: result?.message || 'Word 已导出，请打开文档核对图片、表格和版式。',
        warnings: result?.warnings || prev.warnings,
        filePath: result?.path,
      }));
      if (workflowKind === 'technical-plan') {
        void responseDeviationApi.availability().then(setResponseDeviationAvailability).catch(() => undefined);
      }
      showToast(result?.message || 'Word 已导出', result?.warnings?.length ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 Word 失败';
      setExportProgress((prev) => ({
        ...prev,
        open: true,
        running: false,
        progress: 100,
        message,
        error: message,
      }));
      showToast(message, 'error');
    } finally {
      unsubscribe?.();
    }
  };

  const handleOpenExportedFile = async () => {
    if (!exportProgress.filePath) return;

    try {
      await window.yibiao?.export.openFile(exportProgress.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开文件失败';
      showToast(message, 'error');
    }
  };

  const enterResponseDeviationWorkbench = () => {
    if (!projectId || !responseDeviationAvailability || !onSectionChange) return;
    writeResponseDeviationIntent({
      projectId,
      tenderHash: responseDeviationAvailability.tenderHash,
      selectedSectionId: responseDeviationAvailability.selectedSectionId,
    });
    setExportProgress(initialExportProgress);
    onSectionChange('response-deviation-table');
  };

  const confirmExportTemplate = async () => {
    if (!selectedExportTemplate) {
      showToast('请先选择导出模板', 'info');
      return;
    }

    setExportTemplateDialogOpen(false);
    await runExportWord(selectedExportTemplate.config);
  };

  const createExportTemplate = () => {
    if (!onSectionChange) {
      showToast('请从左侧菜单进入模板设置新建模板', 'info');
      return;
    }

    setExportTemplateDialogOpen(false);
    onSectionChange('new-template');
  };

  const saveChapterContent = async (item: OutlineItem, content: string) => {
    if (!state.outlineData?.outline?.length) {
      throw new Error('当前没有可保存的目录');
    }

    const updatedOutlineData = {
      ...state.outlineData,
      outline: updateOutlineItemContent(state.outlineData.outline, item.id, content),
    };
    const updatedSections = {
      ...state.contentGenerationSections,
      [item.id]: {
        id: item.id,
        title: item.title || '未命名章节',
        status: content.trim() ? 'success' as const : 'idle' as const,
        content,
        updated_at: new Date().toISOString(),
      },
    };

    setState((prev) => ({
      ...prev,
      outlineData: updatedOutlineData,
      contentGenerationSections: updatedSections,
    }));
    const saved = await window.yibiao?.technicalPlan.saveChapterContent({ nodeId: item.id, content });
    if (saved) setState((prev) => ({ ...prev, ...saved }));
  };

  const resetTechnicalPlan = async () => {
    if (!window.confirm('会清空整个技术方案编写进度，是否确认？')) {
      return;
    }

    try {
      const result = await window.yibiao?.technicalPlan.clear();
      setState(result?.state || { ...resetState, workflowKind });
      setTenderMarkdown('');
      setOriginalPlanMarkdown('');
      showToast(result?.message || '技术方案已重置', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重置技术方案失败', 'error');
    }
  };

  const saveContentGenerationOptions = async (contentGenerationOptions: ContentGenerationOptions) => {
    const saved = await window.yibiao?.technicalPlan.saveContentGenerationOptions(contentGenerationOptions);
    setState((prev) => ({ ...prev, ...(saved || {}), contentGenerationOptions }));
  };

  const saveGlobalFacts = async (globalFacts: GlobalFactGroupState[]) => {
    const saved = await window.yibiao?.technicalPlan.saveGlobalFacts(globalFacts);
    setState((prev) => ({ ...prev, ...(saved || {}), globalFacts }));
  };

  const saveOutline = async (request: SaveOutlineRequest) => {
    const saved = await window.yibiao?.technicalPlan.saveOutline(request);
    setState((prev) => ({ ...prev, ...(saved || {}), outlineData: saved?.outlineData || request.outlineData }));
  };

  const generatedContentCount = state.outlineData?.outline
    ? collectLeafItems(state.outlineData.outline).filter((item) => item.content?.trim()).length
    : 0;
  const workflowSwitchClearText = workflowSwitchRequest?.to === 'technical-plan'
    ? '原方案、目录、全局事实、正文和生成进度'
    : '目录、全局事实、正文和生成进度';

  const navigationActions = state.step === 'content-edit'
    ? [
      {
        id: 'previous-step',
        label: '上一步',
        icon: <ToolbarArrowLeftIcon />,
        disabled: activeIndex <= 0,
        tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
        onClick: () => { void goToOffset(-1); },
      },
      {
        id: 'export-word',
        label: isExporting ? '导出中...' : '导出 Word',
        icon: <ToolbarDocumentIcon />,
        variant: 'primary' as const,
        disabled: isContentGenerating || isExporting || !state.outlineData,
        tooltip: isContentGenerating ? '正文生成或暂停处理中，完成暂停后再导出' : isExporting ? 'Word 正在导出，请稍候' : isContentPaused ? '正文生成已暂停，可导出当前已完成内容' : generatedContentCount ? '导出当前技术方案正文' : '可导出空目录文档，建议先生成正文',
        onClick: () => { void openExportTemplateDialog(); },
      },
    ]
    : [
      {
        id: 'previous-step',
        label: '上一步',
        icon: <ToolbarArrowLeftIcon />,
        disabled: activeIndex <= 0,
        tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
        onClick: () => { void goToOffset(-1); },
      },
      {
        id: 'next-step',
        label: '下一步',
        icon: <ToolbarArrowRightIcon />,
        variant: 'primary' as const,
        disabled: isNextDisabled,
        tooltip: nextTooltip,
        onClick: () => { void goToOffset(1); },
      },
    ];

  const toolbarGroups = [
    {
      id: 'technical-plan-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger' as const,
          tooltip: '清空当前技术方案流程',
          onClick: resetTechnicalPlan,
        },
        {
          id: 'home',
          label: '首页',
          variant: state.step === 'document-analysis' ? 'primary' as const : 'secondary' as const,
          tooltip: '回到选择标书',
          onClick: () => { void switchStep('document-analysis'); },
        },
      ],
    },
    {
      id: 'technical-plan-navigation',
      actions: navigationActions,
    },
  ];

  return (
    <div className="page-stack technical-workbench">
      {state.step === 'document-analysis' && (
        <DocumentAnalysisPage
          workflowKind={workflowKind}
          tenderFile={state.tenderFile}
          tenderFiles={state.tenderFiles || []}
          tenderMarkdown={tenderMarkdown}
          originalPlanFile={state.originalPlanFile}
          originalPlanMarkdown={originalPlanMarkdown}
          hasGeneratedOutline={Boolean(state.outlineData?.outline?.length)}
          onFileImported={(nextState, markdown) => {
            setState((prev) => ({ ...prev, ...nextState }));
            setTenderMarkdown(markdown);
          }}
          onOriginalPlanImported={(nextState, markdown) => {
            setState((prev) => ({ ...prev, ...nextState }));
            setOriginalPlanMarkdown(markdown);
          }}
        />
      )}

      {state.step === 'bid-analysis' && (
        <BidAnalysisPage
          hasTenderFile={Boolean(state.tenderFile)}
          mode={state.bidAnalysisMode}
          selectedTaskIds={state.bidAnalysisSelectedTaskIds}
          bidSectionMode={state.bidSectionMode}
          bidSections={state.bidSections}
          bidSectionExtractionTask={state.bidSectionExtractionTask}
          bidSectionExtractionStatus={state.bidSectionExtractionStatus}
          bidSectionExtractionError={state.bidSectionExtractionError}
          selectedSectionTitle={state.tenderFile?.selectedSectionTitle}
          tasks={state.bidAnalysisTasks}
          task={state.bidAnalysisTask}
          progress={state.bidAnalysisProgress}
          hasGeneratedOutline={Boolean(state.outlineData?.outline?.length)}
          onProgressChange={(progress) => setState((prev) => ({ ...prev, bidAnalysisProgress: progress }))}
          onConfigSaved={(nextState) => setState((prev) => ({ ...prev, ...nextState }))}
        />
      )}
      {state.step === 'outline-generation' && (
        <OutlineEditPage
          workflowKind={workflowKind}
          projectOverview={state.projectOverview}
          techRequirements={state.techRequirements}
          outlineExpansionMode={state.outlineExpansionMode || 'ai-complement'}
          mirrorProcurementEnabled={state.mirrorProcurementEnabled !== false}
          outlineWordControlOptions={state.outlineWordControlOptions}
          referenceKnowledgeDocumentIds={state.referenceKnowledgeDocumentIds}
          outlineData={state.outlineData}
          task={state.outlineGenerationTask}
          contentTaskStatus={state.contentGenerationTask?.status}
          onOutlineConfigChange={({ referenceKnowledgeDocumentIds, outlineExpansionMode, mirrorProcurementEnabled, outlineWordControlOptions }) => {
            setState((prev) => ({ ...prev, outlineMode: 'aligned', outlineExpansionMode, mirrorProcurementEnabled, outlineWordControlOptions, referenceKnowledgeDocumentIds }));
            window.yibiao?.technicalPlan.saveOutlineConfig({ referenceKnowledgeDocumentIds, outlineExpansionMode, mirrorProcurementEnabled, outlineWordControlOptions }).then((saved) => {
              setState((prev) => ({ ...prev, ...saved }));
            }).catch((error) => {
              showToast(error instanceof Error ? error.message : '保存目录配置失败', 'error');
            });
          }}
          onOutlineSaved={saveOutline}
          onSortGuardChange={(guard) => {
            sortGuardRef.current = guard;
          }}
        />
      )}
      {state.step === 'global-facts' && (
        <GlobalFactsPage
          outlineData={state.outlineData}
          globalFacts={state.globalFacts}
          task={state.globalFactsTask}
          subjectReplacements={subjectReplacements}
          bidderName={bidderName}
          bidAnalysisBuyerName={bidAnalysisBuyerName}
          tenderMarkdown={tenderMarkdown}
          subjectIdentityPromptKey={subjectIdentityPromptKey}
          subjectIdentityOpenSignal={subjectIdentityOpenSignal}
          onBidderNameChange={handleBidderNameChange}
          onSubjectReplacementsChange={handleSubjectReplacementsChange}
          onGlobalFactsSaved={saveGlobalFacts}
          onTaskStarted={(task) => setState((prev) => ({ ...prev, globalFactsTask: task }))}
        />
      )}
      {state.step === 'content-edit' && (
        <ContentEditPage
          workflowKind={workflowKind}
          outlineData={state.outlineData}
          task={state.contentGenerationTask}
          contentGenerationOptions={state.contentGenerationOptions}
          contentIllustrationPlan={state.contentIllustrationPlan}
          sections={state.contentGenerationSections}
          onContentGenerationOptionsChange={saveContentGenerationOptions}
          onContentSaved={saveChapterContent}
        />
      )}
      {state.step === 'expand' && (
        <section className="empty-panel compact-placeholder">
          <div className="feature-under-development-overlay" role="status" aria-live="polite">
            <strong>正在开发中，敬请期待</strong>
            <span>此功能尚未完成，请先不要使用。</span>
          </div>
          <span className="section-kicker">STEP 06</span>
          <h3>扩写改写</h3>
          <p>后续接入旧方案导入、章节扩写和人工校准。</p>
        </section>
      )}

      <Dialog.Root open={sortLeaveDialogOpen} onOpenChange={(open) => !open && continueSorting()}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card outline-sort-leave-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">目录排序</span>
              <Dialog.Title>排序结果是否保存</Dialog.Title>
              <Dialog.Description>
                当前目录排序还没有保存。保存后会更新目录编号并保留已生成正文；不保存则丢弃本次排序草稿。
              </Dialog.Description>
            </div>
            <div className="content-regenerate-actions">
              <button type="button" className="secondary-action" onClick={continueSorting} disabled={savingSortBeforeLeave}>继续排序</button>
              <button type="button" className="secondary-action" onClick={discardSortAndLeave} disabled={savingSortBeforeLeave}>不保存</button>
              <button type="button" className="primary-action" onClick={() => { void saveSortAndLeave(); }} disabled={savingSortBeforeLeave}>
                {savingSortBeforeLeave ? '正在保存...' : '保存排序'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(workflowSwitchRequest)} onOpenChange={(open) => !open && !switchingWorkflow && cancelWorkflowSwitch()}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card workflow-switch-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">切换模式</span>
              <Dialog.Title>确认切换到{workflowSwitchRequest ? workflowLabel(workflowSwitchRequest.to) : '新模式'}</Dialog.Title>
              <Dialog.Description>
                {workflowSwitchRequest
                  ? `当前保存的进度是「${workflowLabel(workflowSwitchRequest.from)}」模式生成的。切换到「${workflowLabel(workflowSwitchRequest.to)}」会清空之前的已有进度。是否继续？`
                  : '切换模式会清空当前模式下的生成进度。'}
              </Dialog.Description>
            </div>
            <div className="workflow-switch-summary">
              <span>保留：招标文件、招标文件解析结果、参考知识库选择</span>
              <span>清空：{workflowSwitchClearText}</span>
            </div>
            <div className="content-regenerate-actions">
              <button type="button" className="secondary-action" onClick={cancelWorkflowSwitch} disabled={switchingWorkflow}>取消</button>
              <button type="button" className="primary-action" onClick={() => { void confirmWorkflowSwitch(); }} disabled={switchingWorkflow}>
                {switchingWorkflow ? '正在切换...' : '继续切换'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={exportTemplateDialogOpen} onOpenChange={(open) => !open && !isExporting && setExportTemplateDialogOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-template-select-dialog">
            <div className="export-template-select-head">
              <div>
                <span className="section-kicker">Word 导出</span>
                <Dialog.Title>选择导出模板</Dialog.Title>
                <Dialog.Description>选择一个已保存模板后继续导出。模板样式应用范围保持现有导出逻辑。</Dialog.Description>
              </div>
              <Dialog.Close className="detail-help-close" type="button" aria-label="关闭模板选择" disabled={isExporting}>×</Dialog.Close>
            </div>

            <div className="export-template-select-body">
              <section className="export-template-select-list-panel" aria-label="模板列表">
                <input
                  className="export-template-select-search"
                  type="text"
                  value={exportTemplateSearch}
                  onChange={(event) => setExportTemplateSearch(event.target.value)}
                  placeholder="搜索模板名称"
                />
                <div className="export-template-select-list">
                  {exportTemplatesLoading ? (
                    <div className="export-template-select-empty"><strong>正在读取模板</strong><span>请稍候...</span></div>
                  ) : null}
                  {!exportTemplatesLoading && filteredExportTemplates.length === 0 ? (
                    <div className="export-template-select-empty">
                      <strong>{exportTemplates.length ? '没有匹配模板' : '暂无可用模板'}</strong>
                      <span>{exportTemplates.length ? '请换个关键词搜索，或新建一个模板。' : '请先新建并保存模板，保存后再返回导出。'}</span>
                      <button type="button" className="secondary-action" onClick={createExportTemplate} disabled={isExporting}>新建模板</button>
                    </div>
                  ) : null}
                  {!exportTemplatesLoading && filteredExportTemplates.map((template) => {
                    const selected = selectedExportTemplate?.template_id === template.template_id;
                    return (
                      <button
                        type="button"
                        className={`export-template-select-row${selected ? ' is-active' : ''}`}
                        key={template.template_id}
                        onClick={() => setSelectedExportTemplateId(template.template_id)}
                      >
                        <strong>{template.template_name}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="export-template-select-preview" aria-label="模板预览">
                {selectedExportTemplate ? (
                  <>
                    <div className="export-template-select-preview-head">
                      <span className="section-kicker">预览</span>
                      <strong>{selectedExportTemplate.template_name}</strong>
                    </div>
                    <TemplatePreview config={selectedExportTemplate.config} previewStyle={exportTemplatePreviewStyle} />
                  </>
                ) : (
                  <div className="export-template-select-preview-empty">
                    <strong>暂无模板预览</strong>
                    <span>选择模板后会在这里显示预览。</span>
                  </div>
                )}
              </section>
            </div>

            <div className="content-regenerate-actions export-template-select-actions">
              <button type="button" className="secondary-action" onClick={createExportTemplate} disabled={isExporting}>新建模板</button>
              <Dialog.Close className="secondary-action" type="button" disabled={isExporting}>取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => { void confirmExportTemplate(); }} disabled={exportTemplatesLoading || !selectedExportTemplate || isExporting}>继续导出</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={exportProgress.open}
        onOpenChange={(open) => {
          if (!open && !exportProgress.running) {
            setExportProgress(initialExportProgress);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-progress-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">Word 导出</span>
              <Dialog.Title>{exportProgress.running ? '正在导出 Word' : exportProgress.error ? '导出失败' : '导出完成'}</Dialog.Title>
              <Dialog.Description>
                {exportProgress.mermaidCount > 0
                  ? `本次包含 ${exportProgress.mermaidCount} 张 Mermaid 图，导出时会通过 mermaid.ink 转换成 Word 图片，速度受网络影响。`
                  : '正在将正文、表格和图片写入 Word 文档。'}
              </Dialog.Description>
            </div>
            <div className="export-progress-body">
              <div className="content-generation-progress-track" aria-label={`Word 导出进度 ${exportProgress.progress}%`}>
                <span style={{ width: `${exportProgress.progress}%` }} />
              </div>
              <p>{exportProgress.message || '正在处理导出任务，请稍候。'}</p>
              {exportProgress.warnings.length > 0 && (
                <div className="export-warning-list">
                  <strong>需要核对</strong>
                  {exportProgress.warnings.slice(0, 4).map((warning) => <small key={warning}>{warning}</small>)}
                  {exportProgress.warnings.length > 4 && <small>还有 {exportProgress.warnings.length - 4} 条图片提示，请打开导出的 Word 核对。</small>}
                </div>
              )}
              {!exportProgress.running && !exportProgress.error && shouldPromptResponseDeviation && responseDeviationAvailability && (
                <div className="export-response-next-card">
                  <strong>{responseDeviationAvailability.workspaceStatus === 'stale' ? '偏离表来源已变化' : `已发现“${responseDeviationAvailability.templateTitle}”`}</strong>
                  <span>来源章节：{responseDeviationAvailability.sourceChapterTitle}。是否继续生成技术响应与偏离表？系统会复用当前招标原文和分析结果。</span>
                </div>
              )}
            </div>
            {!exportProgress.running && (
              <div className="content-regenerate-actions">
                {!exportProgress.error && exportProgress.filePath && <button className="secondary-action" type="button" onClick={() => { void handleOpenExportedFile(); }}>打开技术方案 Word</button>}
                {shouldPromptResponseDeviation && !exportProgress.error ? <>
                  <Dialog.Close className="secondary-action" type="button">暂不处理</Dialog.Close>
                  <button className="primary-action" type="button" onClick={enterResponseDeviationWorkbench}>进入偏离表工作台</button>
                </> : <Dialog.Close className={exportProgress.filePath && !exportProgress.error ? 'secondary-action' : 'primary-action'} type="button">知道了</Dialog.Close>}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AgentQuestionDialog
        question={agentQuestion}
        submitting={answeringAgentQuestion}
        onSubmit={(optionId) => { void submitAgentQuestionAnswer(optionId); }}
        onDefer={deferAgentQuestion}
      />

      <FloatingToolbar groups={toolbarGroups} label="技术方案工具条" />
    </div>
  );
}

export default TechnicalPlanHome;
