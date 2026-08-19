import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THEME_STORAGE_KEY,
  applyThemeToRoot,
  normalizeTheme,
  readStoredTheme,
} from './theme.ts';

test('缺失或非法的持久化值回退到浅色主题', () => {
  assert.equal(normalizeTheme(null), 'light');
  assert.equal(normalizeTheme('unknown'), 'light');
});

test('存储读取异常时仍安全回退到浅色主题', () => {
  const storage = {
    getItem() {
      throw new Error('storage unavailable');
    },
  };

  assert.equal(readStoredTheme(storage), 'light');
});

test('合法的 SOC 深色持久化值会被恢复', () => {
  const storage = {
    getItem(key) {
      assert.equal(key, THEME_STORAGE_KEY);
      return 'soc-dark';
    },
  };

  assert.equal(readStoredTheme(storage), 'soc-dark');
});

test('应用主题会同步根节点属性和原生配色模式', () => {
  const root = {
    dataset: {},
    style: {},
  };

  applyThemeToRoot('soc-dark', root);

  assert.equal(root.dataset.theme, 'soc-dark');
  assert.equal(root.style.colorScheme, 'dark');
});
