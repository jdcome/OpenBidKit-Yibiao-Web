import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlineSharedContextMessagesForTest } from './outlineGenerationHelpers';

test('outline shared context includes technical proposal structure instruction', () => {
  const messages = buildOutlineSharedContextMessagesForTest({
    overview: '项目概述',
    requirements: '技术评分要求',
    oldOutline: null,
    proposalStructureInstruction: '技术/响应方案章节要求：\n1. 对项目的理解',
  });
  const joined = messages.map((message) => message.content).join('\n');
  assert.match(joined, /技术\/响应方案章节要求/);
  assert.match(joined, /对项目的理解/);
});
