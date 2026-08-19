import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTenderBlocks } from './structure';

test('解析 Markdown 标题、普通段落和原始 HTML 表格并保留原文', () => {
  const markdown = [
    '# 招标文件',
    '',
    '## 第三章 采购需求',
    '',
    '项目背景说明。',
    '',
    '<table><thead><tr><th>序号</th><th>系统名称</th></tr></thead>',
    '<tbody><tr><td>1</td><td>系统A</td></tr></tbody></table>',
  ].join('\n');

  const blocks = parseTenderBlocks(markdown);
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'heading', 'paragraph', 'html-table']);
  assert.deepEqual(blocks[2].headingPath, ['招标文件', '第三章 采购需求']);
  assert.match(blocks[3].raw, /<table>/);
  assert.match(blocks[3].raw, /系统A/);
  assert.ok(blocks.every((block) => block.id && block.end > block.start));
});

test('带编号的独立行保留条目号', () => {
  const blocks = parseTenderBlocks('## 采购需求\n\n（1）服务范围及内容\n\n2. 服务期限');
  assert.equal(blocks[1].clauseNo, '（1）');
  assert.equal(blocks[2].clauseNo, '2.');
});

test('正文开头年份不误判为条款编号', () => {
  const blocks = parseTenderBlocks('2016年网络安全法正式实施。\n\n1. 服务范围');
  assert.equal(blocks[0].clauseNo, '');
  assert.equal(blocks[1].clauseNo, '1.');
});
