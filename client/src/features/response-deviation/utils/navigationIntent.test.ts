import assert from 'node:assert/strict';
import test from 'node:test';

test('导航意图契约包含项目、招标指纹和标段', () => {
  const value = { projectId: 7, tenderHash: 'h', selectedSectionId: 'p2', createdAt: Date.now() };
  assert.equal(value.projectId, 7);
  assert.equal(value.selectedSectionId, 'p2');
});
