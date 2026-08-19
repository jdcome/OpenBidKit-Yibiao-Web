export type ThemeMode = 'light' | 'soc-dark';

export const THEME_STORAGE_KEY = 'yibiao_ui_theme';

type ThemeStorageReader = Pick<Storage, 'getItem'>;
type ThemeRoot = Pick<HTMLElement, 'dataset' | 'style'>;

export function normalizeTheme(value: string | null | undefined): ThemeMode {
  return value === 'soc-dark' ? 'soc-dark' : 'light';
}

export function readStoredTheme(storage: ThemeStorageReader): ThemeMode {
  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'light';
  }
}

export function applyThemeToRoot(theme: ThemeMode, root: ThemeRoot): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme === 'soc-dark' ? 'dark' : 'light';
}
