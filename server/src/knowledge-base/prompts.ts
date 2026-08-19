// 知识抽取的 prompt 构造 + 结果归一化/校验/合并纯函数。
// 忠实移植自 client/electron/services/knowledgeBaseService.cjs 的同名函数（361-676）。
// 桌面把 aiService.collectJsonResponse 的 normalizer/validator 指向这里；web 同。
// 这些函数无副作用、不触 DB，方便单测。

export interface Block {
  id: string;
  type: string;
  heading_path?: string[];
  content: string;
}

export interface CandidateItem {
  id?: string;
  title: string;
  summary: string;
}

export interface CandidateItemRow extends CandidateItem {
  id: string;
  source?: string;
}

export interface MatchResult {
  id: string;
  ranges: string[][];
  block_ids: string[];
}

export interface NewItemResult {
  title: string;
  summary: string;
  ranges: string[][];
  block_ids: string[];
}

export interface DiscardedResult {
  ranges?: string[][];
  block_ids: string[];
  reason: string;
  source?: string;
}

export interface FinalItem {
  id: string;
  title: string;
  resume: string;
  content: string;
  source_block_ids: string[];
  source_file: string;
}

export interface Report {
  total_blocks: number;
  filtered_blocks_count: number;
  candidate_items_count: number;
  final_items_count: number;
  matched_blocks_count: number;
  discarded_blocks_count: number;
  system_discarded_after_retry_count: number;
  new_items_from_recovery_count: number;
  recovery_attempt_count: number;
  batch_size: number;
  coverage_rate: number;
  matched_rate: number;
  created_at: string;
}

export interface RecoveryStepResult {
  items: CandidateItemRow[];
  matches: MatchResult[];
  discarded: DiscardedResult[];
  system_discarded: DiscardedResult[];
  recovery_attempts: Array<{
    attempt: number;
    missing_before_count: number;
    matches: MatchResult[];
    new_items: NewItemResult[];
    discarded: DiscardedResult[];
  }>;
}

export function renderBlocksForPrompt(blocks: Block[]): string {
  return blocks.map((block) => {
    const headingPath = block.heading_path?.length ? block.heading_path.join(' > ') : '无';
    return [`[${block.id}]`, `type: ${block.type}`, `heading_path: ${headingPath}`, 'text:', block.content].join('\n');
  }).join('\n\n');
}

export function normalizeCandidateItems(parsed: unknown): CandidateItem[] {
  const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return (items as Array<Record<string, unknown>>)
    .map((item) => ({
      title: String(item?.title || '').trim(),
      summary: String(item?.summary || item?.resume || '').trim(),
    }))
    .filter((item) => item.title && item.summary);
}

export function validateCandidateItems(value: unknown): void {
  if (!Array.isArray((value as { items?: unknown })?.items)) {
    throw new Error('AI 返回结果缺少 items 数组');
  }
}

export function mergeCandidateItems(firstItems: CandidateItem[], supplementItems: CandidateItem[]): CandidateItemRow[] {
  const merged: CandidateItemRow[] = [];
  const seen = new Set<string>();
  for (const item of [...firstItems, ...supplementItems]) {
    const key = item.title.replace(/\s+/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      id: `K${String(merged.length + 1).padStart(6, '0')}`,
      title: item.title,
      summary: item.summary,
    });
  }
  return merged;
}

function buildDocumentBlocksUserMessage(blockText: string): { role: string; content: string } {
  return {
    role: 'user',
    content: ['以下是同一份文档的完整 block 列表。', '<document_blocks>', blockText, '</document_blocks>'].join('\n'),
  };
}

export function buildInitialItemMessages(documentName: string, blockText: string): Array<{ role: string; content: string }> {
  return [
    buildDocumentBlocksUserMessage(blockText),
    {
      role: 'user',
      content: [
        `文档名：${documentName}`,
        '你是投标资料知识库分析助手。你只负责从历史投标资料中提取对后续编写标书有复用价值的知识条目。',
        '任务：请从全文中提取有意义的知识条目数组。条目应覆盖技术方案、项目管理、质量、安全、进度、服务、应急、人员设备、类似业绩等可复用内容。',
        '只返回 JSON：{"items":[{"title":"","summary":""}]}',
        '要求：title 简洁明确；summary 说明该条目可如何用于编写投标文件；不要输出 id、content、段落编号、Markdown 或解释文字。',
      ].join('\n'),
    },
  ];
}

export function buildSupplementItemMessages(
  documentName: string,
  blockText: string,
  firstItems: CandidateItem[],
): Array<{ role: string; content: string }> {
  return [
    buildDocumentBlocksUserMessage(blockText),
    {
      role: 'user',
      content: [
        `文档名：${documentName}`,
        '你是投标资料知识库补漏助手。你只判断已有知识条目是否遗漏了重要主题，并补充缺失条目。',
        '任务：请检查第一轮条目是否遗漏了有复用价值的重要内容。如果有遗漏，只输出新增条目；如果没有遗漏，返回空 items 数组。',
        '只返回 JSON：{"items":[{"title":"","summary":""}]}',
        '如果没有新增条目，必须返回 {"items":[]}，这属于正常结果。',
        '不要重复已有条目，不要输出 id、content、段落编号、Markdown 或解释文字。',
        '',
        '<first_round_items>',
        JSON.stringify(firstItems.map(({ title, summary }) => ({ title, summary })), null, 2),
        '</first_round_items>',
      ].join('\n'),
    },
  ];
}

export function buildMatchMessages(
  documentName: string,
  blockText: string,
  batchItems: CandidateItemRow[],
): Array<{ role: string; content: string }> {
  const taskPrompt = [
    `文档名：${documentName}`,
    '你是投标知识库段落匹配助手。你只根据知识条目的标题和摘要，为其匹配强相关 block 范围。',
    '你将收到同一份文档的完整 block 列表，以及本次需要匹配的一小批知识条目。',
    '规则：',
    '1. 只处理本次给出的知识条目。',
    '2. 只匹配与条目强相关、可直接支撑该条目的 block。',
    '3. 如果某些 block 更可能属于其他未提供的条目，不要强行匹配。',
    '4. 只返回 id 和 ranges，不要输出正文，不要解释。',
    '5. ranges 使用闭区间：["P000001","P000003"] 表示连续 block；单个 block 写成 ["P000001","P000001"]。',
    '6. 只允许使用输入中存在的 block 编号和本批条目 id。',
    '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}]}',
    '',
    '以下是本次需要匹配的知识条目。只处理这些条目：',
    JSON.stringify(batchItems.map(({ id, title, summary }) => ({ id, title, summary })), null, 2),
  ].join('\n');

  return [buildDocumentBlocksUserMessage(blockText), { role: 'user', content: taskPrompt }];
}

export function buildRecoveryMessages(
  documentName: string,
  items: CandidateItemRow[],
  missingBlocks: Block[],
): Array<{ role: string; content: string }> {
  return [
    {
      role: 'user',
      content: ['以下是当前尚未处理的遗漏 block。', '<missing_blocks>', renderBlocksForPrompt(missingBlocks), '</missing_blocks>'].join('\n'),
    },
    {
      role: 'user',
      content: [
        `文档名：${documentName}`,
        '你是投标知识库遗漏段落补漏助手。必须把所有收到的遗漏 block 明确归入已有条目、新增条目或舍弃段落。',
        '任务：必须覆盖所有遗漏 block。每个遗漏 block 只能进入以下三类之一：',
        '1. matches：归入已有知识条目，只返回已有 id 和 ranges。',
        '2. new_items：如果没有合适的已有条目但内容有复用价值，则新增知识条目，并给出 title、summary、ranges。',
        '3. discarded：如果内容质量低、重复、格式残留或无投标复用价值，则推荐舍弃，并给出 reason。',
        '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}],"new_items":[{"title":"","summary":"","ranges":[["P000004","P000005"]]}],"discarded":[{"ranges":[["P000006","P000006"]],"reason":""}]}',
        '不要输出正文、Markdown 或解释文字。',
        '',
        '<knowledge_items>',
        JSON.stringify(items.map(({ id, title, summary }) => ({ id, title, summary })), null, 2),
        '</knowledge_items>',
      ].join('\n'),
    },
  ];
}

export function getBlockOrder(blocks: Block[]): Map<string, number> {
  return new Map(blocks.map((block, index) => [block.id, index]));
}

function normalizeRangePair(range: unknown): [string, string] | null {
  if (Array.isArray(range)) {
    const start = String(range[0] || '').trim();
    const end = String(range[1] ?? range[0] ?? '').trim();
    return start ? [start, end] : null;
  }
  const id = String(range || '').trim();
  return id ? [id, id] : null;
}

export function normalizeRanges(ranges: unknown, blockOrder: Map<string, number>): string[][] {
  if (!Array.isArray(ranges)) return [];
  const normalized: string[][] = [];
  for (const range of ranges) {
    const pair = normalizeRangePair(range);
    if (!pair) continue;
    let [start, end] = pair;
    if (!blockOrder.has(start) || !blockOrder.has(end)) continue;
    if ((blockOrder.get(start) as number) > (blockOrder.get(end) as number)) {
      [start, end] = [end, start];
    }
    normalized.push([start, end]);
  }
  return normalized;
}

export function expandRanges(ranges: string[][], blocks: Block[], blockOrder: Map<string, number>): string[] {
  const ids: string[] = [];
  for (const [start, end] of ranges) {
    const startIndex = blockOrder.get(start);
    const endIndex = blockOrder.get(end);
    if (startIndex === undefined || endIndex === undefined) continue;
    for (let index = startIndex; index <= endIndex; index += 1) {
      ids.push(blocks[index].id);
    }
  }
  return [...new Set(ids)];
}

export function normalizeMatchResult(
  parsed: unknown,
  itemIds: Set<string>,
  blocks: Block[],
  blockOrder: Map<string, number>,
): { matches: MatchResult[] } {
  const matches = Array.isArray((parsed as { matches?: unknown })?.matches) ? (parsed as { matches: unknown[] }).matches : [];
  return {
    matches: matches
      .map((match) => {
        const id = String((match as { id?: unknown })?.id || '').trim();
        const ranges = normalizeRanges(
          (match as { ranges?: unknown; paragraph_ranges?: unknown; block_ranges?: unknown })?.ranges
            ?? (match as { paragraph_ranges?: unknown })?.paragraph_ranges
            ?? (match as { block_ranges?: unknown })?.block_ranges
            ?? [],
          blockOrder,
        );
        return itemIds.has(id) && ranges.length ? { id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
      })
      .filter(Boolean) as MatchResult[],
  };
}

export function validateMatchResult(value: unknown): void {
  if (!Array.isArray((value as { matches?: unknown })?.matches)) {
    throw new Error('AI 返回结果缺少 matches 数组');
  }
}

export function normalizeRecoveryResult(
  parsed: unknown,
  itemIds: Set<string>,
  blocks: Block[],
  blockOrder: Map<string, number>,
): { matches: MatchResult[]; new_items: NewItemResult[]; discarded: DiscardedResult[] } {
  const matches = Array.isArray((parsed as { matches?: unknown })?.matches) ? (parsed as { matches: unknown[] }).matches : [];
  const newItems = Array.isArray((parsed as { new_items?: unknown })?.new_items) ? (parsed as { new_items: unknown[] }).new_items : [];
  const discarded = Array.isArray((parsed as { discarded?: unknown })?.discarded) ? (parsed as { discarded: unknown[] }).discarded : [];

  return {
    matches: matches
      .map((match) => {
        const id = String((match as { id?: unknown })?.id || '').trim();
        const ranges = normalizeRanges((match as { ranges?: unknown })?.ranges, blockOrder);
        return itemIds.has(id) && ranges.length ? { id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
      })
      .filter(Boolean) as MatchResult[],
    new_items: newItems
      .map((item) => {
        const title = String((item as { title?: unknown })?.title || '').trim();
        const summary = String(((item as { summary?: unknown; resume?: unknown })?.summary ?? (item as { resume?: unknown })?.resume) || '').trim();
        const ranges = normalizeRanges((item as { ranges?: unknown })?.ranges, blockOrder);
        return title && summary && ranges.length ? { title, summary, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
      })
      .filter(Boolean) as NewItemResult[],
    discarded: discarded
      .map((item) => {
        const ranges = normalizeRanges((item as { ranges?: unknown })?.ranges, blockOrder);
        return ranges.length
          ? {
              ranges,
              block_ids: expandRanges(ranges, blocks, blockOrder),
              reason: String((item as { reason?: unknown })?.reason || 'AI 建议舍弃').trim() || 'AI 建议舍弃',
            }
          : null;
      })
      .filter(Boolean) as DiscardedResult[],
  };
}

export function validateRecoveryResult(value: unknown): void {
  if (
    !Array.isArray((value as { matches?: unknown })?.matches)
    || !Array.isArray((value as { new_items?: unknown })?.new_items)
    || !Array.isArray((value as { discarded?: unknown })?.discarded)
  ) {
    throw new Error('AI 返回结果缺少 matches/new_items/discarded 数组');
  }
}

function collectHandledBlockIds(matches: MatchResult[], discarded: DiscardedResult[], systemDiscarded: DiscardedResult[]): Set<string> {
  const handled = new Set<string>();
  matches.forEach((match) => match.block_ids.forEach((id) => handled.add(id)));
  discarded.forEach((item) => item.block_ids.forEach((id) => handled.add(id)));
  systemDiscarded.forEach((item) => item.block_ids.forEach((id) => handled.add(id)));
  return handled;
}

export function getMissingBlocks(blocks: Block[], matches: MatchResult[], discarded: DiscardedResult[], systemDiscarded: DiscardedResult[]): Block[] {
  const handled = collectHandledBlockIds(matches, discarded, systemDiscarded);
  return blocks.filter((block) => !handled.has(block.id));
}

export function nextKnowledgeItemId(items: CandidateItemRow[]): string {
  let max = 0;
  items.forEach((item) => {
    const match = /^K(\d+)$/.exec(item.id || '');
    if (match) max = Math.max(max, Number(match[1]));
  });
  return `K${String(max + 1).padStart(6, '0')}`;
}

export function createFinalItems(
  items: CandidateItemRow[],
  matches: MatchResult[],
  blocks: Block[],
  fileName: string,
): FinalItem[] {
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  const blocksByItem = new Map<string, string[]>();
  matches.forEach((match) => {
    const current = blocksByItem.get(match.id) || [];
    blocksByItem.set(match.id, [...new Set([...current, ...match.block_ids])]);
  });

  return items
    .map((item) => {
      const sourceBlockIds = blocksByItem.get(item.id) || [];
      const content = sourceBlockIds.map((id) => blockMap.get(id)?.content || '').filter(Boolean).join('\n\n').trim();
      return {
        id: item.id,
        title: item.title,
        resume: item.summary,
        content,
        source_block_ids: sourceBlockIds,
        source_file: fileName,
      };
    })
    .filter((item) => item.content);
}

export function createReport(params: {
  blocks: Block[];
  filteredBlocks: Block[];
  candidateItems: CandidateItemRow[];
  finalItems: FinalItem[];
  matches: MatchResult[];
  discarded: DiscardedResult[];
  systemDiscarded: DiscardedResult[];
  recoveryAttempts: RecoveryStepResult['recovery_attempts'];
  batchSize: number;
}): Report {
  const matched = new Set<string>();
  params.matches.forEach((match) => match.block_ids.forEach((id) => matched.add(id)));
  const discardedSet = new Set<string>();
  params.discarded.forEach((item) => item.block_ids.forEach((id) => discardedSet.add(id)));
  const systemSet = new Set<string>();
  params.systemDiscarded.forEach((item) => item.block_ids.forEach((id) => systemSet.add(id)));
  const handled = new Set([...matched, ...discardedSet, ...systemSet]);
  const total = params.blocks.length || 1;

  return {
    total_blocks: params.blocks.length,
    filtered_blocks_count: params.filteredBlocks.length,
    candidate_items_count: params.candidateItems.length,
    final_items_count: params.finalItems.length,
    matched_blocks_count: matched.size,
    discarded_blocks_count: discardedSet.size,
    system_discarded_after_retry_count: systemSet.size,
    new_items_from_recovery_count: params.recoveryAttempts.reduce((sum, attempt) => sum + attempt.new_items.length, 0),
    recovery_attempt_count: params.recoveryAttempts.length,
    batch_size: params.batchSize,
    coverage_rate: Number((handled.size / total).toFixed(4)),
    matched_rate: Number((matched.size / total).toFixed(4)),
    created_at: new Date().toISOString(),
  };
}

export function isRecoveryStepResult(value: unknown): value is RecoveryStepResult {
  return Boolean(
    value
      && Array.isArray((value as RecoveryStepResult).items)
      && Array.isArray((value as RecoveryStepResult).matches)
      && Array.isArray((value as RecoveryStepResult).discarded)
      && Array.isArray((value as RecoveryStepResult).system_discarded)
      && Array.isArray((value as RecoveryStepResult).recovery_attempts),
  );
}

export function isSameStringList(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => String(value) === String(b[index]));
}
