import assert from 'node:assert/strict';
import test from 'node:test';

import { ASSIGNABLE_MODULE_IDS, parseModules } from './permissions';

test('资源下载不再是可授予模块', () => {
  assert.equal((ASSIGNABLE_MODULE_IDS as readonly string[]).includes('resources'), false);
});

test('历史 modules 中的 resources 会被权限解析过滤', () => {
  assert.deepEqual(parseModules('["resources","docs","resources"]'), ['docs']);
});
