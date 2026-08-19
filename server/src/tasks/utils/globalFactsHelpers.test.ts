import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeGlobalFactGroupsDeterministically,
  validateGlobalFactsMinimumQuality,
  validateGlobalFactsSegmentResponse,
  buildGlobalFactsFromAnalysisContext,
} from './globalFactsHelpers';
import * as globalFactsHelpers from './globalFactsHelpers';

test('merges duplicate groups and bullets without inventing values', () => {
  const result = mergeGlobalFactGroupsDeterministically([
    { index: 1, total: 2, groups: [{ id: 'service_term', title: '服务期限', content: '- 服务期限：二年。' }] },
    { index: 2, total: 2, groups: [{ id: 'service_term', title: '服务期限', content: '- 服务期限：二年。\n- 服务地点：甲方指定地点。' }] },
  ]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].content.match(/服务期限：二年/g)?.length, 1);
  assert.match(result.groups[0].content, /服务地点：甲方指定地点/);
});

test('builds a non-inventive fallback from existing Step02 analysis', () => {
  const source = '### 项目概述\n- 服务期限：二年。\n- 服务地点：甲方指定地点。';
  const result = buildGlobalFactsFromAnalysisContext({ projectOverview: source });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].content, source);
  assert.match(result.groups[0].content, /服务期限：二年/);
});

test('merges equal normalized titles with different ids in stable order', () => {
  const result = mergeGlobalFactGroupsDeterministically([
    { index: 1, total: 2, groups: [{ id: 'term_a', title: ' 服务期限 ', content: '- 服务期限：二年。' }] },
    { index: 2, total: 2, groups: [{ id: 'term_b', title: '服务期限', content: '- 服务地点：甲方指定地点。' }] },
  ]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].id, 'term_a');
});

test('minimum quality requires a duration fact', () => {
  assert.doesNotThrow(() => validateGlobalFactsMinimumQuality([{ id: 'term', title: '服务期限', content: '- 服务期限：二年。' }]));
  assert.throws(() => validateGlobalFactsMinimumQuality([{ id: 'place', title: '地点', content: '- 地点：武汉。' }]), /工期、服务期或交付时间/);
});

test('rejects an empty segment result so collectJson can retry', () => {
  assert.throws(
    () => validateGlobalFactsSegmentResponse({ groups: [] }),
    /groups 为空/,
  );
});

test('builds Step02 fallback without inventing an overall duration when the source has none', () => {
  const source = '# 项目概述\n- 项目名称：测试项目\n- 现场验证：中标后三个工作日内完成。';
  const result = buildGlobalFactsFromAnalysisContext({ projectOverview: source });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].content, source);
  assert.match(result.warnings.join('\n'), /未补造期限值/);
});

test('detects only explicit overall duration labels', () => {
  const sourceRequiresDurationFact = (globalFactsHelpers as Record<string, unknown>).sourceRequiresDurationFact;
  assert.equal(typeof sourceRequiresDurationFact, 'function');
  const detect = sourceRequiresDurationFact as (source: unknown) => boolean;
  assert.equal(detect('服务期限：二年'), true);
  assert.equal(detect('项目工期：合同签订后 30 日历天'), true);
  assert.equal(detect('资产及业务梳理一年内按需提供'), false);
  assert.equal(detect('中标之后三个工作日内到现场验证'), false);
});
