// 移植自 client/electron/services/globalFactsTask.cjs（行 1-776，剥离 orchestration）。
// 全局事实变量生成的共享基础设施：system prompt、分段切分、4 类 prompt（招标分段抽取/合并、
// 知识库分段补充/合并、原方案分段补充/合并、最终整理）、normalize/validate、批次归并。
// 被 runner #60（global-facts-generation）独占使用。
//
// 4 步流水线（桌面 runGlobalFactsTask）：
//   1) 招标文件分段抽取 → 多段 groups → 批次合并成一份 groups（22→48%）
//   2) 知识库分段补充 → 多段 patches → 批次合并 patches → 应用到 groups（48→66%）
//   3) 原方案分段补充（仅 existing-plan-expansion 工作流，66→86%）
//   4) 最终整理 → review 一次产出最终 groups（86→100%）
//
// 适配点（桌面→web）：
//  - collectJson 走 aiService.collectJsonResponse，web 已完整支持 normalizer/validator/
//    progressCallback/repairMessagesBuilder（ai/service.ts:648 collectJsonResponseWithConfig）。
//  - log 改 async（web 每条进度都持久+广播）；helpers 内所有 log 调用都 await。
//  - loadKnowledgeItems 改 async：web knowledgeBaseService.readItems 是 Promise（桌面同步）。
import { splitUserTextByContextLimit } from '../../document/userTextSplitter';
import type { DesktopAiService } from '../types';

const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;
const GLOBAL_FACTS_CONTEXT_LIMIT_RATIO = 0.8;
const MIN_GLOBAL_FACTS_SEGMENT_CHARS = 1000;

export const GLOBAL_FACTS_SYSTEM_PROMPT = `你是专业的投标技术方案事实变量整理助手。请基于用户提供的上下文，整理后续正文需要统一采用的全局事实变量。

关键定义：
1. 全局事实变量不是招标要求摘录、评分规则摘要或待办事项清单，而是技术方案正文中需要保持一致的确定性方案事实、响应设定、承诺口径或执行安排。
2. 用户资料已经给出明确事实时，优先使用资料中的事实值。
3. 用户资料只给出要求、约束或评价口径时，不要原样摘录为要求句；如果该内容会影响后续正文的一致写法，应转写为本方案已经采用、已经具备或统一承诺的事实表达。
4. 用户资料没有给出具体值，但该信息对全文一致性重要，且当前任务允许补足时，可以根据项目语境模拟生成合理、稳定、不冲突的事实值。

通用要求：
1. 输出必须使用简体中文。
2. 只关注技术方案正文会反复使用、且前后必须一致的事实变量。
3. 每条事实都应能直接指导后续正文统一写法，避免正文各章节自行生成不同口径。
4. 不输出分析过程、来源说明、风险提示、正文草稿或未落地的要求句。`;

export interface GlobalFactGroup {
  id: string;
  title: string;
  content: string;
}
export interface GlobalFactPatch {
  target_group_id: string;
  new_group_id: string;
  title: string;
  content: string;
  mode: 'replace' | 'prepend' | 'append';
}
export interface TextSegment {
  index: number;
  total: number;
  content: string;
}
export interface KnowledgeItem {
  id: string;
  title: string;
  resume: string;
  content: string;
}
export interface KnowledgeSegment {
  index: number;
  total: number;
  content: string;
  itemCount: number;
}
export interface GroupSegmentResult {
  index: number;
  total: number;
  groups: GlobalFactGroup[];
}
export interface PatchSegmentResult {
  index: number;
  total: number;
  patches: GlobalFactPatch[];
}
export interface BaseContext {
  projectOverview: string;
  outlineData: { outline?: unknown[] } | null;
  bidAnalysisFactsText: string;
  knowledgeItems: KnowledgeItem[];
  sectionHint: string;
  isExpansionWorkflow: boolean;
}
export interface GroupContext extends BaseContext {
  groups?: GlobalFactGroup[];
}
export type LogFn = (message: string, progress?: number) => Promise<void>;

function singleLine(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
function normalizeFactId(value: unknown, index: number): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || `fact_${String(index + 1).padStart(3, '0')}`;
}
function ensureUniqueId(id: string, used: Set<string>): string {
  let nextId = id;
  let suffix = 2;
  while (used.has(nextId)) {
    nextId = `${id}_${suffix}`;
    suffix += 1;
  }
  used.add(nextId);
  return nextId;
}
function valueToMarkdown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return `- ${item.trim()}`;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const name = singleLine(obj.name || obj.title || obj.fact || obj.key || '事实项');
        const detail = singleLine(obj.value || obj.content || obj.detail || obj.description || obj.requirement || '');
        return `- **${name}**${detail ? `：${detail}` : ''}`;
      }
      return `- ${singleLine(item)}`;
    }).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `- **${singleLine(key)}**：${singleLine(item)}`)
      .join('\n');
  }
  return singleLine(value);
}

export function normalizeGlobalFactsResponse(value: unknown): { groups: GlobalFactGroup[] } {
  const v = value as Record<string, unknown> | undefined;
  const result = (v?.result && typeof v.result === 'object' ? v.result : value) as Record<string, unknown> | undefined;
  const rawGroups = Array.isArray(result)
    ? result
    : Array.isArray(result?.groups)
      ? result?.groups
      : Array.isArray(result?.facts)
        ? result?.facts
        : Array.isArray(result?.items)
          ? result?.items
          : [];
  const used = new Set<string>();
  const groups = (rawGroups as Array<Record<string, unknown>>).map((group, index) => {
    const title = singleLine(group?.title || group?.name || group?.category || group?.label);
    const rawContent = group?.content ?? group?.markdown ?? group?.facts ?? group?.items ?? group?.details ?? group?.description;
    const content = valueToMarkdown(rawContent);
    if (!title || !content) return null;
    const id = ensureUniqueId(normalizeFactId(group?.id || group?.group_id || group?.key || title, index), used);
    return { id, title, content } as GlobalFactGroup;
  }).filter(Boolean) as GlobalFactGroup[];
  return { groups };
}
export function validateGlobalFactsResponse(value: { groups?: GlobalFactGroup[] }): void {
  if (!Array.isArray(value?.groups) || !value.groups.length) {
    throw new Error('全局事实结果缺少 groups');
  }
  value.groups.forEach((group, index) => {
    if (!group.id || !group.title || !String(group.content || '').trim()) {
      throw new Error(`全局事实第 ${index + 1} 项缺少 id、title 或 content`);
    }
  });
}

export function sourceRequiresDurationFact(sourceText: unknown): boolean {
  return /(?:工期|服务期限?|履约期限|合同期限|项目周期|建设周期|实施周期|运维期|交货时间|交付时间|完成期限)/.test(String(sourceText || ''));
}

export function validateGlobalFactsMinimumQuality(
  groups: GlobalFactGroup[],
  options: { requireDuration?: boolean } = {},
): void {
  validateGlobalFactsResponse({ groups });
  const requireDuration = options.requireDuration ?? true;
  if (!requireDuration) return;
  const joined = groups.map((group) => `${group.title}\n${group.content}`).join('\n');
  if (!/(?:工期|服务期限?|服务期|运维期|交货时间|交付时间)/.test(joined)) {
    throw new Error('全局事实结果缺少工期、服务期或交付时间相关变量');
  }
}

export function buildGlobalFactsFromAnalysisContext(context: Pick<BaseContext, 'projectOverview'>): { groups: GlobalFactGroup[]; warnings: string[] } {
  const content = String(context.projectOverview || '').trim();
  const groups = content ? [{ id: 'project_core_facts', title: '项目核心事实', content }] : [];
  const requireDuration = sourceRequiresDurationFact(content);
  validateGlobalFactsMinimumQuality(groups, { requireDuration });
  return {
    groups,
    warnings: [
      '招标原文分段抽取失败，已采用 STEP 02 中通过审核的项目概述事实，未补造新值。',
      ...(!requireDuration ? ['来源未识别到整体期限字段，未补造期限值。'] : []),
    ],
  };
}

export function mergeGlobalFactGroupsDeterministically(segmentResults: GroupSegmentResult[]): { groups: GlobalFactGroup[]; warnings: string[] } {
  const groups: GlobalFactGroup[] = [];
  const byKey = new Map<string, GlobalFactGroup>();
  for (const result of [...(segmentResults || [])].sort((a, b) => a.index - b.index)) {
    for (const source of result.groups || []) {
      const title = singleLine(source.title);
      const key = title.replace(/\s+/g, '').toLowerCase() || source.id;
      let target = byKey.get(source.id) || byKey.get(key);
      if (!target) {
        target = { id: source.id, title, content: '' };
        groups.push(target);
        byKey.set(source.id, target);
        byKey.set(key, target);
      }
      const existing = new Set(target.content.split('\n').map((line) => line.trim()).filter(Boolean));
      const additions = String(source.content || '').split('\n').map((line) => line.trim()).filter((line) => line && !existing.has(line));
      target.content = [...existing, ...additions].join('\n');
    }
  }
  return { groups, warnings: ['模型合并失败，已使用通过校验的分段事实进行确定性归并。'] };
}
export function validateGlobalFactsSegmentResponse(value: { groups?: unknown[] } | null | undefined): void {
  if (!value || !Array.isArray(value.groups)) {
    throw new Error('全局事实分段结果缺少 groups');
  }
  if (!value.groups.length) {
    throw new Error('全局事实分段结果 groups 为空');
  }
  (value.groups as GlobalFactGroup[]).forEach((group, index) => {
    if (!group.id || !group.title || !String(group.content || '').trim()) {
      throw new Error(`全局事实分段第 ${index + 1} 项缺少 id、title 或 content`);
    }
  });
}
export function normalizeGlobalFactsPatchResponse(value: unknown): { patches: GlobalFactPatch[] } {
  const v = value as Record<string, unknown> | undefined;
  const source = (v?.result && typeof v.result === 'object' ? v.result : value) as Record<string, unknown> | undefined;
  const rawPatches = Array.isArray(source)
    ? source
    : Array.isArray(source?.patches)
      ? source?.patches
      : Array.isArray(source?.supplements)
        ? source?.supplements
        : Array.isArray(source?.additions)
          ? source?.additions
          : Array.isArray(source?.items)
            ? source?.items
            : [];
  const patches = (rawPatches as Array<Record<string, unknown>>).map((patch, index) => {
    const title = singleLine(patch?.title || patch?.group_title || patch?.target_group_title || patch?.name);
    const content = valueToMarkdown(patch?.content ?? patch?.markdown ?? patch?.facts ?? patch?.items ?? patch?.details ?? patch?.description);
    if (!content) return null;
    const rawMode = singleLine(patch?.mode || patch?.operation || 'append').toLowerCase();
    const mode: GlobalFactPatch['mode'] = ['replace', 'prepend'].includes(rawMode) ? (rawMode as 'replace' | 'prepend') : 'append';
    return {
      target_group_id: singleLine(patch?.target_group_id || patch?.targetGroupId || patch?.group_id || patch?.id),
      new_group_id: singleLine(patch?.new_group_id || patch?.newGroupId || patch?.id || `patch_${index + 1}`),
      title,
      content,
      mode,
    } as GlobalFactPatch;
  }).filter(Boolean) as GlobalFactPatch[];
  return { patches };
}
export function validateGlobalFactsPatchResponse(value: { patches?: unknown[] } | null | undefined): void {
  if (!value || !Array.isArray(value.patches)) {
    throw new Error('全局事实补充结果缺少 patches');
  }
  (value.patches as GlobalFactPatch[]).forEach((patch, index) => {
    if (!String(patch.content || '').trim()) {
      throw new Error(`全局事实补充第 ${index + 1} 项缺少 content`);
    }
  });
}

export function mergeGlobalFactPatches(groups: GlobalFactGroup[], patches: GlobalFactPatch[] | undefined): GlobalFactGroup[] {
  const used = new Set(groups.map((group) => group.id));
  const nextGroups = groups.map((group) => ({ ...group }));

  for (const patch of patches || []) {
    const targetIndex = nextGroups.findIndex((group) => (
      group.id === patch.target_group_id
      || (patch.title && group.title === patch.title)
    ));

    if (targetIndex >= 0) {
      const current = nextGroups[targetIndex];
      const patchContent = String(patch.content || '').trim();
      const currentContent = String(current.content || '').trim();
      nextGroups[targetIndex] = {
        ...current,
        content: patch.mode === 'replace'
          ? patchContent
          : patch.mode === 'prepend'
            ? `${patchContent}\n\n${currentContent}`.trim()
            : `${currentContent}\n\n${patchContent}`.trim(),
      };
      continue;
    }

    const title = patch.title || '补充事实变量';
    const id = ensureUniqueId(normalizeFactId(patch.new_group_id || title, nextGroups.length), used);
    nextGroups.push({ id, title, content: String(patch.content || '').trim() });
  }

  return nextGroups;
}

function formatOutlineForPrompt(items: unknown[], level = 1, lines: string[] = []): string {
  for (const raw of items || []) {
    const item = raw as Record<string, unknown>;
    const id = singleLine(item?.id || 'unknown');
    const title = singleLine(item?.title || '未命名章节');
    const description = singleLine(item?.description || '');
    lines.push(`${'  '.repeat(Math.max(0, level - 1))}- ${id} ${title}${description ? `：${description}` : ''}`);
    if (Array.isArray(item?.children) && item.children.length) formatOutlineForPrompt(item.children as unknown[], level + 1, lines);
  }
  return lines.join('\n');
}

export function normalizeReferenceDocumentIds(storedPlan: Record<string, unknown> | null | undefined): string[] {
  const raw = storedPlan?.referenceKnowledgeDocumentIds || [];
  return Array.isArray(raw) ? [...new Set((raw as unknown[]).map((id) => String(id || '').trim()).filter(Boolean))] : [];
}

// 知识库 readItems 在 web 是 async（桌面同步），故本函数改 async；逐文档 await readItems。
export async function loadKnowledgeItems(
  knowledgeBaseService: { readItems?: (documentId: string) => Promise<Array<Record<string, unknown>> > } | null,
  documentIds: string[],
  log: LogFn,
): Promise<KnowledgeItem[]> {
  if (!documentIds.length) {
    await log('未选择参考知识库，本次只基于招标文件、Step02 解析结果和目录预设关键信息。', 12);
    return [];
  }
  if (!knowledgeBaseService?.readItems) {
    await log('未找到知识库读取服务，本次不使用知识库条目。', 12);
    return [];
  }

  const items: KnowledgeItem[] = [];
  for (const documentId of documentIds) {
    try {
      const documentItems = await knowledgeBaseService.readItems(documentId);
      for (const item of Array.isArray(documentItems) ? documentItems : []) {
        const title = singleLine(item?.title);
        const content = String(item?.content || '').trim();
        if (!title || !content) continue;
        items.push({
          id: `${documentId}::${singleLine(item?.id)}`,
          title,
          resume: singleLine(item?.resume),
          content,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await log(`读取知识库条目失败，已跳过文档 ${documentId}：${message}`, 12);
    }
  }
  await log(items.length ? `已读取 ${items.length} 条知识库完整条目。` : '未读取到可用知识库完整条目。', 14);
  return items;
}

function formatKnowledgeItemForPrompt(item: KnowledgeItem, index: number): string {
  return `<knowledge_item index="${index + 1}" id="${singleLine(item?.id)}">
标题：${singleLine(item?.title)}
简介：${singleLine(item?.resume)}
正文：
${String(item?.content || '').trim()}
</knowledge_item>`;
}

function formatBidAnalysisFactForPrompt(storedPlan: Record<string, unknown> | null | undefined, itemId: string, label: string): string {
  const tasks = (storedPlan?.bidAnalysisTasks as Record<string, Record<string, unknown>>) || {};
  const item = tasks[itemId];
  const content = item?.status === 'success' ? String(item.content || '').trim() : '';
  return content ? `## ${label}\n${content}` : '';
}
function formatBidAnalysisFactsForPrompt(storedPlan: Record<string, unknown> | null | undefined): string {
  return [
    formatBidAnalysisFactForPrompt(storedPlan, 'projectInfo', '项目信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'partAInfo', '甲方信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'deliveryAndServiceRequirements', '交货和服务要求'),
  ].filter(Boolean).join('\n\n') || '未提供 Step02 关键解析结果。';
}

function getMessagesContentLength(messages: Array<{ role?: string; content?: string }>): number {
  return (messages || []).reduce((sum, message) => sum + String(message?.role || 'user').length + String(message?.content || '').length + 64, 0);
}
function getGlobalFactsSegmentLimit(aiService: DesktopAiService, fixedMessages: Array<{ role?: string; content?: string }>): number {
  const config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  const contextLengthLimit = normalizePositiveInteger(config?.context_length_limit, DEFAULT_CONTEXT_LENGTH_LIMIT);
  const requestBudget = Math.floor(contextLengthLimit * GLOBAL_FACTS_CONTEXT_LIMIT_RATIO);
  return Math.max(MIN_GLOBAL_FACTS_SEGMENT_CHARS, requestBudget - getMessagesContentLength(fixedMessages));
}
function splitGlobalFactsSourceText(text: string, aiService: DesktopAiService, fixedMessages: Array<{ role?: string; content?: string }>): string[] {
  const source = String(text || '').trim();
  if (!source) return [];
  return splitUserTextByContextLimit(source, {}, {
    contextLengthLimit: getGlobalFactsSegmentLimit(aiService, fixedMessages),
    limitRatio: 1,
    maxSegmentLimitRatio: 1,
  }).map((content) => String(content || '').trim()).filter(Boolean);
}
function createTextSegments(text: string, aiService: DesktopAiService, fixedMessages: Array<{ role?: string; content?: string }>): TextSegment[] {
  const parts = splitGlobalFactsSourceText(text, aiService, fixedMessages);
  return parts.map((content, index) => ({ index: index + 1, total: parts.length, content }));
}
function createKnowledgeItemSegments(knowledgeItems: KnowledgeItem[], aiService: DesktopAiService, fixedMessages: Array<{ role?: string; content?: string }>): KnowledgeSegment[] {
  const segmentLimit = getGlobalFactsSegmentLimit(aiService, fixedMessages);
  const blocks = (knowledgeItems || [])
    .map((item, index) => formatKnowledgeItemForPrompt(item, index))
    .filter((block) => block.trim());
  const segments: KnowledgeSegment[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    segments.push({ content: current.join('\n\n'), itemCount: current.length, index: 0, total: 0 });
    current = [];
    currentLength = 0;
  };

  for (const block of blocks) {
    const nextLength = currentLength + block.length + (current.length ? 2 : 0);
    if (current.length && nextLength > segmentLimit) {
      flush();
    }
    current.push(block);
    currentLength += block.length + (current.length > 1 ? 2 : 0);
  }
  flush();
  return segments.map((segment, index) => ({ ...segment, index: index + 1, total: segments.length }));
}

function buildGlobalFactsLightContextMessages(context: BaseContext): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: GLOBAL_FACTS_SYSTEM_PROMPT }];
  if (context.sectionHint) {
    messages.push({ role: 'system', content: context.sectionHint });
  }
  messages.push(
    { role: 'user', content: `项目概述：\n${String(context.projectOverview || '').trim() || '未提供'}` },
    { role: 'user', content: `Step02 关键解析结果：\n${context.bidAnalysisFactsText}` },
    { role: 'user', content: `已生成技术方案目录：\n${formatOutlineForPrompt(((context.outlineData as { outline?: unknown[] } | null)?.outline || []) as unknown[])}` },
    { role: 'user', content: (context.knowledgeItems || []).length ? `用户已选择 ${(context.knowledgeItems || []).length} 条知识库条目；知识库正文将在独立分段步骤中处理。` : '用户未选择参考知识库。' },
  );
  return messages;
}
function buildGroupsJsonExample(): string {
  return `请返回 JSON，格式如下：
{
  "groups": [
    {
      "id": "project_team",
      "title": "项目角色变量",
      "content": "- 项目经理：张伟，负责总体协调。\n- 技术负责人：李明，负责方案设计和联调验收。"
    }
  ]
}`;
}
function buildPatchesJsonExample(): string {
  return `请返回 JSON，格式如下：
{
  "patches": [
    {
      "target_group_id": "project_team",
      "title": "项目角色变量",
      "mode": "append",
      "content": "- 现场负责人：王强，负责现场实施协调。"
    }
  ]
}`;
}
function buildTenderSegmentGlobalFactsMessages(context: BaseContext & { tenderSegment: TextSegment }): Array<{ role: string; content: string }> {
  const { tenderSegment } = context;
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `招标文件分段 ${tenderSegment.index}/${tenderSegment.total}：\n${tenderSegment.content}` },
    { role: 'user', content: `招标文件分段全局事实提取任务：

请只基于当前招标文件分段，识别后续技术方案正文必须保持一致的全局事实变量候选。

要求：
1. 当前分段没有提及，不代表整份招标文件没有提及；不要因为本段缺失就输出“没有提及”。
2. 当前分段直接给出明确事实时，提取为可复用的事实值。
3. 当前分段给出的是要求、约束或评价口径时，不要原样摘录为要求句；请判断它是否会影响后续正文的一致写法，必要时转写为本方案可统一采用的响应事实候选。
4. 每条 content 只写短 bullet，内容应是正文可直接引用或遵循的稳定事实、响应设定、承诺口径或执行安排。
5. 当前分段无法支持形成事实候选时，返回 {"groups":[]}；不要为了凑内容编造与本段无关的具体值。
6. 不要输出商务报价、资格材料、正文草稿、分析过程或来源说明。
7. 只返回 JSON。` },
    { role: 'user', content: buildGroupsJsonExample() },
  ];
}
function formatSegmentGroupResultForPrompt(result: GroupSegmentResult): string {
  return `## 第 ${result.index}/${result.total} 段候选
${JSON.stringify(result.groups || [], null, 2)}`;
}
function formatSegmentGroupsForPrompt(segmentResults: GroupSegmentResult[]): string {
  return (segmentResults || []).map(formatSegmentGroupResultForPrompt).join('\n\n');
}
function buildTenderSegmentMergeMessages(context: BaseContext & { segmentResults: GroupSegmentResult[] }): Array<{ role: string; content: string }> {
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `招标文件分段候选全局事实：\n${formatSegmentGroupsForPrompt(context.segmentResults)}` },
    { role: 'user', content: `招标文件全局事实合并任务：

请把所有分段候选合并为后续技术方案正文可直接使用的全局事实变量。

要求：
1. 分段候选只代表对应片段，合并时要综合所有片段，删除重复、空泛和互相矛盾的表述。
2. 合并后的结果必须是稳定的方案事实、响应设定、承诺口径或执行安排，不保留未落地的要求句、评分规则或资料清单。
3. 对招标文件中的硬性要求和约束，应判断其是否会影响后续正文的一致写法；会影响的，应转写为本方案统一采用的事实、安排或承诺口径。
4. 资料中已有明确事实值时使用明确值；资料没有明确值但该信息对全文一致性重要时，可以根据项目语境补足一套合理、稳定、不冲突的事实值。
5. 必须包含工期、运维期或交货时间中的至少一个相关变量；如果分段候选不足，但项目概述或 Step02 关键解析结果中已有明确内容，应补入。
6. 每条 bullet 都应回答“后续正文遇到这个事项时统一写什么”，而不是回答“招标文件要求什么”。
7. 仅编写技术方案部分，不要涉及商务报价或资格材料。
8. 只返回 JSON。` },
    { role: 'user', content: buildGroupsJsonExample() },
  ];
}
function buildKnowledgeSegmentPatchMessages(context: GroupContext & { knowledgeSegment: KnowledgeSegment }): Array<{ role: string; content: string }> {
  const { knowledgeSegment, groups } = context;
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `当前全局事实变量：\n${JSON.stringify(groups || [], null, 2)}` },
    { role: 'user', content: `知识库完整条目分段 ${knowledgeSegment.index}/${knowledgeSegment.total}：\n${knowledgeSegment.content}` },
    { role: 'user', content: `知识库全局事实补充任务：

请基于当前知识库分段，判断是否需要补充或修正全局事实变量。

要求：
1. 只返回需要补充或替换的 patches，不要重新生成全部 groups。
2. 只处理与项目概述、技术评分信息、目录和技术方案正文强相关，且能够沉淀为稳定方案事实的内容。
3. 知识库内容如果只是通用要求、规范说明、写作建议或参考素材，不要原样补充为事实变量；只有能够转为本项目统一采用的事实、安排、承诺口径或技术设定时才返回 patch。
4. 不要用知识库内容覆盖招标文件中的明确硬性要求；只有知识库提供更具体且不冲突的事实值时才补充。
5. 如果补充内容属于已有大项，target_group_id 必须使用已有 id。
6. 如果确实需要新增大项，提供 title 和 content。
7. mode 只能是 append、prepend 或 replace；默认使用 append。
8. 没有可补充内容时返回 {"patches":[]}。
9. 只返回 JSON。` },
    { role: 'user', content: buildPatchesJsonExample() },
  ];
}
function buildOriginalPlanSegmentPatchMessages(context: GroupContext & { originalPlanSegment: TextSegment }): Array<{ role: string; content: string }> {
  const { originalPlanSegment, groups } = context;
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `当前全局事实变量：\n${JSON.stringify(groups || [], null, 2)}` },
    { role: 'user', content: `原方案正文分段 ${originalPlanSegment.index}/${originalPlanSegment.total}：\n${originalPlanSegment.content}` },
    { role: 'user', content: `原方案全局事实补充任务：

当前是“已有方案扩写”模式。用户提供的原方案是本次要扩写的投标技术方案核心草稿，已有内容必须在后续扩写正文中被保留。

请基于当前原方案分段，补充或替换全局事实变量。

要求：
1. 原方案中已经写成投标方实际安排、既有承诺、统一配置、技术路线、服务口径或实施做法的内容，优先补充到全局事实变量中。
2. 原方案如果只是转述招标要求、评分规则、格式要求或资料提交要求，不要原样作为事实变量；只有能够转为后续正文统一采用的方案事实时才补充。
3. 只返回需要补充或替换的 patches，不要重新生成全部 groups。
4. 如果补充内容属于已有大项，target_group_id 必须使用已有 id。
5. 如果确实需要新增大项，提供 title 和 content。
6. mode 只能是 append、prepend 或 replace；当原方案明确事实与当前变量冲突且原方案应优先时使用 replace 或 prepend。
7. 每条 content 只写短 bullet，直接给可复用的变量值，不要写分析过程、来源说明、风险提示或正文草稿。
8. 没有可补充内容时返回 {"patches":[]}。
9. 只返回 JSON。` },
    { role: 'user', content: buildPatchesJsonExample() },
  ];
}
function formatPatchResultForPrompt(result: PatchSegmentResult): string {
  return `## 第 ${result.index}/${result.total} 段补充
${JSON.stringify(result.patches || [], null, 2)}`;
}
function formatPatchResultsForPrompt(patchResults: PatchSegmentResult[]): string {
  return (patchResults || []).map(formatPatchResultForPrompt).join('\n\n');
}
function buildSegmentPatchMergeMessages(context: GroupContext & { patchResults: PatchSegmentResult[]; sourceLabel: string }): Array<{ role: string; content: string }> {
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `当前全局事实变量：\n${JSON.stringify(context.groups || [], null, 2)}` },
    { role: 'user', content: `${context.sourceLabel}分段补充 patches：\n${formatPatchResultsForPrompt(context.patchResults)}` },
    { role: 'user', content: `${context.sourceLabel}全局事实补充合并任务：

请把所有分段 patches 合并成一份可应用的 patches。

要求：
1. 删除重复、空泛、互相矛盾或仍停留在要求摘录层面的补充项。
2. 能合并到同一变量组的内容尽量合并，避免对同一事实反复 append。
3. 合并后的 patch 内容必须是正文可直接统一使用的方案事实、响应设定、承诺口径或执行安排。
4. target_group_id 必须优先使用当前全局事实变量中已有的 id；确实需要新增大项时再提供 title 和 content。
5. mode 只能是 append、prepend 或 replace。
6. 没有可补充内容时返回 {"patches":[]}。
7. 只返回 JSON。` },
    { role: 'user', content: buildPatchesJsonExample() },
  ];
}
function buildFinalGlobalFactsReviewMessages(context: GroupContext): Array<{ role: string; content: string }> {
  return [
    ...buildGlobalFactsLightContextMessages(context),
    { role: 'user', content: `待最终整理的全局事实变量：\n${JSON.stringify(context.groups || [], null, 2)}` },
    { role: 'user', content: `全局事实变量最终整理任务：

请在不提交完整招标文件、完整原方案和知识库正文的前提下，基于当前轻量上下文整理最终全局事实变量。

要求：
1. 最终结果必须全部是后续技术方案正文可直接统一使用的事实变量。
2. 保留所有具体、可复用、会影响全文一致性的方案事实、响应设定、承诺口径和执行安排。
3. 合并同义或重复大项，删除空泛内容、明显重复 bullet，以及仍停留在招标要求、评分规则、资料清单、待办事项层面的内容。
4. 如果某条内容表达的是“需要满足什么要求”，请改写为“本方案统一采用什么事实、安排、承诺或响应口径”；无法形成稳定事实且不能帮助正文保持一致的，应删除。
5. 不要新增与当前事实相冲突的具体值、服务承诺或技术边界。
6. 必须保留工期、运维期或交货时间中的至少一个相关变量。
7. 每个 group 必须包含 id、title、content。
8. ${context.isExpansionWorkflow ? '当前是已有方案扩写模式，原方案分段补充后的事实优先保留，不要在最终整理时弱化或删除原方案已有承诺。' : '只返回 JSON。'}
${context.isExpansionWorkflow ? '9. 只返回 JSON。' : ''}` },
    { role: 'user', content: buildGroupsJsonExample() },
  ];
}

async function collectJson(aiService: DesktopAiService, options: Record<string, unknown>): Promise<unknown> {
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(options) : aiService.requestJson(options);
}
async function waitAllOrThrow<T>(tasks: Array<Promise<T>>): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
  if (rejected) {
    throw rejected.reason;
  }
  return (results as PromiseFulfilledResult<T>[]).map((result) => result.value);
}
function batchRenderedItems<T>(items: T[], renderItem: (item: T) => string, limit: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
    currentLength = 0;
  };

  for (const item of items || []) {
    const length = renderItem(item).length;
    const nextLength = currentLength + length + (current.length ? 2 : 0);
    if (current.length && nextLength > limit) {
      flush();
    }
    current.push(item);
    currentLength += length + (current.length > 1 ? 2 : 0);
  }
  flush();
  return batches;
}

type GroupMergeMessagesBuilder = (context: BaseContext & { segmentResults: GroupSegmentResult[] }) => Array<{ role: string; content: string }>;

async function collectGroupMerge(aiService: DesktopAiService, context: BaseContext, segmentResults: GroupSegmentResult[], mergeMessagesBuilder: GroupMergeMessagesBuilder, sourceLabel: string, log: LogFn, progress: number, labelSuffix = ''): Promise<{ groups: GlobalFactGroup[] }> {
  const result = await collectJson(aiService, {
    messages: mergeMessagesBuilder({ ...context, segmentResults }),
    temperature: 0.2,
    logTitle: `全局事实变量-${sourceLabel}-合并${labelSuffix}`,
    progressLabel: `${sourceLabel}全局事实合并${labelSuffix}`,
    failureMessage: `模型返回的${sourceLabel}全局事实合并结果格式无效`,
    normalizer: normalizeGlobalFactsResponse,
    validator: validateGlobalFactsResponse,
    progressCallback: async (message: string) => { await log(message, progress); },
  }) as { groups: GlobalFactGroup[] };
  return result;
}

async function mergeGroupResultsInBatches(params: {
  aiService: DesktopAiService;
  context: BaseContext;
  segmentResults: GroupSegmentResult[];
  mergeMessagesBuilder: GroupMergeMessagesBuilder;
  sourceLabel: string;
  log: LogFn;
  progress: number;
}): Promise<{ groups: GlobalFactGroup[] }> {
  const { aiService, context, segmentResults, mergeMessagesBuilder, sourceLabel, log, progress } = params;
  let pending: GroupSegmentResult[] = segmentResults || [];
  let round = 1;
  while (true) {
    const fixedMessages = mergeMessagesBuilder({ ...context, segmentResults: [] });
    const limit = getGlobalFactsSegmentLimit(aiService, fixedMessages);
    const batches = batchRenderedItems(pending, formatSegmentGroupResultForPrompt, limit);
    if (batches.length <= 1) {
      return collectGroupMerge(aiService, context, batches[0] || [], mergeMessagesBuilder, sourceLabel, log, progress, round > 1 ? `-第${round}轮` : '');
    }

    await log(`${sourceLabel}分段候选较多，正在分 ${batches.length} 批合并。`, progress);
    const first = await collectGroupMerge(aiService, context, batches[0], mergeMessagesBuilder, sourceLabel, log, progress, `-第${round}轮-第1批`);
    const rest = await waitAllOrThrow(batches.slice(1).map((batch, index) => (
      collectGroupMerge(aiService, context, batch, mergeMessagesBuilder, sourceLabel, log, progress, `-第${round}轮-第${index + 2}批`)
    )));
    const merged = [first, ...rest];
    const nextPending: GroupSegmentResult[] = merged.map((result, index) => ({ index: index + 1, total: merged.length, groups: result.groups || [] }));
    if (nextPending.length >= pending.length) {
      return collectGroupMerge(aiService, context, nextPending, mergeMessagesBuilder, sourceLabel, log, progress, `-第${round + 1}轮`);
    }
    pending = nextPending;
    round += 1;
  }
}

type PatchMessagesBuilder = (context: GroupContext & { segment: TextSegment }) => Array<{ role: string; content: string }>;

async function collectPatchMerge(aiService: DesktopAiService, context: GroupContext, patchResults: PatchSegmentResult[], sourceLabel: string, log: LogFn, progress: number, labelSuffix = ''): Promise<{ patches: GlobalFactPatch[] }> {
  const result = await collectJson(aiService, {
    messages: buildSegmentPatchMergeMessages({ ...context, patchResults, sourceLabel }),
    temperature: 0.2,
    logTitle: `全局事实变量-${sourceLabel}-补充合并${labelSuffix}`,
    progressLabel: `${sourceLabel}全局事实补充合并${labelSuffix}`,
    failureMessage: `模型返回的${sourceLabel}全局事实补充合并结果格式无效`,
    normalizer: normalizeGlobalFactsPatchResponse,
    validator: validateGlobalFactsPatchResponse,
    progressCallback: async (message: string) => { await log(message, progress); },
  }) as { patches: GlobalFactPatch[] };
  return result;
}

async function mergePatchResultsInBatches(params: {
  aiService: DesktopAiService;
  context: GroupContext;
  patchResults: PatchSegmentResult[];
  sourceLabel: string;
  log: LogFn;
  progress: number;
}): Promise<{ patches: GlobalFactPatch[] }> {
  const { aiService, context, patchResults, sourceLabel, log, progress } = params;
  let pending: PatchSegmentResult[] = patchResults || [];
  let round = 1;
  while (true) {
    const fixedMessages = buildSegmentPatchMergeMessages({ ...context, patchResults: [], sourceLabel });
    const limit = getGlobalFactsSegmentLimit(aiService, fixedMessages);
    const batches = batchRenderedItems(pending, formatPatchResultForPrompt, limit);
    if (batches.length <= 1) {
      return collectPatchMerge(aiService, context, batches[0] || [], sourceLabel, log, progress, round > 1 ? `-第${round}轮` : '');
    }

    await log(`${sourceLabel}分段补充项较多，正在分 ${batches.length} 批合并。`, progress);
    const first = await collectPatchMerge(aiService, context, batches[0], sourceLabel, log, progress, `-第${round}轮-第1批`);
    const rest = await waitAllOrThrow(batches.slice(1).map((batch, index) => (
      collectPatchMerge(aiService, context, batch, sourceLabel, log, progress, `-第${round}轮-第${index + 2}批`)
    )));
    const merged = [first, ...rest];
    const nextPending: PatchSegmentResult[] = merged.map((result, index) => ({ index: index + 1, total: merged.length, patches: result.patches || [] }));
    if (nextPending.length >= pending.length) {
      return collectPatchMerge(aiService, context, nextPending, sourceLabel, log, progress, `-第${round + 1}轮`);
    }
    pending = nextPending;
    round += 1;
  }
}

async function runSegmentedGroupExtraction(params: {
  aiService: DesktopAiService;
  context: BaseContext;
  sourceText: string;
  buildMessages: (context: BaseContext & { segment: TextSegment }) => Array<{ role: string; content: string }>;
  mergeMessagesBuilder: GroupMergeMessagesBuilder;
  log: LogFn;
  sourceLabel: string;
  startProgress: number;
  segmentProgress: number;
  mergeProgress: number;
}): Promise<{ groups: GlobalFactGroup[]; degraded?: boolean; diagnostics?: { fallbackStage: string; warnings: string[] } }> {
  const { aiService, context, sourceText, buildMessages, mergeMessagesBuilder, log, sourceLabel, startProgress, segmentProgress, mergeProgress } = params;
  const fixedMessages = buildMessages({ ...context, segment: { index: 999, total: 999, content: '' } });
  const segments = createTextSegments(sourceText, aiService, fixedMessages);
  if (!segments.length) {
    throw new Error(`${sourceLabel}内容为空，无法提取全局事实变量`);
  }

  await log(`${sourceLabel}已拆分为 ${segments.length} 段，开始分段提取全局事实变量。`, startProgress);
  let completed = 0;
  const runSegment = async (segment: TextSegment): Promise<GroupSegmentResult> => {
    const response = await collectJson(aiService, {
      messages: buildMessages({ ...context, segment }),
      temperature: 0.2,
      logTitle: `全局事实变量-${sourceLabel}-第${segment.index}段`,
      progressLabel: `${sourceLabel}全局事实 ${segment.index}/${segment.total}`,
      failureMessage: `模型返回的${sourceLabel}全局事实分段结果格式无效`,
      normalizer: normalizeGlobalFactsResponse,
      validator: validateGlobalFactsSegmentResponse,
      progressCallback: async (message: string) => { await log(message, segmentProgress); },
    }) as { groups: GlobalFactGroup[] };
    completed += 1;
    if (segments.length > 1) {
      await log(`${sourceLabel}全局事实分段已完成 ${completed}/${segments.length}。`, segmentProgress);
    }
    return { index: segment.index, total: segment.total, groups: response.groups || [] };
  };

  const firstResult = await runSegment(segments[0]);
  const remainingResults = segments.length > 1
    ? await waitAllOrThrow(segments.slice(1).map((segment) => runSegment(segment)))
    : [];
  const segmentResults = [firstResult, ...remainingResults].sort((left, right) => left.index - right.index);
  const requireDuration = sourceRequiresDurationFact(sourceText);

  if (segmentResults.length === 1) {
    validateGlobalFactsMinimumQuality(segmentResults[0].groups, { requireDuration });
    await log(`${sourceLabel}仅一个分段，已直接采用通过校验的分段事实。`, mergeProgress);
    return { groups: segmentResults[0].groups };
  }

  await log(`${sourceLabel}分段提取完成，正在合并全局事实变量。`, mergeProgress);
  try {
    const merged = await mergeGroupResultsInBatches({ aiService, context, segmentResults, mergeMessagesBuilder, sourceLabel, log, progress: mergeProgress });
    validateGlobalFactsMinimumQuality(merged.groups, { requireDuration });
    return merged;
  } catch (error) {
    const fallback = mergeGlobalFactGroupsDeterministically(segmentResults);
    validateGlobalFactsMinimumQuality(fallback.groups, { requireDuration });
    await log(`${sourceLabel}模型合并失败，已使用稳定性兜底完成归并。`, mergeProgress);
    return { groups: fallback.groups, degraded: true, diagnostics: { fallbackStage: 'tender-merge', warnings: fallback.warnings } };
  }
}

export async function runTenderGlobalFactsExtraction(aiService: DesktopAiService, context: BaseContext, tenderMarkdown: string, log: LogFn): Promise<{ groups: GlobalFactGroup[]; degraded?: boolean; diagnostics?: { fallbackStage: string; warnings: string[] } }> {
  return runSegmentedGroupExtraction({
    aiService,
    context,
    sourceText: tenderMarkdown,
    sourceLabel: '招标文件',
    startProgress: 24,
    segmentProgress: 34,
    mergeProgress: 44,
    buildMessages: ({ segment, ...rest }) => buildTenderSegmentGlobalFactsMessages({ ...rest, tenderSegment: segment }),
    mergeMessagesBuilder: buildTenderSegmentMergeMessages as GroupMergeMessagesBuilder,
    log,
  });
}

async function runSegmentedPatchExtraction(params: {
  aiService: DesktopAiService;
  context: GroupContext;
  segments: TextSegment[] | KnowledgeSegment[];
  buildMessages: PatchMessagesBuilder;
  mergeSourceLabel: string;
  log: LogFn;
  startProgress: number;
  segmentProgress: number;
  mergeProgress: number;
}): Promise<{ patches: GlobalFactPatch[] }> {
  const { aiService, context, segments, buildMessages, mergeSourceLabel, log, startProgress, segmentProgress, mergeProgress } = params;
  if (!segments.length) return { patches: [] };

  await log(`${mergeSourceLabel}已拆分为 ${segments.length} 段，开始分段补充全局事实变量。`, startProgress);
  let completed = 0;
  const runSegment = async (segment: TextSegment): Promise<PatchSegmentResult> => {
    const response = await collectJson(aiService, {
      messages: buildMessages({ ...context, segment }),
      temperature: 0.2,
      logTitle: `全局事实变量-${mergeSourceLabel}-第${segment.index}段`,
      progressLabel: `${mergeSourceLabel}全局事实补充 ${segment.index}/${segment.total}`,
      failureMessage: `模型返回的${mergeSourceLabel}全局事实补充结果格式无效`,
      normalizer: normalizeGlobalFactsPatchResponse,
      validator: validateGlobalFactsPatchResponse,
      progressCallback: async (message: string) => { await log(message, segmentProgress); },
    }) as { patches: GlobalFactPatch[] };
    completed += 1;
    if (segments.length > 1) {
      await log(`${mergeSourceLabel}全局事实补充分段已完成 ${completed}/${segments.length}。`, segmentProgress);
    }
    return { index: segment.index, total: segment.total, patches: response.patches || [] };
  };

  const firstResult = await runSegment(segments[0] as TextSegment);
  const remainingResults = segments.length > 1
    ? await waitAllOrThrow(segments.slice(1).map((segment) => runSegment(segment as TextSegment)))
    : [];
  const patchResults = [firstResult, ...remainingResults].sort((left, right) => left.index - right.index);
  const patchCount = patchResults.reduce((sum, result) => sum + (result.patches || []).length, 0);
  if (!patchCount) return { patches: [] };

  await log(`${mergeSourceLabel}分段补充完成，正在合并补充项。`, mergeProgress);
  return mergePatchResultsInBatches({ aiService, context, patchResults, sourceLabel: mergeSourceLabel, log, progress: mergeProgress });
}

export async function runKnowledgeGlobalFactPatches(aiService: DesktopAiService, context: GroupContext, knowledgeItems: KnowledgeItem[], log: LogFn): Promise<{ patches: GlobalFactPatch[] }> {
  if (!knowledgeItems.length) return { patches: [] };
  const fixedMessages = buildKnowledgeSegmentPatchMessages({ ...context, knowledgeSegment: { index: 999, total: 999, content: '', itemCount: 0 } });
  const segments = createKnowledgeItemSegments(knowledgeItems, aiService, fixedMessages);
  return runSegmentedPatchExtraction({
    aiService,
    context,
    segments,
    mergeSourceLabel: '知识库',
    startProgress: 52,
    segmentProgress: 58,
    mergeProgress: 64,
    buildMessages: ({ segment, ...rest }) => buildKnowledgeSegmentPatchMessages({ ...rest, knowledgeSegment: segment as KnowledgeSegment }),
    log,
  });
}

export async function runOriginalPlanGlobalFactPatches(aiService: DesktopAiService, context: GroupContext, originalPlanMarkdown: string, log: LogFn): Promise<{ patches: GlobalFactPatch[] }> {
  const fixedMessages = buildOriginalPlanSegmentPatchMessages({ ...context, originalPlanSegment: { index: 999, total: 999, content: '' } });
  const segments = createTextSegments(originalPlanMarkdown, aiService, fixedMessages);
  return runSegmentedPatchExtraction({
    aiService,
    context,
    segments,
    mergeSourceLabel: '原方案',
    startProgress: 70,
    segmentProgress: 77,
    mergeProgress: 84,
    buildMessages: ({ segment, ...rest }) => buildOriginalPlanSegmentPatchMessages({ ...rest, originalPlanSegment: segment }),
    log,
  });
}

export async function finalizeGlobalFacts(aiService: DesktopAiService, context: GroupContext, log: LogFn): Promise<{ groups: GlobalFactGroup[] }> {
  await log('正在最终整理全局事实变量。', 90);
  const result = await collectJson(aiService, {
    messages: buildFinalGlobalFactsReviewMessages(context),
    temperature: 0.2,
    logTitle: '全局事实变量-最终整理',
    progressLabel: '全局事实变量最终整理',
    failureMessage: '模型返回的全局事实变量最终结果格式无效',
    normalizer: normalizeGlobalFactsResponse,
    validator: validateGlobalFactsResponse,
    progressCallback: async (message: string) => { await log(message, 90); },
  }) as { groups: GlobalFactGroup[] };
  return result;
}

// 供 runner orchestration 复用的格式化助手（normalizeReferenceDocumentIds/BaseContext/GroupContext 已在声明处 export）。
export { formatBidAnalysisFactsForPrompt };
