import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getInitialPasswordRuleState,
  validateInitialPassword,
} from './initialPassword';

test('12 位且包含四类字符的密码通过', () => {
  assert.deepEqual(validateInitialPassword('Strong-Pass1!'), []);
});

test('逐项拒绝长度和字符类型不满足的密码', () => {
  assert.equal(getInitialPasswordRuleState('Aa1!short').minLength, false);
  assert.match(validateInitialPassword('lowercase1!-').join('；'), /大写字母/);
  assert.match(validateInitialPassword('UPPERCASE1!-').join('；'), /小写字母/);
  assert.match(validateInitialPassword('NoNumber----').join('；'), /数字/);
  assert.match(validateInitialPassword('NoSpecial123').join('；'), /特殊字符/);
});

test('拒绝默认密码', () => {
  assert.match(validateInitialPassword('admin').join('；'), /默认密码/);
});
