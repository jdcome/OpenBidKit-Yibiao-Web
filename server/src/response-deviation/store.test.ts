import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileGeneratedRows } from './store';
import type { ExtractedRequirementRow } from './types';

function generated(overrides: Partial<ExtractedRequirementRow> = {}): ExtractedRequirementRow {
  return {
    clauseNo: '1.',
    requirementTitle: '服务范围',
    requirementMarkdown: '1. 服务范围',
    requirementPlainText: '1. 服务范围',
    sourceBlockIds: ['tb-1'],
    aggregation: 'numbered-clause',
    sourceFingerprint: 'fp-1',
    confidence: 'high',
    ...overrides,
  };
}

test('重新识别时按条目号和原文指纹保留人工响应字段', () => {
  const result = reconcileGeneratedRows([
    {
      id: 'old-row',
      clauseNo: '1.',
      sourceFingerprint: 'fp-1',
      responseText: '完全响应',
      deviationStatus: '无偏离',
      deviationExplanation: '无',
      notes: '已复核',
      manualEdited: true,
    },
  ], [generated()]);

  assert.equal(result.rows[0].responseText, '完全响应');
  assert.equal(result.rows[0].deviationStatus, '无偏离');
  assert.equal(result.rows[0].manualEdited, true);
  assert.equal(result.orphanedManualRows.length, 0);
});

test('无法匹配的人工填写行进入变更复核而不是静默丢弃', () => {
  const result = reconcileGeneratedRows([
    {
      id: 'old-row',
      clauseNo: '旧1.',
      sourceFingerprint: 'old-fp',
      responseText: '人工填写内容',
      deviationStatus: '部分偏离',
      deviationExplanation: '需说明',
      notes: '',
      manualEdited: true,
    },
  ], [generated()]);

  assert.equal(result.rows[0].responseText, '');
  assert.equal(result.orphanedManualRows.length, 1);
  assert.equal(result.orphanedManualRows[0].responseText, '人工填写内容');
});

test('没有人工编辑的旧行无需进入变更复核', () => {
  const result = reconcileGeneratedRows([
    {
      id: 'old-row',
      clauseNo: '旧1.',
      sourceFingerprint: 'old-fp',
      responseText: '',
      deviationStatus: '',
      deviationExplanation: '',
      notes: '',
      manualEdited: false,
    },
  ], [generated()]);

  assert.equal(result.orphanedManualRows.length, 0);
});
