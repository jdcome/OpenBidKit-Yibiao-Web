export interface FieldEvidence { value: string; evidence: string; source: string }
export interface ResponseDeviationProjectFields {
  projectName?: FieldEvidence; projectNumber?: FieldEvidence; procurementNumber?: FieldEvidence;
  packageName?: FieldEvidence; packageNumber?: FieldEvidence;
}
export interface ResponseDeviationRow {
  id: string; sequenceNo: string; clauseNo: string; requirementTitle: string;
  requirementMarkdown: string; requirementPlainText: string; aggregation: string; confidence: string;
  responseText: string; deviationStatus: string; deviationExplanation: string; notes: string; manualEdited: boolean;
}
export interface ResponseDeviationWorkspace {
  id?: string; projectId: number; status: 'empty' | 'detecting' | 'review' | 'confirmed' | 'stale' | 'failed';
  tenderHash?: string; selectedSectionId?: string; selectedSectionTitle?: string;
  templateTitle?: string; templateKind?: string; projectFieldsJson?: ResponseDeviationProjectFields;
  templateSchemaJson?: { detected?: boolean; columns?: string[]; title?: string; prefixMarkdown?: string; suffixMarkdown?: string; source?: string };
  sourceScopeJson?: { title?: string; blockIds?: string[] }; statsJson?: Record<string, unknown>;
  generationTaskJson?: { status?: string; progress?: number; logs?: string[]; error?: string };
  rows: ResponseDeviationRow[];
}
export interface ResponseDeviationAvailability {
  available: boolean; reason: string; kind: string; templateTitle: string; sourceChapterTitle: string;
  confidence: string; tenderHash: string; selectedSectionId: string; workspaceExists?: boolean; workspaceStatus?: string;
}

export interface ResponseDeviationExportIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  evidence?: string;
}

export interface ResponseDeviationExportValidation {
  status: 'ok' | 'warning' | 'error';
  issues: ResponseDeviationExportIssue[];
  columns: string[];
  summary: {
    columnsCount: number;
    autoFilledCount: number;
    retainedPrefix: boolean;
    retainedSuffix: boolean;
  };
}
