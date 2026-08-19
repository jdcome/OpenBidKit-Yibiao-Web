// 登录/注册页：双标签切换登录与注册。视觉沿用应用设计令牌与面板/输入/按钮词汇，
// 与仪表盘、用户管理等特性保持同一浅色主题。注册成功后账号 status=pending，需管理员审批。
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth, register } from '../shared/api/auth';
import { useSystemSettings } from '../shared/api/system-settings';
import OpenSourceNotice from '../components/OpenSourceNotice';
import InitialPasswordChangeDialog from './InitialPasswordChangeDialog';
import logoUrl from '../../assets/icon_256.png';

const PHONE_RE = /^1[3-9]\d{9}$/;

export default function LoginPage() {
  const {
    login,
    initialPasswordChange,
    changeInitialPassword,
    clearInitialPasswordChange,
  } = useAuth();
  const { data: systemSettings } = useSystemSettings();
  const systemName = systemSettings?.systemName || '金盾标书编制系统';
  const logoSrc = systemSettings?.logoDataUrl || logoUrl;

  // 浏览器标签标题跟随系统名（DB 可配）。登录态在 AppTopbar 同步。
  useEffect(() => {
    document.title = systemName;
  }, [systemName]);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const initialPasswordExpiryRef = useRef<number | null>(null);

  const returnInitialPasswordChangeToLogin = useCallback((message: string) => {
    initialPasswordExpiryRef.current = null;
    clearInitialPasswordChange();
    setMode('login');
    setPassword('');
    setConfirm('');
    setInfo('');
    setError(message);
  }, [clearInitialPasswordChange]);

  const onInitialPasswordExpired = useCallback(() => {
    returnInitialPasswordChangeToLogin('改密凭证已过期，请重新登录');
  }, [returnInitialPasswordChangeToLogin]);

  useEffect(() => {
    if (initialPasswordChange) {
      initialPasswordExpiryRef.current = initialPasswordChange.expiresAt;
      return;
    }
    const previousExpiry = initialPasswordExpiryRef.current;
    if (previousExpiry !== null && Date.now() >= previousExpiry) {
      onInitialPasswordExpired();
    }
  }, [initialPasswordChange, onInitialPasswordExpired]);

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError('');
    setInfo('');
  };

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    // 登录态接受手机号或管理员账号（如 admin），仅做非空校验；手机号格式校验只在注册态。
    if (!phone.trim()) {
      setError('请输入账号');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await login(phone, password);
      if (result === 'password-change-required') {
        setPassword('');
      }
    } catch (err) {
      const ex = err as { response?: { data?: { error?: string } } };
      setError(ex.response?.data?.error || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const onRegister = async (e: FormEvent) => {
    e.preventDefault();
    if (!PHONE_RE.test(phone)) {
      setError('请输入有效的 11 位手机号');
      return;
    }
    if (!name.trim()) {
      setError('请输入姓名');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setError('两次密码不一致');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const msg = await register(phone, password, name.trim(), dept.trim());
      setConfirm('');
      setPassword('');
      setName('');
      setDept('');
      setError('');
      setMode('login');
      setInfo(msg || '注册成功，请等待管理员审批后登录');
    } catch (err) {
      const ex = err as { response?: { data?: { error?: string } } };
      setError(ex.response?.data?.error || '注册失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={mode === 'login' ? onLogin : onRegister}>
        <div className="login-brand">
          <img src={logoSrc} alt="" />
          <span className="section-kicker">欢迎使用</span>
          <h2>{systemName}</h2>
          <p>{mode === 'login' ? '登录以进入工作台' : '注册账号，提交后等待管理员审批'}</p>
        </div>

        <div className="login-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={`login-tab${mode === 'login' ? ' is-active' : ''}`}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={`login-tab${mode === 'register' ? ' is-active' : ''}`}
            onClick={() => switchMode('register')}
          >
            注册
          </button>
        </div>

        <label className="login-field">
          <span>{mode === 'login' ? '账号' : '手机号'}</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={mode === 'login' ? '手机号 / admin' : '请输入 11 位手机号'}
            maxLength={mode === 'login' ? undefined : 11}
            autoComplete={mode === 'login' ? 'username' : 'tel'}
          />
        </label>

        {mode === 'register' && (
          <>
            <label className="login-field">
              <span>姓名</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="请输入姓名"
                autoComplete="name"
              />
            </label>
            <label className="login-field">
              <span>部门</span>
              <input
                value={dept}
                onChange={(e) => setDept(e.target.value)}
                placeholder="选填，如 投标部"
                autoComplete="organization"
              />
            </label>
          </>
        )}

        <label className="login-field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? '至少 8 位' : '请输入密码'}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>

        {mode === 'register' && (
          <label className="login-field">
            <span>确认密码</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入密码"
              autoComplete="new-password"
            />
          </label>
        )}

        {error && <p className="login-message is-error">{error}</p>}
        {info && <p className="login-message is-success">{info}</p>}

        <button type="submit" className="primary-action login-submit" disabled={busy}>
          {busy ? (mode === 'login' ? '登录中…' : '提交中…') : mode === 'login' ? '登录' : '注册'}
        </button>

        <OpenSourceNotice variant="login" />
      </form>

      <InitialPasswordChangeDialog
        key={initialPasswordChange?.expiresAt ?? 'closed'}
        open={initialPasswordChange !== null}
        expiresAt={initialPasswordChange?.expiresAt ?? null}
        onSubmit={changeInitialPassword}
        onExpired={onInitialPasswordExpired}
        onTerminalError={returnInitialPasswordChangeToLogin}
      />
    </div>
  );
}
