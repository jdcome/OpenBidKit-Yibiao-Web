import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error 生产转换器是 ESM JavaScript，仓库当前未为 convert.mjs 提供声明文件。
const converter = await import('./doc2markdown/convert.mjs') as Record<string, unknown>;

function stitch(pages: string[][][][]): string[][][][] {
  assert.equal(typeof converter.stitchCrossPagePdfTables, 'function');
  return (converter.stitchCrossPagePdfTables as (value: string[][][][]) => string[][][][])(pages);
}

test('合并上一页孤立表头与下一页从序号1开始的续表', () => {
  const result = stitch([
    [[['序号', '系统名称', '系统等级']]],
    [[
      ['1', '互联网医院', '三级'],
      ['2', '医院管理信息（HIS）系统', '三级'],
      ['3', '实验室信息管理（LIS）系统', '三级'],
    ]],
  ]);

  assert.deepEqual(result[0][0], [
    ['序号', '系统名称', '系统等级'],
    ['1', '互联网医院', '三级'],
    ['2', '医院管理信息（HIS）系统', '三级'],
    ['3', '实验室信息管理（LIS）系统', '三级'],
  ]);
  assert.equal(result[1].length, 0);
});

test('合并已有数据行且序号连续的跨页续表', () => {
  const result = stitch([
    [[
      ['序号', '系统名称', '系统等级'],
      ['1', '互联网医院', '三级'],
    ]],
    [[['2', 'HIS系统', '三级']]],
  ]);

  assert.deepEqual(result[0][0].at(-1), ['2', 'HIS系统', '三级']);
  assert.equal(result[1].length, 0);
});

test('序号不连续时不合并相邻页面表格', () => {
  const pages = [
    [[
      ['序号', '系统名称', '系统等级'],
      ['1', '互联网医院', '三级'],
    ]],
    [[['7', '另一张表', '三级']]],
  ];

  assert.deepEqual(stitch(pages), pages);
});

test('没有语义表头时不合并同列数独立表格', () => {
  const pages = [
    [[['甲', '乙', '丙']]],
    [[['1', '互联网医院', '三级']]],
  ];

  assert.deepEqual(stitch(pages), pages);
});
