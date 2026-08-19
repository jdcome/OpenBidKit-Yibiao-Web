import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelectedSectionMarkdown } from './selectedSectionMarkdown';

test('buildSelectedSectionMarkdown keeps only selected package ranges', () => {
  const markdown = [
    '# 招标文件',
    '包1：',
    '包1评分表',
    '包2评分表',
    '第四章 采购需求',
    '包1：',
    '包1项目背景',
    '包1服务要求',
    '包2：',
    '包2项目背景',
    '包2服务要求',
  ].join('\n');

  const result = buildSelectedSectionMarkdown(markdown, {
    id: 'section-1',
    title: '包1',
    includeRanges: [
      { startLine: 2, endLine: 3, reason: '包1评分因素和标准' },
      { startLine: 6, endLine: 8, reason: '包1采购需求' },
    ],
  });

  assert.match(result, /包1评分表/);
  assert.match(result, /包1服务要求/);
  assert.doesNotMatch(result, /包2评分表/);
  assert.doesNotMatch(result, /包2项目背景/);
  assert.doesNotMatch(result, /包2服务要求/);
});
