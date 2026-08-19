import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const topbarPath = path.resolve(currentDir, '../../components/AppTopbar.tsx');
const appShellPath = path.resolve(currentDir, '../../components/AppShell.tsx');
const topbarSource = readFileSync(topbarPath, 'utf8');
const appShellSource = readFileSync(appShellPath, 'utf8');

test('顶部主题按钮显示当前模式名称', () => {
  assert.match(
    topbarSource,
    /<span>\{theme === 'soc-dark' \? '深色模式' : '浅色模式'\}<\/span>/,
  );
});

test('顶部主题按钮图标跟随当前模式：深色月亮，浅色太阳', () => {
  assert.match(
    topbarSource,
    /<ThemeIcon dark=\{theme === 'soc-dark'\} \/>/,
  );
  assert.match(topbarSource, /M20\.2 14\.1A8\.2 8\.2 0 0 1 9\.9 3\.8/);
  assert.match(topbarSource, /<circle cx="12" cy="12" r="3\.6" \/>/);
});

test('顶部切换按钮无障碍文案仍描述点击后的目标主题', () => {
  assert.match(
    topbarSource,
    /aria-label=\{theme === 'soc-dark' \? '切换到浅色主题' : '切换到 SOC 深色主题'\}/,
  );
  assert.match(
    topbarSource,
    /title=\{theme === 'soc-dark' \? '切换到浅色主题' : '切换到 SOC 深色主题'\}/,
  );
});

test('顶部主题按钮在所有登录后页面显示，不再只绑定仪表盘', () => {
  assert.doesNotMatch(
    appShellSource,
    /showThemeToggle=\{activeSection === 'dashboard'\}/,
  );
  assert.match(appShellSource, /<AppTopbar\s+showThemeToggle(?:=\{true\})?\s*\/>/);
});
