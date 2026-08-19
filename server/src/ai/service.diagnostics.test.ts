import assert from 'node:assert/strict';
import test from 'node:test';
import { collectJsonResponseWithConfigForTest, parseOrRepairJsonResponseWithConfigForTest } from './service';

function reporterFixture() {
  const calls: Array<{ method: string; args: any[] }> = [];
  let next = 0;
  const reporter = {
    async startAttempt(...args: any[]) { calls.push({ method: 'start', args }); return `attempt-${++next}`; },
    async recordAttemptStage(...args: any[]) { calls.push({ method: 'stage', args }); },
    async completeAttempt(...args: any[]) { calls.push({ method: 'complete', args }); },
    async failAttempt(...args: any[]) { calls.push({ method: 'fail', args }); },
  };
  return { reporter, calls };
}

const config = { model_name: 'test-model', text_model_provider: 'test', request_mode: 'normal' };

test('records malformed primary and successful repair without exposing prompt text', async () => {
  const { reporter, calls } = reporterFixture();
  const responses = ['{"groups":', '{"groups":[{"id":"term","title":"服务期限","content":"服务期限：二年"}]}'];
  const result = await collectJsonResponseWithConfigForTest({}, config, {
    messages: [{ role: 'system', content: 'TOP SECRET PROMPT' }],
    diagnostic: { context: { traceId: 'trace-1', operation: 'global-facts' }, reporter },
    validator(value: any) { assert.ok(Array.isArray(value.groups)); },
  }, async () => responses.shift()!);
  assert.equal(result.groups.length, 1);
  assert.equal(calls.filter((call) => call.method === 'start').length, 2);
  assert.equal(calls.some((call) => call.method === 'fail' && call.args[2].stage === 'parse'), true);
  assert.equal(calls.some((call) => call.method === 'complete'), true);
  assert.equal(JSON.stringify(calls).includes('TOP SECRET PROMPT'), false);
  const primaryMeta = calls.find((call) => call.method === 'start')?.args[1];
  assert.deepEqual(primaryMeta.messageRoles, ['system']);
  assert.equal(typeof primaryMeta.requestHash, 'string');
});

test('preserves final validator issue and trace metadata after all retries fail', async () => {
  const { reporter, calls } = reporterFixture();
  let count = 0;
  await assert.rejects(
    collectJsonResponseWithConfigForTest({}, config, {
      messages: [{ role: 'user', content: 'extract' }],
      max_retries: 2,
      failureMessage: '全局事实合并结果格式无效',
      diagnostic: { context: { traceId: 'trace-x', operation: 'global-facts-merge' }, reporter },
      validator(value: any) { if (!Array.isArray(value.groups) || value.groups.length === 0) throw new Error('全局事实结果缺少 groups'); },
    }, async () => { count += 1; return '{"groups":[]}'; }),
    (error: any) => error.message === '全局事实合并结果格式无效'
      && error.diagnosticTraceId === 'trace-x'
      && error.diagnosticStage === 'validate'
      && error.diagnosticCode === 'AI_SCHEMA_TOP_LEVEL_MISSING',
  );
  assert.equal(count, 6);
  assert.equal(calls.filter((call) => call.method === 'start').length, 6);
  assert.equal(calls.filter((call) => call.method === 'fail').length, 6);
  const repairFailure = calls.find((call) => call.method === 'fail' && call.args[1] === 'attempt-2');
  assert.equal(repairFailure?.args[3], '{"groups":[]}');
});

test('closes the primary attempt when the upstream request fails', async () => {
  const { reporter, calls } = reporterFixture();
  const upstream: any = new Error('rate limited');
  upstream.status = 429;
  await assert.rejects(collectJsonResponseWithConfigForTest({}, config, {
    messages: [{ role: 'user', content: 'extract' }],
    diagnostic: { context: { traceId: 'trace-http', operation: 'test' }, reporter },
  }, async () => { throw upstream; }));
  const failure = calls.find((call) => call.method === 'fail');
  assert.equal(failure?.args[2].code, 'AI_RATE_LIMITED');
  assert.equal(failure?.args[2].stage, 'request');
});

test('instruments parseJsonResponseContent repair path', async () => {
  const { reporter, calls } = reporterFixture();
  const result = await parseOrRepairJsonResponseWithConfigForTest({}, config, {
    messages: [{ role: 'user', content: 'original request' }],
    diagnostic: { context: { traceId: 'trace-parse', operation: 'parse-existing' }, reporter },
    validator(value: any) { assert.equal(value.ok, true); },
  }, '{bad', async () => '{"ok":true}');
  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.method === 'start').length, 2);
  assert.equal(calls.some((call) => call.method === 'fail' && call.args[2].stage === 'parse'), true);
});
