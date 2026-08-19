import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = path.resolve(currentDir, '..');

const files = [
  'app/LoginPage.tsx',
  'components/AppTopbar.tsx',
  'features/settings/pages/SettingsPage.tsx',
  'shared/api/bridge.ts',
].map((file) => path.join(clientSrc, file));

test('客户端系统名称 fallback 和设置占位文案使用新默认名称', () => {
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /易标投标工具箱web版/, file);
    assert.doesNotMatch(source, /金盾标书编制系统/, file);
  }
});
