import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAmbiguities } from './agentClassifier';

const candidates = [
  { id: 'candidate-1', title: '项目实施相关内容', text: '可能属于技术要求章节。', allowed: ['technical-source', 'exclude'] as const },
];

test('没有歧义候选时不调用 Pi Agent', async () => {
  let calls = 0;
  const result = await classifyAmbiguities({
    projectId: 10,
    candidates: [],
    agentService: { runTask: async () => { calls += 1; throw new Error('不应调用'); } } as never,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.degraded, false);
});

test('歧义候选通过一次受约束 Pi 调用返回分类', async () => {
  let payload: Record<string, unknown> | null = null;
  const result = await classifyAmbiguities({
    projectId: 10,
    candidates: candidates as never,
    agentService: {
      runTask: async (next: Record<string, unknown>) => {
        payload = next;
        return {
          success: true,
          output_content: JSON.stringify({
            decisions: [{ candidateId: 'candidate-1', classification: 'technical-source', confidence: 0.86, reason: '标题和上下文均指向技术要求。' }],
          }),
          assistant_text: '',
        };
      },
    } as never,
  });

  assert.equal(result.degraded, false);
  assert.equal(result.decisions[0].candidateId, 'candidate-1');
  assert.equal((payload?.project_id as number), 10);
  assert.ok(payload?.json_validation_schemas);
  assert.equal(Array.isArray(payload?.files), true);
});

test('Pi 返回不存在的候选 ID 时安全降级并要求人工复核', async () => {
  const result = await classifyAmbiguities({
    projectId: 10,
    candidates: candidates as never,
    agentService: {
      runTask: async () => ({
        success: true,
        output_content: JSON.stringify({
          decisions: [{ candidateId: 'unknown', classification: 'technical-source', confidence: 0.9, reason: '错误引用' }],
        }),
        assistant_text: '',
      }),
    } as never,
  });

  assert.equal(result.degraded, true);
  assert.deepEqual(result.decisions, []);
  assert.match(result.warnings.join(' '), /候选 ID/);
});

test('Pi 忙碌或不可用时不伪造结论', async () => {
  const result = await classifyAmbiguities({
    projectId: 10,
    candidates: candidates as never,
    agentService: {
      runTask: async () => ({ success: false, status: 'busy', skipped: true, message: 'busy' }),
    } as never,
  });

  assert.equal(result.degraded, true);
  assert.deepEqual(result.decisions, []);
  assert.match(result.warnings.join(' '), /人工复核/);
});
