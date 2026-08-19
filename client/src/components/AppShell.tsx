import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../shared/api/auth';
import type { SectionId } from '../shared/types/navigation';
import AppTopbar from './AppTopbar';
import OpenSourceNotice from './OpenSourceNotice';
import Sidebar from './Sidebar';

interface AppShellProps {
  activeSection: SectionId;
  children: ReactNode;
  developerMode: boolean;
  onSectionChange: (section: SectionId) => void;
}

function AppShell({ activeSection, children, developerMode, onSectionChange }: AppShellProps) {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const { user, refreshUser } = useAuth();

  // 权限即时生效：窗口聚焦 + 可见性恢复 + 60s 定时拉 /me 刷新本地用户快照。
  // 仅登录后挂载；静默刷新，失败只在 401/403 时由 refreshUser 内部 logout。
  useEffect(() => {
    if (!user) return;
    const trigger = () => {
      if (document.visibilityState === 'visible') void refreshUser();
    };
    document.addEventListener('visibilitychange', trigger);
    window.addEventListener('focus', trigger);
    const timer = window.setInterval(() => void refreshUser(), 60_000);
    return () => {
      document.removeEventListener('visibilitychange', trigger);
      window.removeEventListener('focus', trigger);
      window.clearInterval(timer);
    };
  }, [user, refreshUser]);

  return (
    <Tooltip.Provider delayDuration={120} skipDelayDuration={80}>
      <div className={`app-shell${isMac ? ' is-mac' : ''}`}>
        <Sidebar activeSection={activeSection} developerMode={developerMode} onSectionChange={onSectionChange} />

        <main className="main-area">
          <AppTopbar />
          <section className="content-shell" aria-label="主内容">
            {children}
          </section>
        </main>
        <OpenSourceNotice />
      </div>
    </Tooltip.Provider>
  );
}

export default AppShell;
