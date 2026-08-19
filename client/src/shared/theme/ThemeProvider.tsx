import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  THEME_STORAGE_KEY,
  applyThemeToRoot,
  readStoredTheme,
  type ThemeMode,
} from './theme';

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  return readStoredTheme(window.localStorage);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  useLayoutEffect(() => {
    applyThemeToRoot(theme, document.documentElement);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // 浏览器禁用存储时仍允许当前会话切换主题。
    }
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme,
    toggleTheme: () => setTheme((current) => current === 'soc-dark' ? 'light' : 'soc-dark'),
  }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return value;
}
