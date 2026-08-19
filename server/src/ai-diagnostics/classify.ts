import type { AiDiagnosticIssue, AiDiagnosticStage } from './types';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

export function classifyDiagnosticError(error: unknown, stage: AiDiagnosticStage): AiDiagnosticIssue {
  const message = messageOf(error);
  const status = Number((error as { status?: unknown; statusCode?: unknown } | null)?.status || (error as { statusCode?: unknown } | null)?.statusCode || 0);
  if (status === 429) return { code: 'AI_RATE_LIMITED', stage, message };
  if (/timeout|timed out|超时|AbortError/i.test(message)) return { code: 'AI_TIMEOUT', stage, message };
  if (/Unexpected end|unterminated|截断|不完整/i.test(message)) return { code: 'AI_JSON_TRUNCATED', stage, message };
  if (error instanceof SyntaxError || /JSON\s*(?:语法|parse)|解析 JSON/i.test(message)) return { code: 'AI_JSON_SYNTAX_ERROR', stage, message };
  if (/缺少\s*groups|missing\s+groups/i.test(message)) return { code: 'AI_SCHEMA_TOP_LEVEL_MISSING', stage, message };
  if (/groups.*(?:为空|empty)|缺少 groups$/i.test(message)) return { code: 'AI_SCHEMA_EMPTY_RESULT', stage, message };
  const groupIndex = message.match(/第\s*(\d+)\s*项.*缺少/i);
  if (groupIndex || /required field|id、title 或 content/i.test(message)) {
    return {
      code: 'AI_SCHEMA_REQUIRED_FIELD_MISSING',
      stage,
      message,
      path: groupIndex ? `groups[${Math.max(0, Number(groupIndex[1]) - 1)}]` : undefined,
    };
  }
  if (/normalize|归一化/i.test(message)) return { code: 'AI_NORMALIZATION_EMPTY', stage, message };
  if (/repair|修复/i.test(message)) return { code: 'AI_REPAIR_FAILED', stage, message };
  if (status >= 400) return { code: 'AI_HTTP_ERROR', stage, message };
  return { code: 'AI_UNKNOWN_ERROR', stage, message };
}
