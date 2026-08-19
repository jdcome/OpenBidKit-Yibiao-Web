import type {
  TechnicalProposalStructureRequirement,
  TechnicalProposalStructureMode,
} from './technicalProposalStructure';
import type { OutlineItem, OutlinePayload } from './outlineGenerationHelpers';

export type ProposalStructureCoverageStatus = 'covered' | 'repaired' | 'partial' | 'missing';

export interface ProposalStructureCoverageMatch {
  node_id: string;
  node_title: string;
  node_path: string;
  level: number;
  score: number;
  evidence: string;
}

export interface ProposalStructureCoverageItem {
  index: number;
  requirement: string;
  status: ProposalStructureCoverageStatus;
  matches: ProposalStructureCoverageMatch[];
  evidence: string;
}

export interface ProposalStructureCoverage {
  source_title: string;
  source_mode: TechnicalProposalStructureMode;
  total: number;
  covered: number;
  repaired: number;
  partial: number;
  missing: number;
  covered_total: number;
  generated_at: string;
  items: ProposalStructureCoverageItem[];
}

interface FlatOutlineNode {
  id: string;
  title: string;
  path: string;
  level: number;
  titleNorm: string;
  textNorm: string;
}

interface MatchCandidate {
  node: FlatOutlineNode;
  score: number;
  matchedTerms: string[];
  directTitleHit: boolean;
}

const GENERIC_TERMS = new Set([
  '项目',
  '本项目',
  '服务',
  '工作',
  '内容',
  '方案',
  '要求',
  '情况',
  '说明',
  '提供',
  '主要',
  '进行',
  '以及',
  '包括',
]);

const REQUIREMENT_SYNONYMS: Array<{ patterns: string[]; terms: string[] }> = [
  {
    patterns: ['项目理解', '对项目的理解', '需求理解'],
    terms: ['项目理解', '需求理解', '项目特点', '项目背景', '需求分析', '项目总体理解'],
  },
  {
    patterns: ['服务范围', '服务内容', '范围及内容'],
    terms: ['服务范围', '服务内容', '测评范围', '范围与内容', '服务内容理解'],
  },
  {
    patterns: ['服务工作依据', '工作依据', '工作目标', '服务工作的依据'],
    terms: ['服务依据', '工作依据', '测评依据', '服务目标', '工作目标'],
  },
  {
    patterns: ['服务机构', '机构设置', '岗位职责'],
    terms: ['服务机构', '机构设置', '组织机构', '项目组织', '岗位职责', '职责分工'],
  },
  {
    patterns: ['服务人员', '主要人员', '人员简历', '拟投入'],
    terms: ['服务人员', '主要人员', '人员配置', '人员简历', '项目人员', '拟投入人员'],
  },
  {
    patterns: ['分包计划', '拟分包', '情况说明'],
    terms: ['分包计划', '拟分包', '情况说明', '分包情况'],
  },
  {
    patterns: ['服务质量', '进度', '保密', '保证措施', '保障措施'],
    terms: ['服务质量', '质量保障', '质量保证', '进度', '进度保障', '保密', '保证措施', '保障措施'],
  },
  {
    patterns: ['重点', '难点', '重点难点'],
    terms: ['重点难点', '重点', '难点', '难点分析', '重点分析'],
  },
  {
    patterns: ['合理化建议', '合理建议'],
    terms: ['合理化建议', '合理建议', '优化建议', '建议'],
  },
];

function normalize(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/[《》“”"‘’'`]/g, '')
    .replace(/[，。；：、,.!?！？;:()[\]（）【】{}<>〈〉]/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeDisplay(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = normalizeDisplay(value);
    const key = normalize(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function splitRequirementTerms(title: string): string[] {
  const rawParts = normalizeDisplay(title)
    .replace(/[（）()]/g, '、')
    .split(/[、，,；;。.\s]+|及|和|与|等|的/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

  const terms: string[] = [title, ...rawParts];
  const titleNorm = normalize(title);
  for (const group of REQUIREMENT_SYNONYMS) {
    if (group.patterns.some((pattern) => titleNorm.includes(normalize(pattern)))) {
      terms.push(...group.terms);
    }
  }

  return uniq(terms).filter((term) => {
    const key = normalize(term);
    return key.length >= 2 && !GENERIC_TERMS.has(key);
  });
}

function flattenOutlineItems(items: OutlineItem[] | undefined, parents: string[] = [], fallbackPath: number[] = []): FlatOutlineNode[] {
  if (!Array.isArray(items)) return [];
  const result: FlatOutlineNode[] = [];
  items.forEach((item, index) => {
    const title = normalizeDisplay(item?.title);
    const pathIndex = [...fallbackPath, index + 1];
    const id = normalizeDisplay(item?.id) || `outline-${pathIndex.join('-')}`;
    const pathParts = title ? [...parents, title] : parents;
    const path = pathParts.join(' / ');
    const text = [
      title,
      item?.description,
      item?.content,
      item?.source_requirement_title,
      item?.source_requirement_id,
      path,
    ].map(normalizeDisplay).filter(Boolean).join(' ');
    result.push({
      id,
      title,
      path,
      level: pathParts.length,
      titleNorm: normalize(title),
      textNorm: normalize(text),
    });
    result.push(...flattenOutlineItems(item?.children, pathParts, pathIndex));
  });
  return result;
}

function scoreNode(requirement: string, terms: string[], node: FlatOutlineNode): MatchCandidate | null {
  const requirementNorm = normalize(requirement);
  const matchedTerms: string[] = [];
  let score = 0;
  let directTitleHit = false;

  if (requirementNorm && node.titleNorm) {
    if (node.titleNorm === requirementNorm || node.titleNorm.includes(requirementNorm)) {
      score += 120;
      directTitleHit = true;
    } else if (requirementNorm.includes(node.titleNorm) && node.titleNorm.length >= 4) {
      score += 70;
      directTitleHit = true;
    }
  }

  for (const term of terms) {
    const termNorm = normalize(term);
    if (!termNorm || termNorm.length < 2) continue;
    if (node.titleNorm.includes(termNorm)) {
      matchedTerms.push(term);
      score += termNorm.length >= 4 ? 20 : 14;
    } else if (node.textNorm.includes(termNorm)) {
      matchedTerms.push(term);
      score += termNorm.length >= 4 ? 10 : 6;
    }
  }

  const uniqueMatchedTerms = uniq(matchedTerms);
  if (!score && !uniqueMatchedTerms.length) return null;
  const levelPenalty = Math.max(0, node.level - 3) * 1.5;
  return {
    node,
    score: Math.round(Math.max(0, score - levelPenalty) * 10) / 10,
    matchedTerms: uniqueMatchedTerms,
    directTitleHit,
  };
}

function findBestMatches(requirement: string, outline: OutlinePayload): MatchCandidate[] {
  const terms = splitRequirementTerms(requirement);
  const nodes = flattenOutlineItems(outline?.outline);
  return nodes
    .map((node) => scoreNode(requirement, terms, node))
    .filter((item): item is MatchCandidate => Boolean(item))
    .sort((a, b) => b.score - a.score || a.node.level - b.node.level)
    .slice(0, 3);
}

function getBaseStatus(match: MatchCandidate | undefined): Exclude<ProposalStructureCoverageStatus, 'repaired'> {
  if (!match) return 'missing';
  const titleTermHits = match.matchedTerms.filter((term) => match.node.titleNorm.includes(normalize(term))).length;
  if (match.directTitleHit || match.score >= 38 || titleTermHits >= 2) return 'covered';
  if (match.score >= 18 || titleTermHits >= 1) return 'partial';
  return 'missing';
}

function buildMatchEvidence(match: MatchCandidate): string {
  const terms = match.matchedTerms.slice(0, 4).join('、');
  if (match.directTitleHit) {
    return `标题直接对应「${match.node.title || match.node.path}」。`;
  }
  return terms
    ? `命中「${match.node.title || match.node.path}」中的关键词：${terms}。`
    : `命中目录节点「${match.node.title || match.node.path}」。`;
}

function buildItemEvidence(status: ProposalStructureCoverageStatus, bestMatch: MatchCandidate | undefined): string {
  if (status === 'missing') return '最终目录中未找到可对应的章节节点，建议人工补充或重新生成。';
  if (!bestMatch) return '未形成有效匹配。';
  if (status === 'partial') return `${buildMatchEvidence(bestMatch)}但匹配较弱，建议人工复核。`;
  if (status === 'repaired') return `${buildMatchEvidence(bestMatch)}最终审核前未充分覆盖，已由最终审核补齐。`;
  return buildMatchEvidence(bestMatch);
}

function convertMatch(match: MatchCandidate): ProposalStructureCoverageMatch {
  return {
    node_id: match.node.id,
    node_title: match.node.title,
    node_path: match.node.path,
    level: match.node.level,
    score: match.score,
    evidence: buildMatchEvidence(match),
  };
}

export function buildProposalStructureCoverage(
  requirement: TechnicalProposalStructureRequirement | null | undefined,
  outline: OutlinePayload | null | undefined,
  options: { baseline?: ProposalStructureCoverage | null; generatedAt?: Date } = {},
): ProposalStructureCoverage | null {
  if (!requirement || requirement.mode !== 'explicit_checklist' || !Array.isArray(requirement.items) || requirement.items.length === 0) {
    return null;
  }
  const outlinePayload = outline || {};
  const items = requirement.items.map((item, itemIndex): ProposalStructureCoverageItem => {
    const requirementTitle = normalizeDisplay(item.title);
    const matches = findBestMatches(requirementTitle, outlinePayload);
    const baseStatus = getBaseStatus(matches[0]);
    const baselineItem = options.baseline?.items?.find((entry) => entry.index === itemIndex + 1);
    const status: ProposalStructureCoverageStatus = (
      baseStatus === 'covered'
      && baselineItem
      && (baselineItem.status === 'missing' || baselineItem.status === 'partial')
    )
      ? 'repaired'
      : baseStatus;
    return {
      index: itemIndex + 1,
      requirement: requirementTitle,
      status,
      matches: matches.map(convertMatch),
      evidence: buildItemEvidence(status, matches[0]),
    };
  });

  const covered = items.filter((item) => item.status === 'covered').length;
  const repaired = items.filter((item) => item.status === 'repaired').length;
  const partial = items.filter((item) => item.status === 'partial').length;
  const missing = items.filter((item) => item.status === 'missing').length;
  return {
    source_title: normalizeDisplay(requirement.title) || '技术/响应方案章节要求',
    source_mode: requirement.mode,
    total: items.length,
    covered,
    repaired,
    partial,
    missing,
    covered_total: covered + repaired,
    generated_at: (options.generatedAt || new Date()).toISOString(),
    items,
  };
}
