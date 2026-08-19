import type { AgentService } from '../agent/types';
import type { AmbiguityCandidate, AmbiguityDecision } from './types';

const OUTPUT_FILE = 'response-deviation-classification.json';

const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'classification', 'confidence', 'reason'],
        properties: {
          candidateId: { type: 'string', minLength: 1 },
          classification: {
            type: 'string',
            enum: ['technical-source', 'response-template', 'principles', 'assessment-objects', 'exclude'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
  },
} as const;

function parseDecisions(content: unknown, candidates: AmbiguityCandidate[]): AmbiguityDecision[] {
  const parsed = typeof content === 'string' ? JSON.parse(content) : content;
  const decisions = Array.isArray((parsed as Record<string, unknown> | null)?.decisions)
    ? (parsed as { decisions: unknown[] }).decisions
    : null;
  if (!decisions) throw new Error('Pi Agent 未返回 decisions 数组');
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  return decisions.map((raw) => {
    const item = (raw || {}) as Record<string, unknown>;
    const candidateId = String(item.candidateId || '');
    const candidate = byId.get(candidateId);
    if (!candidate) throw new Error(`Pi Agent 返回了不存在的候选 ID：${candidateId || '(空)'}`);
    if (seen.has(candidateId)) throw new Error(`Pi Agent 重复返回候选 ID：${candidateId}`);
    seen.add(candidateId);
    const classification = String(item.classification || '') as AmbiguityDecision['classification'];
    if (!candidate.allowed.includes(classification)) {
      throw new Error(`候选 ${candidateId} 不允许分类为 ${classification}`);
    }
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`候选 ${candidateId} 置信度无效`);
    const reason = String(item.reason || '').trim();
    if (!reason) throw new Error(`候选 ${candidateId} 缺少判断依据`);
    return { candidateId, classification, confidence, reason };
  });
}

export async function classifyAmbiguities(input: {
  projectId: number;
  candidates: AmbiguityCandidate[];
  agentService?: AgentService;
}): Promise<{ decisions: AmbiguityDecision[]; degraded: boolean; warnings: string[] }> {
  if (!input.candidates.length) return { decisions: [], degraded: false, warnings: [] };
  if (!input.agentService) {
    return { decisions: [], degraded: true, warnings: ['Pi Agent 当前不可用，歧义项已保留待人工复核。'] };
  }

  try {
    const result = await input.agentService.runTask({
      task_id: `response-deviation-classify-${input.projectId}-${Date.now()}`,
      title: '技术响应与偏离表歧义分类',
      project_id: input.projectId,
      output_file: OUTPUT_FILE,
      timeout_ms: 180_000,
      max_retries: 1,
      files: [{ path: 'candidates.json', content: JSON.stringify({ candidates: input.candidates }, null, 2) }],
      json_validation_schemas: { [OUTPUT_FILE]: CLASSIFICATION_SCHEMA },
      prompt: [
        '读取 candidates.json，仅判断每个候选块的语义分类。',
        '不得改写、摘要或补写招标原文，不得新增候选 ID。',
        'classification 必须从该候选 allowed 数组中选择。',
        `把结果写入 ${OUTPUT_FILE}，然后调用 json-validation 校验。`,
      ].join('\n'),
      validateOutput: (candidate) => parseDecisions(candidate.output_content || candidate.assistant_text, input.candidates),
    });
    if (!result.success) {
      return { decisions: [], degraded: true, warnings: ['Pi Agent 正忙或未完成分类，歧义项已保留待人工复核。'] };
    }
    const decisions = parseDecisions(result.output_content || result.assistant_text, input.candidates);
    return { decisions, degraded: false, warnings: [] };
  } catch (error) {
    return {
      decisions: [],
      degraded: true,
      warnings: [`Pi Agent 分类结果无效，歧义项已保留待人工复核：${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
