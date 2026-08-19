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

export interface AuthenticatedUserResponse {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
}

export interface AuthenticatedResponse {
  token: string;
  user: AuthenticatedUserResponse;
}

export interface ExpiringInitialPasswordChangeSession {
  expiresAt: number;
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

export function canSubmitInitialPasswordChange(password: string, confirmation: string): boolean {
  const state = getInitialPasswordRuleState(password);
  return Object.values(state).every(Boolean) && password === confirmation;
}

export function preventInitialPasswordDialogDismiss(event: { preventDefault(): void }): void {
  event.preventDefault();
}

export function shouldResetInitialPasswordDialogState(
  open: boolean,
  previousExpiresAt: number | null,
  expiresAt: number | null,
): boolean {
  return !open || previousExpiresAt !== expiresAt;
}

export function getInitialPasswordRuleStatusText(satisfied: boolean): '已满足' | '未满足' {
  return satisfied ? '已满足' : '未满足';
}

export function isPasswordChangeRequiredResponse(value: unknown): value is PasswordChangeRequiredResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return response.password_change_required === true
    && typeof response.password_change_token === 'string'
    && response.password_change_token.length > 0
    && response.expires_in === 600;
}

export function isAuthenticatedResponse(value: unknown): value is AuthenticatedResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  const user = response.user;
  if (!user || typeof user !== 'object') return false;
  const authUser = user as Record<string, unknown>;
  return typeof response.token === 'string'
    && response.token.length > 0
    && typeof authUser.id === 'number'
    && Number.isInteger(authUser.id)
    && authUser.id > 0
    && typeof authUser.username === 'string'
    && authUser.username.length > 0
    && (authUser.displayName === null || typeof authUser.displayName === 'string')
    && typeof authUser.role === 'string'
    && authUser.role.length > 0;
}

export function isActiveInitialPasswordChangeSession<T extends ExpiringInitialPasswordChangeSession>(
  expected: T,
  current: T | null,
  now = Date.now(),
): boolean {
  return current === expected && now < expected.expiresAt;
}
