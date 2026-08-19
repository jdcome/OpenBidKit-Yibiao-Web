import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, type FormEvent } from 'react';
import {
  canSubmitInitialPasswordChange,
  getInitialPasswordRuleState,
  preventInitialPasswordDialogDismiss,
} from '../shared/auth/initialPasswordRules';

interface InitialPasswordChangeDialogProps {
  open: boolean;
  expiresAt: number | null;
  onSubmit(newPassword: string, confirmPassword: string): Promise<void>;
  onExpired(): void;
}

const RULE_LABELS = [
  ['minLength', '至少 12 位'],
  ['uppercase', '包含大写字母'],
  ['lowercase', '包含小写字母'],
  ['number', '包含数字'],
  ['special', '包含特殊字符'],
] as const;

function InitialPasswordChangeDialog({ open, expiresAt, onSubmit, onExpired }: InitialPasswordChangeDialogProps) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ruleState = getInitialPasswordRuleState(newPassword);
  const confirmationMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit = canSubmitInitialPasswordChange(newPassword, confirmPassword) && !busy;

  useEffect(() => {
    if (!open) return;
    setNewPassword('');
    setConfirmPassword('');
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setBusy(false);
    setError('');
  }, [open]);

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
      if (response?.status === 401) {
        onExpired();
        return;
      }
      const serverMessage = response?.data?.error;
      const localMessage = submitError instanceof Error ? submitError.message : '';
      setError(
        typeof serverMessage === 'string' && serverMessage.trim()
          ? serverMessage
          : /[\u3400-\u9fff]/.test(localMessage)
            ? localMessage
            : '密码修改失败，请稍后重试',
      );
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
              <label className="login-field">
                <span>新密码</span>
                <span className="initial-password-input-wrap">
                  <input
                    autoFocus
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder="请输入新密码"
                    autoComplete="new-password"
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
              </label>

              <label className="login-field">
                <span>确认新密码</span>
                <span className="initial-password-input-wrap">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="请再次输入新密码"
                    autoComplete="new-password"
                    aria-invalid={confirmationMismatch}
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
              </label>
            </div>

            <ul className="initial-password-rule-list" aria-label="新密码要求">
              {RULE_LABELS.map(([rule, label]) => (
                <li key={rule} className={ruleState[rule] ? 'is-valid' : 'is-invalid'}>
                  <span aria-hidden="true">{ruleState[rule] ? '✓' : '○'}</span>
                  {label}
                </li>
              ))}
            </ul>

            {confirmationMismatch && (
              <p className="login-message is-error">两次输入的密码不一致</p>
            )}
            {error && <p className="login-message is-error">{error}</p>}

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
