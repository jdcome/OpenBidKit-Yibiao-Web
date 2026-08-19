// 移植自 client/electron/services/rejectionCheckTask.cjs（行 1-105, 191-366, 374-397, 440-472, 838-852, 1297-1505）。
// 废标项检查（runner #62 rejection-check-run）的共享基础设施：消息构造、findings 归一化、
// 去重、分段判定，以及三个子检查（rejection/typo/logic）的非分段实现。
//
// 降级范围（M1）：仅移植【非分段】路径——常见中小投标包 1 段直出。桌面另有 rolling 状态机 +
// 分段 fan-out + 批次定稿 + 全局合稿（cjs 行 473-1268, 1318-1442），用于超大投标包；此处
// shouldUseSegmented* 命中时抛清晰错误，提示减小文件体积，而非静默走会超 context 的单次调用。
//
// 适配点（桌面→web）：
//  - 子检查的 onProgress 改 async 感知（web 每条进度都持久+广播，需 await 保序；桌面同步）。
//  - runJson 直接用 aiService.collectJsonResponse（web wrapper 已暴露桌面签名）。
//  - developerLogger/textMetrics/compactLogError 是可观测性 no-op，整体丢弃（与 #58 一致）。
import { randomUUID } from 'node:crypto';
import { splitUserTextByContextLimit } from '../../document/userTextSplitter';
import type { DesktopAiService } from '../types';

// ---- 常量（cjs:6-14） ----
const typoExcerptRadius = 8;
const fullPromptLimitRatio = 0.6;

// ---- 基础助手（cjs:16-71） ----
function now(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function getBidDocumentIdFromItem(item: Record<string, unknown>, bidDocumentIds: Set<string>): string {
  const candidates = [
    item.bidDocumentId, item.bid_document_id, item.documentId, item.document_id,
    item.fileId, item.file_id, item.sourceFile, item.source_file,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  for (const candidate of candidates) {
    if (bidDocumentIds.has(candidate)) return candidate;
  }
  return bidDocumentIds.size === 1 ? Array.from(bidDocumentIds)[0] : '';
}

export function formatBidDocumentsForPrompt(input: { bidDocuments: BidDocument[] }): string {
  const documents = Array.isArray(input.bidDocuments) ? input.bidDocuments : [];
  return documents
    .map((document, index) => `【投标文件${index + 1}｜bidDocumentId：${document.id}｜文件名：${document.fileName || document.id}】\n${document.content}`)
    .join('\n\n--- 投标文件分隔线 ---\n\n');
}

function getArrayPayload(parsed: unknown, keys: string[]): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of keys) {
    const value = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeFindingType(value: unknown): 'invalidBid' | 'rejectionItem' {
  const raw = String(value || '').trim();
  if (raw === 'invalidBid' || raw.includes('无效')) return 'invalidBid';
  return 'rejectionItem';
}

function normalizeSeverity(value: unknown): 'high' | 'medium' | 'low' {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'high' || raw.includes('高')) return 'high';
  if (raw === 'low' || raw.includes('低')) return 'low';
  return 'medium';
}

// ---- 类型 ----
export interface BidDocument {
  id: string;
  fileName?: string;
  content: string;
}
export interface RejectionCheckInput {
  invalidBidAndRejectionItems: string;
  customCheckItems?: string;
  bidDocuments: BidDocument[];
}
export type ProgressCallback = (message: string) => Promise<void> | void;
export interface RejectionFinding {
  id: string;
  bidDocumentId: string;
  type: 'invalidBid' | 'rejectionItem';
  severity: 'high' | 'medium' | 'low';
  title: string;
  summary: string;
  requirement: string;
  bidEvidence: string;
  riskReason: string;
  suggestion: string;
}
export interface TypoFinding {
  id: string;
  bidDocumentId: string;
  wrongText: string;
  correctText: string;
  originalExcerpt: string;
  reason: string;
  locationHint: string;
  position: number;
}
export interface LogicFinding {
  id: string;
  bidDocumentId: string;
  title: string;
  originalText: string;
  locationHint: string;
  fallacyReason: string;
  suggestion: string;
}
export interface CheckResult {
  status: 'running' | 'success' | 'error';
  findings: unknown[];
  inputSignature: string;
  progressMessage?: string;
  error?: string;
  updatedAt: string;
}

export function createRunningResult(inputSignature: string, progressMessage: string): CheckResult {
  return { status: 'running', findings: [], inputSignature, progressMessage, updatedAt: now() };
}

// ---- 消息构造（cjs:73-235）逐字对齐 ----
function buildCommonRejectionCheckMessages(input: RejectionCheckInput): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    {
      role: 'user',
      content: `【废标项检查输入 v1｜检查项】
以下内容来自招标文件“无效投标”和“废标项”解析结果。后续任务必须优先基于这些检查口径，不要自行扩大到无法从电子投标文件判断的事项。

${input.invalidBidAndRejectionItems}`,
    },
  ];

  if (input.customCheckItems?.trim()) {
    messages.push({
      role: 'user',
      content: `【废标项检查输入 v1｜自定义检查项】
以下是用户补充的电子投标文件检查关注点。仅在能从电子投标文件正文、目录、附件文本或材料内容中判断时使用；如果涉及签字、盖章、密封、现场递交、纸质正副本等纸质或线下事项，必须忽略。

${input.customCheckItems.trim()}`,
    });
  }

  messages.push({
    role: 'user',
    content: `【废标项检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续每条风险必须明确返回所属 bidDocumentId，只能引用对应投标文件中可见的内容作为证据。

重要限制：当前原文由文本解析得到，图片、扫描件、截图、附件页等非文本内容可能已被过滤或无法完整呈现。检查材料缺失时，不得要求必须看到图片内容、扫描件正文或附件正文；如果投标文件中已经出现某项材料的章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索或其他可表明该材料已插入/已提交的结构性文本线索，应视为该材料至少存在提交线索。

${formatBidDocumentsForPrompt(input)}`,
  });

  return messages;
}

function buildRejectionCheckAnalysisMessages(input: RejectionCheckInput): Array<{ role: string; content: string }> {
  return [
    ...buildCommonRejectionCheckMessages(input),
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第一轮：分析】
请先分析检查范围，不要输出最终风险列表。

分析要求：
1. 梳理“无效投标”和“废标项”中哪些能通过电子投标文件内容判断。
2. 明确排除签字、盖章、密封、纸质正副本、现场递交、开标现场授权到场、纸质文件封装等纸质或线下事项。
3. 结合各投标文件目录和正文结构，指出重点核查章节、附件、报价、资格材料、技术/商务响应位置，并说明是否存在不同文件需要分别关注的风险。
4. 判断材料是否缺失时，先识别章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索等结构性文本线索；只要存在这类线索，就不能因为图片或扫描件正文不可见而判定缺失。
5. 如果某项检查需要外部事实、现场行为或纸质原件才能判断，标记为“不纳入电子文件检查”。
6. 仅输出分析结论，使用简体中文。`,
    },
  ];
}

function buildRejectionCheckInspectionMessages(input: RejectionCheckInput, analysis: string): Array<{ role: string; content: string }> {
  return [
    ...buildCommonRejectionCheckMessages(input),
    { role: 'user', content: `【废标项检查任务 v1｜第一轮分析结果】\n${analysis}` },
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第二轮：检查】
请基于第一轮分析逐项检查所有电子投标文件，输出初步风险列表。

检查要求：
1. 每条风险必须有某一份投标文件中的明确证据，并写明 bidDocumentId；证据不足不要输出。
2. 不检查签字、盖章、密封、纸质正副本、现场递交、纸质原件等事项。
3. 重点关注实质性条款未响应、必要章节或附件缺失、资格材料明显缺失/过期、报价或关键承诺前后矛盾、技术/商务偏离未说明等电子正文可判断风险。
4. 判断“材料缺失”时，只有在目录、章节标题、附件标题、材料清单、正文、表格和其他结构性线索中均找不到对应材料痕迹，才可以输出疑似缺失；不得仅因图片内容、扫描件正文或附件正文不可见而输出缺失风险。
5. 如果投标文件中已有对应材料的结构性文本线索，应视为至少有提交线索，可提示人工复核内容完整性，但不要判定为缺失。
6. 区分风险类型：无效标使用 invalidBid，废标项使用 rejectionItem。
7. 暂不要求 JSON，可用结构化 Markdown 输出初步结果。`,
    },
  ];
}

function buildRejectionCheckFinalMessages(input: RejectionCheckInput, analysis: string, draftFindings: string): Array<{ role: string; content: string }> {
  return [
    ...buildCommonRejectionCheckMessages(input),
    { role: 'user', content: `【废标项检查任务 v1｜第一轮分析结果】\n${analysis}` },
    { role: 'user', content: `【废标项检查任务 v1｜第二轮初步检查结果】\n${draftFindings}` },
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第三轮：补充与定稿】
请对第二轮结果去重、合并、补漏，并删除不符合要求的条目，最终只输出 JSON。

定稿规则：
1. 只保留能从电子投标文件原文判断且有明确证据的风险。
2. 删除签字、盖章、密封、纸质正副本、现场递交、纸质原件、开标现场行为等纸质或线下事项。
3. 删除只有猜测、没有投标文件证据、或仅凭常识无法确认的条目。
4. 删除仅因图片内容、扫描件正文或附件正文不可见而产生的材料缺失条目；如果投标文件中存在对应材料的章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索或其他结构性文本线索，不得将该材料定稿为缺失。
5. 同一问题合并为一条，标题简短明确。
6. severity 只能是 high、medium、low；type 只能是 invalidBid 或 rejectionItem。
7. 如果没有符合条件的风险，返回 {"findings":[]}。

JSON 格式：
{
  "findings": [
    {
      "bidDocumentId": "对应投标文件的 bidDocumentId，例如 bid-xxxx",
      "type": "invalidBid",
      "severity": "high",
      "title": "不超过 28 个中文字符的风险标题",
      "summary": "一句话概括风险",
      "requirement": "对应检查依据或招标要求，尽量引用原检查项",
      "bidEvidence": "投标文件中的明确证据、章节、原文摘录或缺失位置说明",
      "riskReason": "为什么该证据可能构成无效标或废标项风险",
      "suggestion": "建议用户如何处理或复核"
    }
  ]
}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function buildTypoCheckMessages(input: { bidDocuments: BidDocument[] }): Array<{ role: string; content: string }> {
  return [
    { role: 'user', content: `【错别字检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续只能检查这些原文中真实存在的文字，每条结果必须返回所属 bidDocumentId。

${formatBidDocumentsForPrompt(input)}` },
    { role: 'user', content: `【错别字检查任务 v1】
请检查投标文件中的错别字、明显别字、同音错字、形近错字和明显录入错误，并输出 JSON。

检查要求：
1. 只输出你高度确信的错别字，不输出风格建议、标点偏好、表达优化或术语争议。
2. 每条必须来自某一份投标文件原文，wrongText 必须是原文中出现的原始错字或短词，bidDocumentId 必须是输入中提供的真实 ID。
3. correctText 是建议改成的正确字词。
4. originalExcerpt 尽量摘录包含 wrongText 的原文短片段，便于程序校验；不要改写原文。
5. 如果没有明确错别字，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"对应投标文件的 bidDocumentId","wrongText":"原文中的错别字或短词","correctText":"建议正确字词","originalExcerpt":"包含错别字的原文短片段","reason":"为什么判断为错别字"}]}

仅输出 JSON，不要输出 Markdown、代码块或解释。` },
  ];
}

function buildLogicCheckMessages(input: { bidDocuments: BidDocument[] }): Array<{ role: string; content: string }> {
  return [
    { role: 'user', content: `【逻辑谬误检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续只能基于这些投标文件内容进行逻辑一致性检查，每条结果必须返回所属 bidDocumentId。

${formatBidDocumentsForPrompt(input)}` },
    { role: 'user', content: `【逻辑谬误检查任务 v1】
请检查投标文件中的逻辑谬误和前后不一致问题，并输出 JSON。

检查范围：
1. 句子本身存在逻辑漏洞、因果不成立、条件互相矛盾或结论无法由前文推出。
2. 全文前后不一致，包括但不限于处理相同工作的人员名单、设备型号、工期、金额、数量、服务期限、项目名称、技术参数等应高度一致的内容前后不一致。

输出要求：
1. 只保留有明确文本依据的问题，避免泛泛而谈。
2. 问题可能涉及同一份投标文件内的多处原文，originalText 可摘录关键原文，locationHint 写明大概位置、章节、表格或上下文线索，bidDocumentId 必须是输入中提供的真实 ID。
3. title 必须简短明确，便于作为折叠列表标题。
4. 如果没有明确逻辑谬误，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"对应投标文件的 bidDocumentId","title":"不超过 28 个中文字符的简短标题","originalText":"关键原文摘录，可包含同一份文件内多处摘录","locationHint":"大概位置、章节、表格或上下文线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]}

仅输出 JSON，不要输出 Markdown、代码块或解释。` },
  ];
}

// ---- findings 归一化（cjs:238-366）逐字对齐 ----
export function normalizeRejectionCheckFindings(parsed: unknown, bidDocuments: BidDocument[]): RejectionFinding[] {
  const bidDocumentIds = new Set((Array.isArray(bidDocuments) ? bidDocuments : []).map((document) => document.id).filter(Boolean));
  return getArrayPayload(parsed, ['findings', 'items', 'risks'])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item): RejectionFinding => {
      const bidDocumentId = getBidDocumentIdFromItem(item, bidDocumentIds);
      const title = normalizeText(item.title).slice(0, 80);
      const bidEvidence = normalizeText(item.bidEvidence || item.evidence || item.bid_evidence);
      const riskReason = normalizeText(item.riskReason || item.reason || item.risk_reason);
      return {
        id: normalizeText(item.id) || createId('rejection_finding'),
        bidDocumentId,
        type: normalizeFindingType(item.type),
        severity: normalizeSeverity(item.severity),
        title,
        summary: normalizeText(item.summary) || title,
        requirement: normalizeText(item.requirement || item.source) || '未明确引用具体检查依据，请人工复核。',
        bidEvidence,
        riskReason,
        suggestion: normalizeText(item.suggestion) || '请结合招标文件要求和投标文件原文人工复核后处理。',
      };
    })
    .filter((item) => item.bidDocumentId && item.title && item.bidEvidence && item.riskReason);
}

function findVerifiedTypoPosition(bidContent: string, wrongText: string, originalExcerpt: string, options: { segmentStartOffset?: number; segmentEndOffset?: number } = {}): number {
  if (!wrongText) return -1;
  const segmentStartOffset = Number.isFinite(Number(options.segmentStartOffset))
    ? Math.max(0, Math.floor(Number(options.segmentStartOffset)))
    : 0;
  const segmentEndOffset = Number.isFinite(Number(options.segmentEndOffset))
    ? Math.min(bidContent.length, Math.max(segmentStartOffset, Math.floor(Number(options.segmentEndOffset))))
    : bidContent.length;
  if (segmentStartOffset > 0 || segmentEndOffset < bidContent.length) {
    const segmentContent = bidContent.slice(segmentStartOffset, segmentEndOffset);
    if (originalExcerpt) {
      const excerptIndex = segmentContent.indexOf(originalExcerpt);
      const wrongIndexInExcerpt = originalExcerpt.indexOf(wrongText);
      if (excerptIndex >= 0 && wrongIndexInExcerpt >= 0) return segmentStartOffset + excerptIndex + wrongIndexInExcerpt;
    }
    const wrongIndexInSegment = segmentContent.indexOf(wrongText);
    if (wrongIndexInSegment >= 0) return segmentStartOffset + wrongIndexInSegment;
  }
  if (originalExcerpt) {
    const excerptIndex = bidContent.indexOf(originalExcerpt);
    const wrongIndexInExcerpt = originalExcerpt.indexOf(wrongText);
    if (excerptIndex >= 0 && wrongIndexInExcerpt >= 0) return excerptIndex + wrongIndexInExcerpt;
  }
  return bidContent.indexOf(wrongText);
}

function createVerifiedTypoExcerpt(bidContent: string, position: number, wrongText: string): string {
  let start = Math.max(0, position - typoExcerptRadius);
  let end = Math.min(bidContent.length, position + wrongText.length + typoExcerptRadius);
  const startTagOpen = bidContent.lastIndexOf('<', start);
  const startTagClose = bidContent.lastIndexOf('>', start);
  if (startTagOpen > startTagClose) {
    const tagEnd = bidContent.indexOf('>', start);
    if (tagEnd >= 0 && tagEnd < position) start = tagEnd + 1;
  }
  const endTagOpen = bidContent.lastIndexOf('<', end);
  const endTagClose = bidContent.lastIndexOf('>', end);
  if (endTagOpen > endTagClose) {
    const tagEnd = bidContent.indexOf('>', end);
    if (tagEnd >= 0) end = Math.min(bidContent.length, tagEnd + 1);
  }
  return bidContent.slice(start, end).trim();
}

function createLineLocationHint(bidContent: string, position: number): string {
  const before = bidContent.slice(0, Math.max(0, position));
  return `原文第 ${before.split(/\r\n|\r|\n/).length} 行附近`;
}

export function normalizeTypoCheckFindings(parsed: unknown, bidDocuments: BidDocument[], options: { segmentStartOffset?: number; segmentEndOffset?: number } = {}): TypoFinding[] {
  const documents = Array.isArray(bidDocuments) ? bidDocuments : [];
  const bidDocumentIds = new Set(documents.map((document) => document.id).filter(Boolean));
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  const seen = new Set<string>();
  const findings: TypoFinding[] = [];
  for (const item of getArrayPayload(parsed, ['findings', 'items', 'typos'])) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const bidDocumentId = getBidDocumentIdFromItem(record, bidDocumentIds);
    const bidDocument = documentMap.get(bidDocumentId);
    if (!bidDocument?.content) continue;
    const wrongText = normalizeText(record.wrongText || record.wrong_text || record.wrong || record.typo).slice(0, 60);
    const correctText = normalizeText(record.correctText || record.correct_text || record.correct || record.suggestion).slice(0, 60);
    const originalExcerpt = normalizeText(record.originalExcerpt || record.original_excerpt || record.excerpt || record.context);
    const reason = normalizeText(record.reason || record.riskReason || record.detail) || '疑似错别字，请结合原文复核。';
    if (!wrongText || !correctText || wrongText === correctText) continue;
    const position = findVerifiedTypoPosition(bidDocument.content, wrongText, originalExcerpt, options);
    if (position < 0) continue;
    const key = `${bidDocumentId} ${wrongText} ${correctText} ${position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      id: normalizeText(record.id) || createId('typo_finding'),
      bidDocumentId,
      wrongText,
      correctText,
      originalExcerpt: createVerifiedTypoExcerpt(bidDocument.content, position, wrongText),
      reason,
      locationHint: createLineLocationHint(bidDocument.content, position),
      position,
    });
  }
  return findings;
}

export function normalizeLogicCheckFindings(parsed: unknown, bidDocuments: BidDocument[]): LogicFinding[] {
  const bidDocumentIds = new Set((Array.isArray(bidDocuments) ? bidDocuments : []).map((document) => document.id).filter(Boolean));
  const seen = new Set<string>();
  const findings: LogicFinding[] = [];
  for (const item of getArrayPayload(parsed, ['findings', 'items', 'risks', 'issues'])) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const bidDocumentId = getBidDocumentIdFromItem(record, bidDocumentIds);
    const title = normalizeText(record.title || record.summary).slice(0, 80);
    const originalText = normalizeText(record.originalText || record.original_text || record.evidence || record.bidEvidence) || '未提供明确原文摘录，请结合位置线索复核。';
    const locationHint = normalizeText(record.locationHint || record.location_hint || record.location || record.position) || '未明确具体位置，请结合原文摘录复核。';
    const fallacyReason = normalizeText(record.fallacyReason || record.fallacy_reason || record.reason || record.riskReason);
    const suggestion = normalizeText(record.suggestion || record.recommendation) || '请结合投标文件上下文人工复核后修改。';
    if (!bidDocumentId || !title || !fallacyReason) continue;
    const key = `${bidDocumentId} ${title} ${fallacyReason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ id: normalizeText(record.id) || createId('logic_finding'), bidDocumentId, title, originalText, locationHint, fallacyReason, suggestion });
  }
  return findings;
}

// ---- 分段判定（cjs:374-396） ----
// 命中即说明投标包超过模型 context，桌面走 rolling 状态机；web 降级版未移植该路径，抛清晰错误。
function getCurrentAiConfig(aiService: DesktopAiService): Record<string, unknown> {
  try {
    return typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  } catch {
    return {};
  }
}

function shouldUseSegmentedPrompt(aiService: DesktopAiService, promptText: string, limitRatio = fullPromptLimitRatio): boolean {
  const config = getCurrentAiConfig(aiService);
  return splitUserTextByContextLimit(promptText, config, { limitRatio }).length > 1;
}

export function shouldUseSegmentedRejectionFlow(aiService: DesktopAiService, input: RejectionCheckInput): boolean {
  return shouldUseSegmentedPrompt(
    aiService,
    [input.invalidBidAndRejectionItems, input.customCheckItems, formatBidDocumentsForPrompt(input)].join('\n\n'),
  );
}

export function shouldUseSegmentedBidDocuments(aiService: DesktopAiService, bidDocuments: BidDocument[]): boolean {
  return shouldUseSegmentedPrompt(aiService, formatBidDocumentsForPrompt({ bidDocuments }));
}

// ---- 去重（cjs:455-471, 838-852） ----
function limitDedupeItems<T>(items: T[], maxCount: number, keyBuilder: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const key = normalizeText(keyBuilder(item)) || JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxCount) break;
  }
  return result;
}

export function dedupeRejectionFindings(findings: RejectionFinding[]): RejectionFinding[] {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => `${item.bidDocumentId} ${item.type} ${item.title} ${item.bidEvidence} ${item.riskReason}`);
}

export function dedupeTypoFindings(findings: TypoFinding[]): TypoFinding[] {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => {
    const position = Number(item.position);
    const positionKey = Number.isFinite(position) ? String(Math.floor(position)) : `${item.locationHint || ''} ${item.originalExcerpt || ''}`;
    return `${item.bidDocumentId} ${item.wrongText} ${item.correctText} ${positionKey}`;
  });
}

export function dedupeLogicFindings(findings: LogicFinding[]): LogicFinding[] {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => `${item.bidDocumentId} ${item.title} ${item.locationHint} ${item.fallacyReason}`);
}

// ---- AI 调用助手（cjs:1297-1316） ----
async function runText(aiService: DesktopAiService, request: Record<string, unknown>, label: string): Promise<string> {
  const content = await aiService.chat({
    ...request,
    logTitle: (request.logTitle as string) || (request.log_title as string) || label,
  });
  if (!content.trim()) {
    throw new Error(`${label}未返回内容`);
  }
  return content;
}

async function runJson(aiService: DesktopAiService, request: Record<string, unknown>, label: string): Promise<unknown> {
  const jsonRequest = {
    ...request,
    response_format: request.response_format || { type: 'json_object' },
    logTitle: (request.logTitle as string) || (request.log_title as string) || (request.progressLabel as string) || label,
  };
  return aiService.collectJsonResponse(jsonRequest);
}

// ---- 三个子检查：仅非分段路径（cjs:1444-1505） ----
// 命中分段时抛错（web 降级版未移植 rolling/segmented 状态机）。
export async function runRejectionItemCheck(aiService: DesktopAiService, input: RejectionCheckInput, onProgress: ProgressCallback): Promise<RejectionFinding[]> {
  if (shouldUseSegmentedRejectionFlow(aiService, input)) {
    throw new Error('投标文件总体积超过模型上下文长度，Web 版暂不支持分段废标项检查，请减少投标文件数量或体积后再试。');
  }

  await onProgress('第一轮：正在分析检查范围。');
  const analysis = await runText(
    aiService,
    { messages: buildRejectionCheckAnalysisMessages(input), temperature: 0.1 },
    '第一轮分析',
  );
  await onProgress('第二轮：正在逐项检查投标文件。');
  const draftFindings = await runText(
    aiService,
    { messages: buildRejectionCheckInspectionMessages(input, analysis), temperature: 0.1 },
    '第二轮检查',
  );
  await onProgress('第三轮：正在补充、去重并生成结果。');
  const payload = await runJson(aiService, {
    messages: buildRejectionCheckFinalMessages(input, analysis, draftFindings),
    temperature: 0.1,
    schemaName: 'RejectionCheckFindings',
    progressLabel: '废标项检查结果',
    failureMessage: '废标项检查结果格式无效，请重新检查',
  }, '第三轮定稿');
  return normalizeRejectionCheckFindings(payload, input.bidDocuments);
}

export async function runTypoCheck(aiService: DesktopAiService, bidDocuments: BidDocument[], onProgress: ProgressCallback): Promise<TypoFinding[]> {
  if (shouldUseSegmentedBidDocuments(aiService, bidDocuments)) {
    throw new Error('投标文件总体积超过模型上下文长度，Web 版暂不支持分段错别字检查，请减少投标文件数量或体积后再试。');
  }

  await onProgress('正在识别错别字候选。');
  const payload = await runJson(aiService, {
    messages: buildTypoCheckMessages({ bidDocuments }),
    temperature: 0.1,
    schemaName: 'TypoCheckFindings',
    progressLabel: '错别字检查结果',
    failureMessage: '错别字检查结果格式无效，请重新检查',
  }, '错别字检查');
  await onProgress('正在校验错别字原文位置。');
  return normalizeTypoCheckFindings(payload, bidDocuments);
}

export async function runLogicCheck(aiService: DesktopAiService, bidDocuments: BidDocument[], onProgress: ProgressCallback): Promise<LogicFinding[]> {
  if (shouldUseSegmentedBidDocuments(aiService, bidDocuments)) {
    throw new Error('投标文件总体积超过模型上下文长度，Web 版暂不支持分段逻辑检查，请减少投标文件数量或体积后再试。');
  }

  await onProgress('正在检查逻辑谬误。');
  const payload = await runJson(aiService, {
    messages: buildLogicCheckMessages({ bidDocuments }),
    temperature: 0.1,
    schemaName: 'LogicCheckFindings',
    progressLabel: '逻辑谬误检查结果',
    failureMessage: '逻辑谬误检查结果格式无效，请重新检查',
  }, '逻辑谬误检查');
  return normalizeLogicCheckFindings(payload, bidDocuments);
}
