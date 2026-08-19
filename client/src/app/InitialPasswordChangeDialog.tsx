import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  canSubmitInitialPasswordChange,
  classifyInitialPasswordChangeFailure,
  getInitialPasswordRuleState,
  getInitialPasswordRuleStatusText,
  preventInitialPasswordDialogDismiss,
  shouldResetInitialPasswordDialogState,
} from '../shared/auth/initialPasswordRules';

interface InitialPasswordChangeDialogProps {
  open: boolean;
  expiresAt: number | null;
  onSubmit(newPassword: string, confirmPassword: string): Promise<void>;
  onExpired(): void;
  onTerminalError(message: string): void;
}

const RULE_LABELS = [
  ['minLength', '至少 12 位'],
  ['uppercase', '包含大写字母'],
  ['lowercase', '包含小写字母'],
  ['number', '包含数字'],
  ['special', '包含特殊字符'],
] as const;

function InitialPasswordChangeDialog({
  open,
  expiresAt,
  onSubmit,
  onExpired,
  onTerminalError,
}: InitialPasswordChangeDialogProps) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previousExpiresAtRef = useRef<number | null>(null);
  const newPasswordId = useId();
  const confirmPasswordId = useId();
  const ruleListId = useId();
  const mismatchId = useId();
  const serverErrorId = useId();

  const ruleState = getInitialPasswordRuleState(newPassword);
  const rulesSatisfied = Object.values(ruleState).every(Boolean);
  const confirmationMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit = canSubmitInitialPasswordChange(newPassword, confirmPassword) && !busy;
  const newPasswordDescribedBy = [ruleListId, error ? serverErrorId : null].filter(Boolean).join(' ');
  const confirmPasswordDescribedBy = [
    ruleListId,
    confirmationMismatch ? mismatchId : null,
    error ? serverErrorId : null,
  ].filter(Boolean).join(' ');

  useLayoutEffect(() => {
    const previousExpiresAt = previousExpiresAtRef.current;
    previousExpiresAtRef.current = expiresAt;
    if (!shouldResetInitialPasswordDialogState(open, previousExpiresAt, expiresAt)) return;
    setNewPassword('');
    setConfirmPassword('');
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setBusy(false);
    setError('');
  }, [expiresAt, open]);

  useEffect(() => {
    if (!open || expiresAt === null) return undefined;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      onExpired();
      return undefined;
    }
    const timer = window.setTimeout(onExpired, remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt, onExpired, open]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(newPassword, confirmPassword);
    } catch (submitError) {
      const response = (submitError as { response?: { status?: number; data?: { error?: unknown } } })?.response;
      const failure = classifyInitialPasswordChangeFailure(
        response?.status,
        response?.data?.error,
        submitError instanceof Error ? submitError.message : '',
      );
      if (failure.terminal) {
        onTerminalError(failure.message);
        return;
      }
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="initial-password-dialog-overlay" />
        <Dialog.Content
          className="initial-password-dialog-content"
          onEscapeKeyDown={preventInitialPasswordDialogDismiss}
          onPointerDownOutside={preventInitialPasswordDialogDismiss}
        >
          <form className="initial-password-dialog-card" onSubmit={(event) => void handleSubmit(event)}>
            <div className="initial-password-dialog-heading">
              <span className="section-kicker">安全初始化</span>
              <Dialog.Title>首次登录必须修改密码</Dialog.Title>
              <Dialog.Description>
                默认凭据仅用于验证身份，不能进入系统。请设置符合安全要求的新密码后继续。
              </Dialog.Description>
            </div>

            <div className="initial-password-dialog-fields">
              <div className="login-field">
                <label htmlFor={newPasswordId}>新密码</label>
                <span className="initial-password-input-wrap">
                  <input
                    id={newPasswordId}
                    autoFocus
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder="请输入新密码"
                    autoComplete="new-password"
                    aria-describedby={newPasswordDescribedBy}
                    aria-invalid={(newPassword.length > 0 && !rulesSatisfied) || Boolean(error)}
                  />
                  <button
                    type="button"
                    className="initial-password-visibility"
                    onClick={() => setShowNewPassword((visible) => !visible)}
                    aria-label={showNewPassword ? '隐藏新密码' : '显示新密码'}
                    aria-pressed={showNewPassword}
                  >
                    {showNewPassword ? '隐藏' : '显示'}
                  </button>
                </span>
              </div>

              <div className="login-field">
                <label htmlFor={confirmPasswordId}>确认新密码</label>
                <span className="initial-password-input-wrap">
                  <input
                    id={confirmPasswordId}
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="请再次输入新密码"
                    autoComplete="new-password"
                    aria-describedby={confirmPasswordDescribedBy}
                    aria-invalid={confirmationMismatch || Boolean(error)}
                  />
                  <button
                    type="button"
                    className="initial-password-visibility"
                    onClick={() => setShowConfirmPassword((visible) => !visible)}
                    aria-label={showConfirmPassword ? '隐藏确认密码' : '显示确认密码'}
                    aria-pressed={showConfirmPassword}
                  >
                    {showConfirmPassword ? '隐藏' : '显示'}
                  </button>
                </span>
              </div>
            </div>

            <ul
              id={ruleListId}
              className="initial-password-rule-list"
              aria-label="新密码要求"
              aria-live="polite"
            >
              {RULE_LABELS.map(([rule, label]) => (
                <li key={rule} className={ruleState[rule] ? 'is-valid' : 'is-invalid'}>
                  <span className="initial-password-rule-status">
                    {getInitialPasswordRuleStatusText(ruleState[rule])}：
                  </span>
                  <span>{label}</span>
                </li>
              ))}
            </ul>

            {(confirmationMismatch || error) && (
              <div className="initial-password-validation-summary" role="alert" aria-atomic="true">
                {confirmationMismatch && (
                  <p id={mismatchId} className="login-message is-error">两次输入的密码不一致</p>
                )}
                {error && <p id={serverErrorId} className="login-message is-error">{error}</p>}
              </div>
            )}

            <button type="submit" className="primary-action initial-password-submit" disabled={!canSubmit}>
              {busy ? '修改中…' : '修改密码并进入系统'}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default InitialPasswordChangeDialog;
