import assert from 'node:assert/strict';
import test from 'node:test';

import { getAppMenuItems } from './menuConfig';

function flattenMenuItems() {
  return getAppMenuItems(false).flatMap((item) => [item, ...(item.children ?? [])]);
}

test('资源下载模块不再出现在主菜单或子菜单中', () => {
  const ids = flattenMenuItems().map((item) => item.id) as string[];
  assert.equal(ids.includes('resources'), false);
});

test('商务标入口改为投标计算器并保留原开发中提示', () => {
  const businessBid = flattenMenuItems().find((item) => item.id === 'business-bid');

  assert.ok(businessBid);
  assert.equal(businessBid.label, '投标计算器');
  assert.equal(businessBid.description, '综合报价、技术、商务评分标准计算标书最终得分');
  assert.equal(businessBid.notice?.message, '正在开发中，敬请期待。');
});
