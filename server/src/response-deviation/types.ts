export type BidSectionMode = 'single' | 'multiple';

export interface ProjectTenderAnalysisSnapshot {
  projectInfo: unknown;
  procurementList: unknown;
  responseFileRequirements: unknown;
}

export interface ProjectTenderSourceSnapshot {
  projectId: number;
  fileName: string;
  markdown: string;
  selectedSectionMarkdown?: string;
  tenderHash: string;
  parserLabel: string;
  selectedSectionId: string;
  selectedSectionTitle: string;
  selectedSectionHeadLine: string;
  bidSectionMode: BidSectionMode;
  analysis: ProjectTenderAnalysisSnapshot;
}

export interface ProjectTenderSourceService {
  getSnapshot(projectId: number): Promise<ProjectTenderSourceSnapshot | null>;
}

export type TenderBlockType = 'heading' | 'paragraph' | 'list-item' | 'markdown-table' | 'html-table';

export interface TenderBlock {
  id: string;
  type: TenderBlockType;
  raw: string;
  text: string;
  headingPath: string[];
  clauseNo: string;
  level: number;
  start: number;
  end: number;
}

export type ResponseDeviationAvailabilityReason =
  | 'available'
  | 'no-tender'
  | 'package-required'
  | 'no-template'
  | 'business-only'
  | 'no-technical-source';

export interface ResponseDeviationAvailability {
  available: boolean;
  reason: ResponseDeviationAvailabilityReason;
  kind: 'technical' | 'combined' | 'business-only' | 'none';
  templateTitle: string;
  sourceChapterTitle: string;
  sourceBlockIds: string[];
  sourceText: string;
  confidence: 'high' | 'review';
  tenderHash: string;
  selectedSectionId: string;
}

export type RequirementAggregation = 'numbered-clause' | 'principles' | 'assessment-objects' | 'method-content' | 'unnumbered-section';

export interface ExtractedRequirementRow {
  clauseNo: string;
  requirementTitle: string;
  requirementMarkdown: string;
  requirementPlainText: string;
  sourceBlockIds: string[];
  aggregation: RequirementAggregation;
  sourceFingerprint: string;
  confidence: 'high' | 'review';
}

export interface ExtractionResult {
  rows: ExtractedRequirementRow[];
  coveredBlockIds: string[];
  uncoveredBlockIds: string[];
  duplicateBlockIds: string[];
}

export type AmbiguityClassification = 'technical-source' | 'response-template' | 'principles' | 'assessment-objects' | 'exclude';

export interface AmbiguityCandidate {
  id: string;
  title: string;
  text: string;
  allowed: readonly AmbiguityClassification[];
}

export interface AmbiguityDecision {
  candidateId: string;
  classification: AmbiguityClassification;
  confidence: number;
  reason: string;
}
