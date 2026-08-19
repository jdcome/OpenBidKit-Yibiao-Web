import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { http, publicHttp, TOKEN_KEY, USER_KEY } from './http';
import { sseManager } from './sse';
import {
  isActiveInitialPasswordChangeSession,
  isAuthenticatedResponse,
  isPasswordChangeRequiredResponse,
} from '../auth/initialPasswordRules';

export interface YibiaoUser {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
  status?: string;
  phone?: string | null;
  department?: string | null;
  modules?: string[];
}

export interface InitialPasswordChangeState {
  expiresAt: number;
}

export type LoginResult = 'authenticated' | 'password-change-required';

export interface AuthState {
  user: YibiaoUser | null;
  initialPasswordChange: InitialPasswordChangeState | null;
  login: (username: string, password: string) => Promise<LoginResult>;
  changeInitialPassword: (newPassword: string, confirmPassword: string) => Promise<void>;
  clearInitialPasswordChange: () => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface InitialPasswordChangeSession extends InitialPasswordChangeState {
  token: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<YibiaoUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    try {
      return raw ? (JSON.parse(raw) as YibiaoUser) : null;
    } catch {
      return null;
    }
  });
  const [initialPasswordChange, setInitialPasswordChange] = useState<InitialPasswordChangeState | null>(null);
  const initialPasswordChangeSessionRef = useRef<InitialPasswordChangeSession | null>(null);
  const initialPasswordChangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInitialPasswordChange = useCallback(() => {
    if (initialPasswordChangeTimeoutRef.current) {
      clearTimeout(initialPasswordChangeTimeoutRef.current);
      initialPasswordChangeTimeoutRef.current = null;
    }
    initialPasswordChangeSessionRef.current = null;
    setInitialPasswordChange(null);
  }, []);

  const beginInitialPasswordChange = useCallback((token: string, expiresIn: number) => {
    clearInitialPasswordChange();
    const session: InitialPasswordChangeSession = {
      token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    initialPasswordChangeSessionRef.current = session;
    setInitialPasswordChange({ expiresAt: session.expiresAt });
    initialPasswordChangeTimeoutRef.current = setTimeout(() => {
      // A previous timer must never clear a newer restricted session.
      if (initialPasswordChangeSessionRef.current !== session) return;
      initialPasswordChangeSessionRef.current = null;
      initialPasswordChangeTimeoutRef.current = null;
      setInitialPasswordChange(null);
    }, Math.max(0, session.expiresAt - Date.now()));
  }, [clearInitialPasswordChange]);

  const completeLogin = useCallback((token: string, authenticatedUser: YibiaoUser) => {
    clearInitialPasswordChange();
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(authenticatedUser));
    setUser(authenticatedUser);
    sseManager.start();
  }, [clearInitialPasswordChange]);

  const login = useCallback(async (username: string, password: string) => {
    const { data } = await publicHttp.post<unknown>('/login', {
      username,
      password,
    });
    if (isPasswordChangeRequiredResponse(data)) {
      sseManager.stop();
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      setUser(null);
      beginInitialPasswordChange(data.password_change_token, data.expires_in);
      return 'password-change-required';
    }
    if (!isAuthenticatedResponse(data)) {
      throw new Error('登录响应无效');
    }
    completeLogin(data.token, data.user);
    return 'authenticated';
  }, [beginInitialPasswordChange, completeLogin]);

  const changeInitialPassword = useCallback(async (newPassword: string, confirmPassword: string) => {
    const session = initialPasswordChangeSessionRef.current;
    if (!session || !isActiveInitialPasswordChangeSession(session, initialPasswordChangeSessionRef.current)) {
      clearInitialPasswordChange();
      throw new Error('改密凭证无效或已过期，请重新登录');
    }
    const { data } = await publicHttp.post<unknown>('/change-initial-password', {
      newPassword,
      confirmPassword,
    }, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!isAuthenticatedResponse(data)) {
      throw new Error('改密响应无效');
    }
    if (!isActiveInitialPasswordChangeSession(session, initialPasswordChangeSessionRef.current)) {
      if (initialPasswordChangeSessionRef.current === session) {
        clearInitialPasswordChange();
      }
      throw new Error('改密凭证无效或已过期，请重新登录');
    }
    completeLogin(data.token, data.user);
  }, [clearInitialPasswordChange, completeLogin]);

  const logout = useCallback(() => {
    sseManager.stop();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    clearInitialPasswordChange();
    setUser(null);
  }, [clearInitialPasswordChange]);

  // 拉取当前用户最新信息（权限即时生效）：admin 改 modules / 停用账号后，
  // 前端靠这个把 localStorage 快照刷新——菜单/守卫自动跟上，无需重登。
  // 仅 401/403（token 失效或被停用）触发 logout；网络抖动等其他错静默，下次定时再试。
  const refreshUser = useCallback(async () => {
    try {
      const { data } = await http.get<{ user: YibiaoUser }>('/me');
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      setUser(data.user);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 403) {
        logout();
      }
    }
  }, [logout]);

  // boot 时若已登录（token 在 LS），启动 SSE 总线。
  useEffect(() => {
    if (user) sseManager.start();
  }, [user]);

  useEffect(() => () => {
    if (initialPasswordChangeTimeoutRef.current) {
      clearTimeout(initialPasswordChangeTimeoutRef.current);
    }
  }, []);

  return <AuthContext.Provider value={{
    user,
    initialPasswordChange,
    login,
    changeInitialPassword,
    clearInitialPasswordChange,
    logout,
    refreshUser,
  }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

// 注册（公开）：手机号 + 密码 + 姓名（必填）+ 部门（选填）。成功后账号 status=pending，需管理员审批。
export async function register(
  phone: string,
  password: string,
  displayName: string,
  department: string,
): Promise<string> {
  const { data } = await publicHttp.post<{ success: boolean; message: string }>('/register', {
    phone,
    password,
    displayName,
    department,
  });
  return data.message;
}
