import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from './normalize';

test('初次部署默认系统名称为易标投标工具箱web版', () => {
  assert.equal(defaultConfig.system_name, '易标投标工具箱web版');
});
