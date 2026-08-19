import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDiagnosticError } from './classify';

test('classifies a missing groups validator failure', () => {
  const issue = classifyDiagnosticError(new Error('全局事实结果缺少 groups'), 'validate');
  assert.equal(issue.code, 'AI_SCHEMA_TOP_LEVEL_MISSING');
  assert.equal(issue.stage, 'validate');
});

test('classifies truncated JSON syntax separately', () => {
  const issue = classifyDiagnosticError(new SyntaxError('Unexpected end of JSON input'), 'parse');
  assert.equal(issue.code, 'AI_JSON_TRUNCATED');
});

test('classifies a missing required group field and exposes its path', () => {
  const issue = classifyDiagnosticError(new Error('全局事实第 3 项缺少 id、title 或 content'), 'validate');
  assert.equal(issue.code, 'AI_SCHEMA_REQUIRED_FIELD_MISSING');
  assert.equal(issue.path, 'groups[2]');
});
