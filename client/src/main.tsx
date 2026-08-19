import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './shared/api/auth';
import { installWebBridge } from './shared/api/bridge';
import LoginPage from './app/LoginPage';
import App from './App';
import AppProviders from './app/providers/AppProviders';
import WorkspaceDatabaseGate from './app/WorkspaceDatabaseGate';
import './styles.css';

// Web 版入口：登录守卫 + 真 App。先装 Web 桥接 shim（复刻 window.yibiao 形状，底层走 shared/api + SSE），
// 登录后挂真实 App（AppProviders > WorkspaceDatabaseGate > App），与桌面 Electron 入口同构。
// 桌面专属能力（update / GPU / license / agent）由 bridge 的 no-op stub 降级（见 bridge.ts）。
installWebBridge();

const queryClient = new QueryClient();

function Root() {
  const { user } = useAuth();
  if (!user) return <LoginPage />;
  return (
    <AppProviders>
      <WorkspaceDatabaseGate>
        <App />
      </WorkspaceDatabaseGate>
    </AppProviders>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
