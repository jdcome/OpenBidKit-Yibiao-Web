import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSubmitInitialPasswordChange,
  getInitialPasswordRuleState,
  getInitialPasswordRuleStatusText,
  isActiveInitialPasswordChangeSession,
  isAuthenticatedResponse,
  isPasswordChangeRequiredResponse,
  preventInitialPasswordDialogDismiss,
  shouldResetInitialPasswordDialogState,
} from './initialPasswordRules';

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
  assert.equal(isPasswordChangeRequiredResponse({
    password_change_required: true,
    password_change_token: 'token',
    expires_in: 1,
  }), false);
  assert.equal(isPasswordChangeRequiredResponse({
    password_change_required: true,
    password_change_token: 'token',
    expires_in: 601,
  }), false);
  assert.equal(isPasswordChangeRequiredResponse({
    password_change_required: true,
    password_change_token: 'token',
    expires_in: 600.5,
  }), false);
});

test('只接受具备完整用户身份字段的正式登录响应', () => {
  assert.equal(isAuthenticatedResponse({
    token: 'access-token',
    user: {
      id: 1,
      username: 'admin',
      displayName: null,
      role: 'admin',
    },
  }), true);
  assert.equal(isAuthenticatedResponse({ token: 'access-token', user: {} }), false);
  assert.equal(isAuthenticatedResponse({
    token: 'access-token',
    user: { id: '1', username: 'admin', displayName: null, role: 'admin' },
  }), false);
  assert.equal(isAuthenticatedResponse({
    token: 'access-token',
    user: { id: 1, username: 'admin', displayName: 1, role: 'admin' },
  }), false);
});

test('仅当前且未过期的受限会话可以完成改密', () => {
  const session = { expiresAt: 1_000 };
  assert.equal(isActiveInitialPasswordChangeSession(session, session, 999), true);
  assert.equal(isActiveInitialPasswordChangeSession(session, { expiresAt: 1_000 }, 999), false);
  assert.equal(isActiveInitialPasswordChangeSession(session, session, 1_000), false);
});

test('只有全部规则通过且两次密码一致时允许提交', () => {
  assert.equal(canSubmitInitialPasswordChange('Strong-Pass1!', 'Strong-Pass1!'), true);
  assert.equal(canSubmitInitialPasswordChange('weak-password', 'weak-password'), false);
  assert.equal(canSubmitInitialPasswordChange('Strong-Pass1!', 'Strong-Pass2!'), false);
});

test('强制改密关闭事件始终被阻止', () => {
  let prevented = false;
  preventInitialPasswordDialogDismiss({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('关闭或切换强制改密会话时必须清理敏感状态', () => {
  assert.equal(shouldResetInitialPasswordDialogState(false, 1_000, 1_000), true);
  assert.equal(shouldResetInitialPasswordDialogState(true, 1_000, 2_000), true);
  assert.equal(shouldResetInitialPasswordDialogState(true, 1_000, 1_000), false);
});

test('密码规则状态提供明确的可访问公告文本', () => {
  assert.equal(getInitialPasswordRuleStatusText(true), '已满足');
  assert.equal(getInitialPasswordRuleStatusText(false), '未满足');
});
