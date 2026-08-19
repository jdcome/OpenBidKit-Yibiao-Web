import assert from 'node:assert/strict';
import test from 'node:test';
import { computeResponseDeviationAvailability } from './response-deviation';

test('可用性检查只做确定性扫描且返回招标源指纹', async () => {
  let calls = 0;
  const result = await computeResponseDeviationAvailability(9, {
    getSnapshot: async () => {
      calls += 1;
      return {
        projectId: 9, fileName: 'a.docx', tenderHash: 'hash-9', parserLabel: 'office', bidSectionMode: 'single',
        selectedSectionId: '', selectedSectionTitle: '', selectedSectionHeadLine: '', analysis: {},
        markdown: '## 五、采购需求\n\n### 1. 服务范围\n原文\n\n## 四、采购需求响应程度\n\n| 序号 | 招标文件要求 | 响应与偏离 |\n| --- | --- | --- |',
      } as never;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.available, true);
  assert.equal(result.tenderHash, 'hash-9');
});

test('没有招标源时返回 no-tender', async () => {
  const result = await computeResponseDeviationAvailability(9, { getSnapshot: async () => null });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no-tender');
});
