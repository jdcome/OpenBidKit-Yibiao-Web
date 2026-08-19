// 应用顶栏：右上角展示当前用户身份 + 退出按钮。退出走 useAuth().logout（纯客户端，
// main.tsx 的 !user 守卫会自动落回登录页）。顶栏挂在 main-area 顶部，与 sidebar 收起无关。
// 退出前弹 token 风格二次确认框，避免误触。
import { useEffect, useState } from 'react';
import { useAuth } from '../shared/api/auth';
import { useSystemSettings } from '../shared/api/system-settings';
import { useTheme } from '../shared/theme/ThemeProvider';
import ConfirmDialog from './ConfirmDialog';
import logoUrl from '../../assets/icon_256.png';

const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '普通用户' };

interface AppTopbarProps {
  showThemeToggle?: boolean;
}

function AppTopbar({ showThemeToggle = false }: AppTopbarProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { data: systemSettings } = useSystemSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const systemName = systemSettings?.systemName || '易标投标工具箱web版';
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
        {showThemeToggle && (
          <button
            type="button"
            className="topbar-theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'soc-dark' ? '切换到浅色主题' : '切换到 SOC 深色主题'}
            aria-pressed={theme === 'soc-dark'}
            title={theme === 'soc-dark' ? '切换到浅色主题' : '切换到 SOC 深色主题'}
          >
            <ThemeIcon dark={theme === 'soc-dark'} />
            <span>{theme === 'soc-dark' ? '深色模式' : '浅色模式'}</span>
          </button>
        )}
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

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.2 14.1A8.2 8.2 0 0 1 9.9 3.8 8.2 8.2 0 1 0 20.2 14.1Z" />
      <path d="M16.8 4.8h.01M19.4 8h.01" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4" />
    </svg>
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
