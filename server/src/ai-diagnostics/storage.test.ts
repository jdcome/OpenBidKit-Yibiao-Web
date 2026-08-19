import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAiDiagnosticStorage } from './storage';

test('writes and reads a sanitized failure under the configured root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yibiao-ai-diag-'));
  const storage = createAiDiagnosticStorage(root);
  const relativePath = await storage.writeFailure('trace-safe', 'attempt-safe', '服务期限：二年');
  assert.equal(path.isAbsolute(relativePath), false);
  assert.equal(relativePath.includes('..'), false);
  assert.equal(await storage.readFailure(relativePath), '服务期限：二年');
  await assert.rejects(() => storage.readFailure('../server/.env'));
});

test('caps stored failure content at 60KB', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yibiao-ai-diag-'));
  const storage = createAiDiagnosticStorage(root);
  const relativePath = await storage.writeFailure('trace-cap', 'attempt-cap', '测'.repeat(30_000));
  const content = await storage.readFailure(relativePath);
  assert.ok(Buffer.byteLength(content, 'utf8') <= 60 * 1024);
  assert.equal(content.endsWith('\uFFFD'), false);
});

test('deletes diagnostic day directories older than seven days', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yibiao-ai-diag-'));
  const oldDir = path.join(root, '2026-08-01');
  await mkdir(oldDir, { recursive: true });
  const oldTime = new Date('2026-08-01T00:00:00.000Z');
  await utimes(oldDir, oldTime, oldTime);
  const storage = createAiDiagnosticStorage(root);
  const removed = await storage.deleteExpired(new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(removed, 1);
  await assert.rejects(() => stat(oldDir));
});
