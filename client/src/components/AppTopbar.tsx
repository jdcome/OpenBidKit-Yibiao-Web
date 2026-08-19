// 应用顶栏：右上角展示当前用户身份 + 退出按钮。退出走 useAuth().logout（纯客户端，
// main.tsx 的 !user 守卫会自动落回登录页）。顶栏挂在 main-area 顶部，与 sidebar 收起无关。
// 退出前弹 token 风格二次确认框，避免误触。
import { useEffect, useState } from 'react';
import { useAuth } from '../shared/api/auth';
import { useSystemSettings } from '../shared/api/system-settings';
import ConfirmDialog from './ConfirmDialog';
import logoUrl from '../../assets/icon_256.png';

const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '普通用户' };

function AppTopbar() {
  const { user, logout } = useAuth();
  const { data: systemSettings } = useSystemSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const systemName = systemSettings?.systemName || '金盾标书编制系统';
  const logoSrc = systemSettings?.logoDataUrl || logoUrl;

  // 浏览器标签标题跟随系统名（DB 可配）。未登录态在 LoginPage 同步。
  useEffect(() => {
    document.title = systemName;
  }, [systemName]);

  if (!user) return null;

  const name = user.displayName || user.username;
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const roleLabel = ROLE_LABEL[user.role] ?? user.role;

  return (
    <header className="app-topbar">
      <div className="app-topbar-brand">
        <img src={logoSrc} alt="" />
        <strong>{systemName}</strong>
      </div>
      <div className="topbar-user">
        <span className="topbar-avatar" aria-hidden="true">{initial}</span>
        <span className="topbar-user-meta">
          <strong>{name}</strong>
          <small>{roleLabel}</small>
        </span>
        <button type="button" className="topbar-logout" onClick={() => setConfirmOpen(true)} aria-label="退出登录">
          <LogoutIcon />
          <span>退出</span>
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="确认退出登录？"
        description="退出后需要重新登录才能继续使用。"
        confirmText="退出"
        cancelText="取消"
        onConfirm={() => { logout(); setConfirmOpen(false); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </header>
  );
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 17l5-5-5-5" />
      <path d="M20 12H9" />
      <path d="M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

export default AppTopbar;
