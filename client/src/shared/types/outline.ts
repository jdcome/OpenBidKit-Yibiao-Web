export interface OutlineItem {
  id: string;
  title: string;
  description: string;
  source_requirement_id?: string;
  source_requirement_title?: string;
  knowledge_item_ids?: string[];
  outlineAttribute?: OutlineRootAttribute;
  contentMode?: OutlineContentMode;
  contentModeNote?: string;
  isMirror?: boolean;
  mirrorSourceText?: string;
  children?: OutlineItem[];
  content?: string;
}

export type OutlineMode = 'aligned';
export type OutlineExpansionMode = 'original-only' | 'ai-complement';
export type OutlineRootAttribute = 'general' | 'business' | 'qualification' | 'technical' | 'other';
export type OutlineContentMode = 'ai-generate' | 'template-fill' | 'point-to-point' | 'other';

export interface OutlineWordControlOptions {
  minWordsWan: number;
  maxWordsWan: number;
  wordsPerSectionWan: number;
  forceSectionWords: boolean;
}

export interface OutlineData {
  outline: OutlineItem[];
  project_name?: string;
  project_overview?: string;
  word_control_options?: OutlineWordControlOptions;
  word_control_snapshot?: Record<string, unknown>;
}

export interface TechnicalRequirementGroup {
  requirement_id: string;
  title: string;
  description: string;
  detail_points: string[];
}

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
  source_mode: 'none' | 'self_defined' | 'explicit_checklist';
  total: number;
  covered: number;
  repaired: number;
  partial: number;
  missing: number;
  covered_total: number;
  generated_at: string;
  items: ProposalStructureCoverageItem[];
}
