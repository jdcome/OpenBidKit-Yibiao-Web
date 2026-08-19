import type { SubjectReplacement } from '../../../shared/api/projects';

export type SubjectIdentityGroup = 'bidder' | 'buyer';
export type SubjectIdentityConfidence = 'default' | 'high' | 'medium';

export interface SubjectAliasCandidate {
  alias: string;
  group: SubjectIdentityGroup;
  confidence: SubjectIdentityConfidence;
  needsReview: boolean;
  reason: string;
  evidence?: string;
}

export interface SubjectIdentityAnalysis {
  tenderMarkdown: string;
  bidder: {
    fullname: string;
    aliases: SubjectAliasCandidate[];
  };
  buyer: {
    fullname: string;
    aliases: SubjectAliasCandidate[];
  };
}

export interface SubjectIdentityInput {
  bidderName?: string;
  buyerName?: string;
  tenderMarkdown?: string;
  existingReplacements?: SubjectReplacement[];
}

export type SubjectIdentityPromptStatus = 'confirmed' | 'dismissed' | null;

export interface SubjectIdentityPromptInput extends SubjectIdentityInput {
  promptStatus?: SubjectIdentityPromptStatus;
}

const DEFAULT_BIDDER_ALIASES = ['中标人', '供应商', '投标人', '我方', '乙方', '成交人'];
const DEFAULT_BUYER_ALIASES = ['采购人', '招标人', '甲方'];

const BUYER_CONTEXT_ALIASES = ['我院', '本院', '我行', '本行', '我校', '本校', '我局', '本局', '本单位', '我单位'];
const BIDDER_CONTEXT_ALIASES = ['响应供应商', '服务商', '承包人'];

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanAlias(value: unknown): string {
  return String(value ?? '').trim();
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function buyerAliasConfidence(alias: string, buyerName: string): SubjectIdentityConfidence {
  if ((alias === '我院' || alias === '本院') && includesAny(buyerName, ['医院', '卫生院', '医学院'])) return 'high';
  if ((alias === '我行' || alias === '本行') && includesAny(buyerName, ['银行', '农商行', '信用社'])) return 'high';
  if ((alias === '我校' || alias === '本校') && includesAny(buyerName, ['学校', '大学', '学院', '中学', '小学'])) return 'high';
  if ((alias === '我局' || alias === '本局') && includesAny(buyerName, ['局', '厅', '委'])) return 'high';
  if ((alias === '本单位' || alias === '我单位') && buyerName) return 'medium';
  return 'medium';
}

function firstEvidence(markdown: string, alias: string): string | undefined {
  const normalized = normalizeText(markdown);
  const index = normalized.indexOf(alias);
  if (index < 0) return undefined;
  const start = Math.max(0, index - 24);
  const end = Math.min(normalized.length, index + alias.length + 34);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalized.length ? '…' : '';
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function makeCandidate(
  alias: string,
  group: SubjectIdentityGroup,
  markdown: string,
  options: {
    confidence?: SubjectIdentityConfidence;
    needsReview?: boolean;
    reason: string;
    includeEvidence?: boolean;
  },
): SubjectAliasCandidate {
  return {
    alias,
    group,
    confidence: options.confidence || 'default',
    needsReview: Boolean(options.needsReview),
    reason: options.reason,
    evidence: options.includeEvidence ? firstEvidence(markdown, alias) : undefined,
  };
}

function bidderAliasReason(alias: string, markdown: string, fallback: string): string {
  if (alias === '我方' && firstEvidence(markdown, alias)) {
    return '招标文件中出现“我方”，需确认它是否代表投标方。';
  }
  return fallback;
}

function existingGroupByFullname(existing: SubjectReplacement[] | undefined, fullname: string): SubjectReplacement | undefined {
  const target = normalizeText(fullname);
  if (!target) return undefined;
  return (existing || []).find((group) => normalizeText(group.fullname) === target);
}

function pushUnique(list: SubjectAliasCandidate[], candidate: SubjectAliasCandidate): void {
  if (!candidate.alias || list.some((item) => item.alias === candidate.alias)) return;
  list.push(candidate);
}

export function analyzeSubjectIdentity(input: SubjectIdentityInput): SubjectIdentityAnalysis {
  const tenderMarkdown = String(input.tenderMarkdown || '');
  const bidderName = normalizeText(input.bidderName);
  const buyerName = normalizeText(input.buyerName);
  const existing = Array.isArray(input.existingReplacements) ? input.existingReplacements : [];
  const bidderExisting = existingGroupByFullname(existing, bidderName);
  const buyerExisting = existingGroupByFullname(existing, buyerName);

  const bidderAliases: SubjectAliasCandidate[] = [];
  const buyerAliases: SubjectAliasCandidate[] = [];

  for (const alias of bidderExisting?.synonyms || DEFAULT_BIDDER_ALIASES) {
    pushUnique(bidderAliases, makeCandidate(cleanAlias(alias), 'bidder', tenderMarkdown, {
      reason: bidderAliasReason(cleanAlias(alias), tenderMarkdown, bidderExisting ? '已有我方代称配置。' : '系统默认我方代称。'),
      needsReview: alias === '我方' && Boolean(firstEvidence(tenderMarkdown, alias)),
      includeEvidence: alias === '我方',
    }));
  }
  for (const alias of DEFAULT_BIDDER_ALIASES) {
    pushUnique(bidderAliases, makeCandidate(alias, 'bidder', tenderMarkdown, {
      reason: bidderAliasReason(alias, tenderMarkdown, '系统默认我方代称。'),
      needsReview: alias === '我方' && Boolean(firstEvidence(tenderMarkdown, alias)),
      includeEvidence: alias === '我方',
    }));
  }
  for (const alias of BIDDER_CONTEXT_ALIASES) {
    const evidence = firstEvidence(tenderMarkdown, alias);
    if (!evidence) continue;
    pushUnique(bidderAliases, makeCandidate(alias, 'bidder', tenderMarkdown, {
      confidence: 'medium',
      reason: '招标文件中出现的投标方/服务方称谓。',
      includeEvidence: true,
    }));
  }

  for (const alias of buyerExisting?.synonyms || DEFAULT_BUYER_ALIASES) {
    pushUnique(buyerAliases, makeCandidate(cleanAlias(alias), 'buyer', tenderMarkdown, {
      reason: buyerExisting ? '已有采购人代称配置。' : '系统默认采购人代称。',
      includeEvidence: Boolean(firstEvidence(tenderMarkdown, alias)),
    }));
  }
  for (const alias of DEFAULT_BUYER_ALIASES) {
    pushUnique(buyerAliases, makeCandidate(alias, 'buyer', tenderMarkdown, {
      reason: '系统默认采购人代称。',
      includeEvidence: Boolean(firstEvidence(tenderMarkdown, alias)),
    }));
  }
  for (const alias of BUYER_CONTEXT_ALIASES) {
    const evidence = firstEvidence(tenderMarkdown, alias);
    if (!evidence) continue;
    pushUnique(buyerAliases, makeCandidate(alias, 'buyer', tenderMarkdown, {
      confidence: buyerAliasConfidence(alias, buyerName),
      reason: `招标文件中出现“${alias}”，按采购人名称判断为采购人侧自称。`,
      includeEvidence: true,
    }));
  }

  // 同一个代称不能同时进入两组；默认保留显式更强的采购人自称，移除另一侧冲突。
  const buyerSet = new Set(buyerAliases.map((item) => item.alias));
  const filteredBidderAliases = bidderAliases.filter((item) => !buyerSet.has(item.alias));

  return {
    tenderMarkdown,
    bidder: { fullname: bidderName, aliases: filteredBidderAliases },
    buyer: { fullname: buyerName, aliases: buyerAliases },
  };
}

export function buildSubjectIdentityReplacements(input: SubjectIdentityInput): SubjectReplacement[] {
  const analysis = analyzeSubjectIdentity(input);
  const result: SubjectReplacement[] = [];

  if (analysis.bidder.fullname) {
    result.push({
      fullname: analysis.bidder.fullname,
      synonyms: analysis.bidder.aliases.map((item) => item.alias).filter(Boolean),
    });
  }
  if (analysis.buyer.fullname) {
    result.push({
      fullname: analysis.buyer.fullname,
      synonyms: analysis.buyer.aliases.map((item) => item.alias).filter(Boolean),
    });
  }

  return result
    .map((group) => ({
      fullname: group.fullname,
      synonyms: Array.from(new Set(group.synonyms.filter((synonym) => synonym && synonym !== group.fullname))),
    }))
    .filter((group) => group.fullname && group.synonyms.length);
}

export function shouldPromptSubjectIdentityConfirmation(input: SubjectIdentityPromptInput): boolean {
  if (input.promptStatus === 'confirmed' || input.promptStatus === 'dismissed') return false;
  const hasProjectIdentityContext = Boolean(
    normalizeText(input.bidderName)
    || normalizeText(input.buyerName)
    || normalizeText(input.tenderMarkdown)
    || (Array.isArray(input.existingReplacements) && input.existingReplacements.length > 0),
  );
  return hasProjectIdentityContext;
}

export function shouldBlockSubjectIdentityBeforeNext(promptStatus: SubjectIdentityPromptStatus): boolean {
  return promptStatus !== 'confirmed';
}
