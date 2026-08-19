import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeDiagnosticText, summarizeResponseShape, truncateUtf8 } from './sanitize';

test('redacts credentials but preserves ordinary Chinese output', () => {
  const source = [
    'Authorization: Bearer abc.def.ghi',
    'api_key=sk-secret-value',
    'Cookie: session=private-cookie',
    'postgresql://user:pass@localhost:5432/yibiao',
    '服务期限：二年',
  ].join('\n');
  const result = sanitizeDiagnosticText(source);
  for (const secret of ['abc.def.ghi', 'sk-secret-value', 'private-cookie', 'user:pass']) {
    assert.equal(result.includes(secret), false);
  }
  assert.match(result, /服务期限：二年/);
});

test('truncates UTF-8 text without breaking a code point', () => {
  const result = truncateUtf8('测'.repeat(30_000), 60 * 1024);
  assert.ok(Buffer.byteLength(result, 'utf8') <= 60 * 1024);
  assert.equal(result.endsWith('\uFFFD'), false);
});

test('summarizes response structure without copying values', () => {
  const summary = summarizeResponseShape({ groups: [{ id: 'secret-id', title: '敏感标题', content: '敏感正文' }] });
  const rendered = JSON.stringify(summary);
  assert.deepEqual(summary, { type: 'object', keys: ['groups'], fields: { groups: { type: 'array', length: 1 } } });
  assert.equal(rendered.includes('敏感正文'), false);
  assert.equal(rendered.includes('secret-id'), false);
});
