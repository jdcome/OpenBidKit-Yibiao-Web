export interface InitialPasswordRuleState {
  minLength: boolean;
  uppercase: boolean;
  lowercase: boolean;
  number: boolean;
  special: boolean;
}

export interface PasswordChangeRequiredResponse {
  password_change_required: true;
  password_change_token: string;
  expires_in: number;
}

export function getInitialPasswordRuleState(password: string): InitialPasswordRuleState {
  return {
    minLength: password.length >= 12,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
}

export function isPasswordChangeRequiredResponse(value: unknown): value is PasswordChangeRequiredResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return response.password_change_required === true
    && typeof response.password_change_token === 'string'
    && response.password_change_token.length > 0
    && typeof response.expires_in === 'number'
    && Number.isFinite(response.expires_in)
    && response.expires_in > 0;
}
