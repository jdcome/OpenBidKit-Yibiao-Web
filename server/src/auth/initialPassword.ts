export const DEFAULT_INITIAL_ADMIN_USERNAME = 'admin';
export const DEFAULT_INITIAL_ADMIN_PASSWORD = 'admin';
export const INITIAL_PASSWORD_MIN_LENGTH = 12;

export interface InitialPasswordRuleState {
  minLength: boolean;
  uppercase: boolean;
  lowercase: boolean;
  number: boolean;
  special: boolean;
  notDefault: boolean;
}

export function getInitialPasswordRuleState(password: string): InitialPasswordRuleState {
  return {
    minLength: password.length >= INITIAL_PASSWORD_MIN_LENGTH,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
    notDefault: password !== DEFAULT_INITIAL_ADMIN_PASSWORD,
  };
}

export function validateInitialPassword(password: string): string[] {
  const state = getInitialPasswordRuleState(password);
  const errors: string[] = [];
  if (!state.minLength) errors.push('新密码至少 12 位');
  if (!state.uppercase) errors.push('新密码必须包含大写字母');
  if (!state.lowercase) errors.push('新密码必须包含小写字母');
  if (!state.number) errors.push('新密码必须包含数字');
  if (!state.special) errors.push('新密码必须包含特殊字符');
  if (!state.notDefault) errors.push('新密码不能使用默认密码');
  return errors;
}
