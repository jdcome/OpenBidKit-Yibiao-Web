import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBidSections } from './bidSectionDetector';

test('不把章节号 1.4 分包划分误判为 4 个分包', () => {
  const markdown = `
# 比选文件

目 录

1.3采购范围 13

1.4分包划分 13

1.5比选方式 13

**1.项目概况与采购内容**

1.2采购内容及分包划分情况：

1.2.5本项目不划分标包，选取一名中选人。

<table><tbody><tr><td><p>1.4</p></td><td><p>标包划分</p></td><td><p>☑不划分标包</p><p>□划分标包 分包划分情况详见第一章“比选公告”</p></td></tr></tbody></table>

1.4分包划分

本项目分包划分情况见参选人须知前附表。
`;

  assert.deepEqual(detectBidSections(markdown), {
    hasMultiple: false,
    totalDeclared: 1,
  });
});

test('仍能识别明确声明的多包项目', () => {
  const markdown = '本项目共划分为 3 个包，供应商可选择其中一个包响应。';

  assert.deepEqual(detectBidSections(markdown), {
    hasMultiple: true,
    totalDeclared: 3,
  });
});
