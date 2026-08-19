import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChapterContentMessages,
  computeGenerationWordTarget,
  normalizeOutlineWordControlSnapshot,
  stripRepeatedChapterTitle,
} from './contentGenerationHelpers';

test('does not strip the only content line when it equals the chapter title', () => {
  const result = stripRepeatedChapterTitle('签订安全保密协议', {
    id: 'mirror-22',
    title: '签订安全保密协议',
  } as any);

  assert.equal(result, '签订安全保密协议');
});

test('still strips a duplicated heading when body content remains', () => {
  const result = stripRepeatedChapterTitle('签订安全保密协议\n我方将签订安全保密协议。', {
    id: 'mirror-22',
    title: '签订安全保密协议',
  } as any);

  assert.equal(result, '我方将签订安全保密协议。');
});

test('normalizes STEP03 outline word-control snapshot for content generation', () => {
  const result = normalizeOutlineWordControlSnapshot({
    minWordsWan: 2,
    maxWordsWan: 3,
    wordsPerSectionWan: 0.25,
    forceSectionWords: true,
  });

  assert.equal(result.minimumWords, 20000);
  assert.equal(result.maximumWords, 30000);
  assert.equal(result.sectionWords, 2500);
  assert.equal(result.strictSectionWords, true);
  assert.equal(result.sectionMinimumWords, 2000);
  assert.equal(result.sectionMaximumWords, 3000);
});

test('adds STEP03 section word requirement to chapter prompt', () => {
  const wordControl = normalizeOutlineWordControlSnapshot({
    minWords: 10000,
    maxWords: 18000,
    wordsPerSection: 2000,
    forceSectionWords: true,
  });
  const generationTarget = computeGenerationWordTarget(wordControl, 10);
  const messages = buildChapterContentMessages({
    chapter: { id: '1.1', title: '服务方案', description: '描述服务方案' },
    wordControl,
    generationTarget,
  });
  const joined = messages.map((message) => message.content).join('\n');

  assert.match(joined, /本小节目标字数约/);
  assert.match(joined, /硬性上限 2400 字/);
  assert.match(joined, /绝对不得超过上限/);
});
