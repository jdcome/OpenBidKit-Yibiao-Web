export type AiDiagnosticStage = 'request' | 'response' | 'parse' | 'normalize' | 'validate' | 'repair' | 'fallback' | 'complete';

export type AiDiagnosticErrorCode =
  | 'AI_HTTP_ERROR'
  | 'AI_TIMEOUT'
  | 'AI_RATE_LIMITED'
  | 'AI_STREAM_INCOMPLETE'
  | 'AI_JSON_SYNTAX_ERROR'
  | 'AI_JSON_TRUNCATED'
  | 'AI_SCHEMA_TOP_LEVEL_MISSING'
  | 'AI_SCHEMA_EMPTY_RESULT'
  | 'AI_SCHEMA_REQUIRED_FIELD_MISSING'
  | 'AI_NORMALIZATION_EMPTY'
  | 'AI_REPAIR_FAILED'
  | 'AI_TASK_NOT_STARTED'
  | 'AI_UNKNOWN_ERROR';

export interface AiDiagnosticContext {
  traceId: string;
  projectId?: number;
  userId?: number;
  taskId?: string;
  taskType?: string;
  operation: string;
}

export interface AiDiagnosticIssue {
  code: AiDiagnosticErrorCode;
  stage: AiDiagnosticStage;
  message: string;
  path?: string;
}

export interface AiResponseShapeSummary {
  type: 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'undefined' | 'other';
  length?: number;
  keys?: string[];
  fields?: Record<string, { type: string; length?: number }>;
}
