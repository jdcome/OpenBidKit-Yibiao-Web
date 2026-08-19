import assert from 'node:assert/strict';
import test from 'node:test';
import { getInitialPasswordRuleState, isPasswordChangeRequiredResponse } from './initialPasswordRules';

test('前端密码规则与服务端四类规则一致', () => {
  assert.deepEqual(getInitialPasswordRuleState('Strong-Pass1!'), {
    minLength: true,
    uppercase: true,
    lowercase: true,
    number: true,
    special: true,
  });
});

test('只接受完整的强制改密响应', () => {
  assert.equal(isPasswordChangeRequiredResponse({
    password_change_required: true,
    password_change_token: 'token',
    expires_in: 600,
  }), true);
  assert.equal(isPasswordChangeRequiredResponse({ password_change_required: true }), false);
});
