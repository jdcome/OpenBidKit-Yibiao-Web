// 提示词管理 store：DB 驱动的提示词目录 + CRUD + seed + 运行时加载兜底。
//
// 把招标解析（18 task + 1 system prompt）与废标检查 invalid_bid prompt 从硬编码常量
// 改为 DB 驱动（带硬编码兜底）。bidAnalysis.ts 的常量保留为 seed 源 + DB 读失败兜底。
//
// 运行时加载语义（管线不变的保证）：
//  - loadBidAnalysisCatalog：读 DB enabled 行构造目录；任一内置项缺失 → 该项回退硬编码；
//    整段 DB 读失败 → 全量回退硬编码常量（log，不抛）。
//  - loadRejectionInvalidBidPrompt：同构；缺失/禁用 → 回退 buildInvalidBidAndRejectionItemsPrompt。
//  - 禁用优先于必填：disabled 内置项不进目录、不计入必填校验（管理员显式禁用视为不需要）。
import type { PrismaClient, PromptTemplate } from '@prisma/client';
import {
  BUILTIN_BID_ANALYSIS_TASKS,
  BUILTIN_SYSTEM_PROMPT,
  buildRejectionInvalidBidPromptDefault,
  type BidAnalysisTaskSpec,
} from '../tasks/utils/bidAnalysis';
import {
  buildMirrorStructureExtractPromptDefault,
  buildMirrorToneRewritePromptDefault,
  MIRROR_STRUCTURE_EXTRACT_KEY,
  MIRROR_TONE_REWRITE_KEY,
} from '../tasks/utils/mirrorProcurement';

// 投标分析 task 的显示分组（与 BidAnalysisPage taskGroups 一致）。seed 用。
const BID_ANALYSIS_GROUP: Record<string, string> = {};
for (const [groupName, ids] of [
  ['关键项', ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements']],
  ['采购与响应', ['procurementList', 'responseFileRequirements']],
  ['投标流程', ['keyInfo', 'marginInfo', 'openBid']],
  ['评审要求', ['qualificationReview', 'complianceCheck', 'evaluationBid', 'businessScoring']],
  ['主体与合同', ['agentInfo', 'discardedBids', 'signingProcess', 'terminationCondition']],
] as Array<[string, string[]]>) {
  for (const id of ids) BID_ANALYSIS_GROUP[id] = groupName;
}

export type PromptRunnerKey = 'bid-analysis' | 'rejection-check' | 'mirror-procurement';
export type PromptOutput = 'markdown' | 'json';

export interface PromptCatalogItem {
  id: string;
  runnerKey: string;
  itemKey: string;
  label: string;
  description: string;
  groupName: string;
  output: PromptOutput;
  required: boolean;
  enabled: boolean;
  builtin: boolean;
  isSystem: boolean;
  sortOrder: number;
  updatedAt: string;
}

const RUNNER_KEYS: PromptRunnerKey[] = ['bid-analysis', 'rejection-check', 'mirror-procurement'];
const SYSTEM_ITEM_KEY = '__system__';
const REJECTION_INVALID_BID_KEY = 'invalid_bid';

function isRunnerKey(value: string): value is PromptRunnerKey {
  return RUNNER_KEYS.includes(value as PromptRunnerKey);
}

function toCatalogItem(row: PromptTemplate): PromptCatalogItem {
  return {
    id: row.id,
    runnerKey: row.runnerKey,
    itemKey: row.itemKey,
    label: row.label,
    description: row.description,
    groupName: row.groupName,
    output: row.output as PromptOutput,
    required: row.required,
    enabled: row.enabled,
    builtin: row.builtin,
    isSystem: row.isSystem,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// 内置项的代码常量 promptText（reset / seed 源）。
function builtinPromptText(runnerKey: string, itemKey: string): string | null {
  if (runnerKey === 'bid-analysis') {
    if (itemKey === SYSTEM_ITEM_KEY) return BUILTIN_SYSTEM_PROMPT;
    const task = BUILTIN_BID_ANALYSIS_TASKS.find((t) => t.id === itemKey);
    return task ? task.prompt() : null;
  }
  if (runnerKey === 'rejection-check' && itemKey === REJECTION_INVALID_BID_KEY) {
    return buildRejectionInvalidBidPromptDefault();
  }
  if (runnerKey === 'mirror-procurement') {
    if (itemKey === MIRROR_STRUCTURE_EXTRACT_KEY) return buildMirrorStructureExtractPromptDefault();
    if (itemKey === MIRROR_TONE_REWRITE_KEY) return buildMirrorToneRewritePromptDefault();
  }
  return null;
}

// ---- 运行时加载（runner 用） ----

export async function loadBidAnalysisCatalog(
  prisma: PrismaClient,
): Promise<{ systemPrompt: string; tasks: BidAnalysisTaskSpec[] }> {
  const fallback: { systemPrompt: string; tasks: BidAnalysisTaskSpec[] } = {
    systemPrompt: BUILTIN_SYSTEM_PROMPT,
    tasks: BUILTIN_BID_ANALYSIS_TASKS,
  };
  try {
    const rows = await prisma.promptTemplate.findMany({ where: { runnerKey: 'bid-analysis' } });
    if (!rows.length) return fallback;

    const byKey = new Map(rows.map((r) => [r.itemKey, r]));
    const tasks: BidAnalysisTaskSpec[] = [];

    // DB 已启用的非 system 行（含内置编辑版 + 自定义）。
    const enabledRows = rows
      .filter((r) => r.enabled && !r.isSystem)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    for (const row of enabledRows) {
      tasks.push({
        id: row.itemKey,
        label: row.label,
        required: row.required,
        output: row.output as 'markdown' | 'json',
        description: row.description,
        prompt: () => row.promptText,
      });
    }

    // 缺失内置项兜底：DB 无该 itemKey 行（seed 未覆盖）→ 回退硬编码（视为启用）。
    for (const builtin of BUILTIN_BID_ANALYSIS_TASKS) {
      if (!byKey.has(builtin.id)) tasks.push(builtin);
    }
    // 维持稳定顺序：以 BUILTIN 顺序为基线，自定义项追加其后。
    const orderIndex = new Map(BUILTIN_BID_ANALYSIS_TASKS.map((t, i) => [t.id, i]));
    tasks.sort((a, b) => {
      const ai = orderIndex.has(a.id) ? orderIndex.get(a.id)! : 1000 + a.id.length;
      const bi = orderIndex.has(b.id) ? orderIndex.get(b.id)! : 1000 + b.id.length;
      return ai - bi;
    });

    const systemRow = rows.find((r) => r.isSystem);
    const systemPrompt = systemRow && systemRow.enabled ? systemRow.promptText : BUILTIN_SYSTEM_PROMPT;
    return { systemPrompt, tasks };
  } catch (error) {
    console.error('[prompts] loadBidAnalysisCatalog failed, using builtin fallback:', error);
    return fallback;
  }
}

export async function loadRejectionInvalidBidPrompt(
  prisma: PrismaClient,
): Promise<{ promptText: string; output: 'markdown' | 'json' }> {
  const fallback = { promptText: buildRejectionInvalidBidPromptDefault(), output: 'markdown' as const };
  try {
    const row = await prisma.promptTemplate.findUnique({
      where: { runnerKey_itemKey: { runnerKey: 'rejection-check', itemKey: REJECTION_INVALID_BID_KEY } },
    });
    if (!row || !row.enabled) return fallback;
    return { promptText: row.promptText, output: row.output as 'markdown' | 'json' };
  } catch (error) {
    console.error('[prompts] loadRejectionInvalidBidPrompt failed, using builtin fallback:', error);
    return fallback;
  }
}

// 镜像采购需求结构提取 prompt 加载（runnerKey='mirror-procurement'）。
// 缺失/禁用/读失败 → 回退硬编码默认（与 loadRejectionInvalidBidPrompt 同构）。本期只加载 structure_extract。
export async function loadMirrorStructureExtractPrompt(prisma: PrismaClient): Promise<string> {
  const fallback = buildMirrorStructureExtractPromptDefault();
  try {
    const row = await prisma.promptTemplate.findUnique({
      where: { runnerKey_itemKey: { runnerKey: 'mirror-procurement', itemKey: MIRROR_STRUCTURE_EXTRACT_KEY } },
    });
    if (!row || !row.enabled) return fallback;
    return row.promptText || fallback;
  } catch (error) {
    console.error('[prompts] loadMirrorStructureExtractPrompt failed, using builtin fallback:', error);
    return fallback;
  }
}

// ---- CRUD（admin 路由用） ----

export async function listCatalog(prisma: PrismaClient, runnerKey?: string): Promise<PromptCatalogItem[]> {
  const rows = await prisma.promptTemplate.findMany({
    where: runnerKey ? { runnerKey } : undefined,
    orderBy: [{ runnerKey: 'asc' }, { isSystem: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(toCatalogItem);
}

export async function getOne(prisma: PrismaClient, id: string): Promise<(PromptCatalogItem & { promptText: string }) | null> {
  const row = await prisma.promptTemplate.findUnique({ where: { id } });
  if (!row) return null;
  return { ...toCatalogItem(row), promptText: row.promptText };
}

export interface CreatePromptInput {
  runnerKey: string;
  itemKey: string;
  label: string;
  description?: string;
  output?: PromptOutput;
  required?: boolean;
  promptText: string;
}

export async function createPrompt(prisma: PrismaClient, input: CreatePromptInput): Promise<PromptCatalogItem & { promptText: string }> {
  if (!isRunnerKey(input.runnerKey)) throw new Error('runnerKey 非法');
  const itemKey = String(input.itemKey || '').trim();
  const label = String(input.label || '').trim();
  if (!itemKey) throw new Error('itemKey 不能为空');
  if (!label) throw new Error('label 不能为空');
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(itemKey)) throw new Error('itemKey 须以字母开头，仅含字母数字下划线');
  if (builtinPromptText(input.runnerKey, itemKey) !== null) throw new Error('itemKey 与内置项冲突');

  const maxOrder = await prisma.promptTemplate.aggregate({
    where: { runnerKey: input.runnerKey, builtin: false },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxOrder._max.sortOrder ?? 100) + 1;

  const row = await prisma.promptTemplate.create({
    data: {
      runnerKey: input.runnerKey,
      itemKey,
      label,
      description: String(input.description || '').trim(),
      groupName: '自定义',
      output: input.output === 'json' ? 'json' : 'markdown',
      required: Boolean(input.required),
      promptText: input.promptText,
      enabled: true,
      builtin: false,
      isSystem: false,
      sortOrder,
    },
  });
  return { ...toCatalogItem(row), promptText: row.promptText };
}

export interface UpdatePromptInput {
  label?: string;
  description?: string;
  groupName?: string;
  output?: PromptOutput;
  required?: boolean;
  promptText?: string;
  enabled?: boolean;
}

export async function updatePrompt(prisma: PrismaClient, id: string, patch: UpdatePromptInput): Promise<PromptCatalogItem & { promptText: string }> {
  const row = await prisma.promptTemplate.findUnique({ where: { id } });
  if (!row) throw new Error('提示词不存在');

  const data: Record<string, unknown> = {};
  if (row.isSystem) {
    // system prompt：仅 promptText/label 可改；enabled 锁定 true。
    if (patch.promptText !== undefined) data.promptText = String(patch.promptText);
    if (patch.label !== undefined) data.label = String(patch.label);
    data.enabled = true;
  } else {
    if (patch.label !== undefined) data.label = String(patch.label);
    if (patch.description !== undefined) data.description = String(patch.description);
    if (patch.groupName !== undefined) data.groupName = String(patch.groupName);
    if (patch.output !== undefined) data.output = patch.output === 'json' ? 'json' : 'markdown';
    if (patch.required !== undefined) data.required = Boolean(patch.required);
    if (patch.promptText !== undefined) data.promptText = String(patch.promptText);
    if (patch.enabled !== undefined) data.enabled = Boolean(patch.enabled);
  }
  if (!Object.keys(data).length) return { ...toCatalogItem(row), promptText: row.promptText };

  const updated = await prisma.promptTemplate.update({ where: { id }, data });
  return { ...toCatalogItem(updated), promptText: updated.promptText };
}

export async function removePrompt(prisma: PrismaClient, id: string): Promise<void> {
  const row = await prisma.promptTemplate.findUnique({ where: { id } });
  if (!row) throw new Error('提示词不存在');
  if (row.builtin) throw new Error('内置提示词不可删除，可改为禁用');
  await prisma.promptTemplate.delete({ where: { id } });
}

// 内置项恢复默认 promptText（其他元数据编辑保留）。
export async function resetPrompt(prisma: PrismaClient, id: string): Promise<PromptCatalogItem & { promptText: string }> {
  const row = await prisma.promptTemplate.findUnique({ where: { id } });
  if (!row) throw new Error('提示词不存在');
  if (!row.builtin) throw new Error('仅内置提示词可恢复默认');
  const defaultText = builtinPromptText(row.runnerKey, row.itemKey);
  if (defaultText === null) throw new Error('未找到默认提示词');
  const updated = await prisma.promptTemplate.update({ where: { id }, data: { promptText: defaultText } });
  return { ...toCatalogItem(updated), promptText: updated.promptText };
}

// 全部内置项恢复默认 promptText（可选 runnerKey 过滤）。
export async function resetAllPrompts(prisma: PrismaClient, runnerKey?: string): Promise<number> {
  const where = { builtin: true, ...(runnerKey ? { runnerKey } : {}) };
  const rows = await prisma.promptTemplate.findMany({ where });
  let count = 0;
  for (const row of rows) {
    const defaultText = builtinPromptText(row.runnerKey, row.itemKey);
    if (defaultText === null) continue;
    await prisma.promptTemplate.update({ where: { id: row.id }, data: { promptText: defaultText } });
    count++;
  }
  return count;
}

// ---- seed：幂等写 20 条 builtin（已存在不覆盖，保留管理员编辑） ----

export async function seedPromptDefaults(prisma: PrismaClient): Promise<void> {
  // 投标分析 system prompt
  await prisma.promptTemplate.upsert({
    where: { runnerKey_itemKey: { runnerKey: 'bid-analysis', itemKey: SYSTEM_ITEM_KEY } },
    update: {},
    create: {
      runnerKey: 'bid-analysis',
      itemKey: SYSTEM_ITEM_KEY,
      label: '系统提示词',
      description: '所有投标分析项共用的 system prompt。',
      groupName: '',
      output: 'markdown',
      required: false,
      promptText: BUILTIN_SYSTEM_PROMPT,
      enabled: true,
      builtin: true,
      isSystem: true,
      sortOrder: -1,
    },
  });

  // 投标分析 18 项 task
  for (let i = 0; i < BUILTIN_BID_ANALYSIS_TASKS.length; i++) {
    const task = BUILTIN_BID_ANALYSIS_TASKS[i];
    await prisma.promptTemplate.upsert({
      where: { runnerKey_itemKey: { runnerKey: 'bid-analysis', itemKey: task.id } },
      update: {},
      create: {
        runnerKey: 'bid-analysis',
        itemKey: task.id,
        label: task.label,
        description: task.description,
        groupName: BID_ANALYSIS_GROUP[task.id] || '其他',
        output: task.output,
        required: task.required,
        promptText: task.prompt(),
        enabled: true,
        builtin: true,
        isSystem: false,
        sortOrder: i,
      },
    });
  }

  // 废标检查 invalid_bid
  await prisma.promptTemplate.upsert({
    where: { runnerKey_itemKey: { runnerKey: 'rejection-check', itemKey: REJECTION_INVALID_BID_KEY } },
    update: {},
    create: {
      runnerKey: 'rejection-check',
      itemKey: REJECTION_INVALID_BID_KEY,
      label: '废标条款抽取',
      description: '无效投标/废标项抽取提示词。',
      groupName: '',
      output: 'markdown',
      required: false,
      promptText: buildRejectionInvalidBidPromptDefault(),
      enabled: true,
      builtin: true,
      isSystem: false,
      sortOrder: 0,
    },
  });

  // 镜像采购需求：结构提取 prompt（必须）
  await prisma.promptTemplate.upsert({
    where: { runnerKey_itemKey: { runnerKey: 'mirror-procurement', itemKey: MIRROR_STRUCTURE_EXTRACT_KEY } },
    update: {},
    create: {
      runnerKey: 'mirror-procurement',
      itemKey: MIRROR_STRUCTURE_EXTRACT_KEY,
      label: '镜像章节结构提取',
      description: '从招标原文定位采购需求章并产出标题树（采购→服务改名、扁平段落提升分级、叶子带逐字原文）。',
      groupName: '镜像采购需求',
      output: 'json',
      required: true,
      promptText: buildMirrorStructureExtractPromptDefault(),
      enabled: true,
      builtin: true,
      isSystem: false,
      sortOrder: 0,
    },
  });

  // 镜像采购需求：语气改写 prompt（预留，本期未启用 LLM 语气改写）
  await prisma.promptTemplate.upsert({
    where: { runnerKey_itemKey: { runnerKey: 'mirror-procurement', itemKey: MIRROR_TONE_REWRITE_KEY } },
    update: {},
    create: {
      runnerKey: 'mirror-procurement',
      itemKey: MIRROR_TONE_REWRITE_KEY,
      label: '镜像章节语气改写（预留）',
      description: '本期镜像语气走确定性代码替换；此 prompt 为后期可选的 LLM 语气微调占位。',
      groupName: '镜像采购需求',
      output: 'markdown',
      required: false,
      promptText: buildMirrorToneRewritePromptDefault(),
      enabled: true,
      builtin: true,
      isSystem: false,
      sortOrder: 1,
    },
  });
}
