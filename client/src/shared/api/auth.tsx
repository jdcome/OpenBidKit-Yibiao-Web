import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { http, TOKEN_KEY, USER_KEY } from './http';
import { sseManager } from './sse';

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

interface AuthState {
  user: YibiaoUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<YibiaoUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    try {
      return raw ? (JSON.parse(raw) as YibiaoUser) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback(async (username: string, password: string) => {
    const { data } = await http.post<{ token: string; user: YibiaoUser }>('/login', {
      username,
      password,
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
    sseManager.start();
  }, []);

  const logout = useCallback(() => {
    sseManager.stop();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

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

  return <AuthContext.Provider value={{ user, login, logout, refreshUser }}>{children}</AuthContext.Provider>;
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
  const { data } = await http.post<{ success: boolean; message: string }>('/register', {
    phone,
    password,
    displayName,
    department,
  });
  return data.message;
}
