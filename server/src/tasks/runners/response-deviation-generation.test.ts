import test from 'node:test';
import assert from 'node:assert/strict';
import { runResponseDeviationGenerationTask } from './response-deviation-generation';

function source() {
  const markdown = [
    '# 招标文件',
    '## 第三章 采购需求',
    '三、项目原则',
    '（1）标准性原则：遵循国家标准。',
    '（2）规范性原则：过程保持规范。',
    '## 第六章 响应文件格式',
    '### 四、采购需求响应程度',
    '| 序号 | 招标文件要求 | 投标文件应答 | 响应/偏离 | 偏离说明 |',
    '| --- | --- | --- | --- | --- |',
  ].join('\n\n');
  return {
    projectId: 10,
    fileName: '招标文件.docx',
    markdown,
    tenderHash: 'hash-a',
    parserLabel: '本地解析',
    selectedSectionId: '',
    selectedSectionTitle: '',
    selectedSectionHeadLine: '',
    bidSectionMode: 'single',
    analysis: { projectInfo: null, procurementList: null, responseFileRequirements: null },
  };
}

test('确定性场景零 Pi 调用并保存一行项目原则', async () => {
  const updates: Record<string, unknown>[] = [];
  let saved: Record<string, unknown> | null = null;
  let agentCalls = 0;
  await runResponseDeviationGenerationTask({
    projectId: 10,
    prisma: {} as never,
    aiService: {} as never,
    agentService: { runTask: async () => { agentCalls += 1; throw new Error('不应调用'); } } as never,
    workspaceStore: {
      getTenderSourceSnapshot: async () => source(),
      saveGeneratedRows: async (args: Record<string, unknown>) => { saved = args; return {}; },
    },
    knowledgeBaseService: {},
    config: {},
    updateTask: async (partial: Record<string, unknown>) => { updates.push(partial); return partial as never; },
    payload: {},
    taskControl: { queueScopeId: 'q', pauseRequested: false, isPauseRequested: () => false, requestPause: async () => ({} as never) },
    previousState: {},
  });

  assert.equal(agentCalls, 0);
  assert.equal((saved?.extraction as { rows: unknown[] }).rows.length, 1);
  assert.equal((saved?.extraction as { rows: { aggregation: string }[] }).rows[0].aggregation, 'principles');
  assert.equal(updates.at(-1)?.status, 'success');
  assert.equal(updates.at(-1)?.progress, 100);
});

test('没有招标文件时明确失败', async () => {
  await assert.rejects(() => runResponseDeviationGenerationTask({
    projectId: 10,
    prisma: {} as never,
    aiService: {} as never,
    workspaceStore: { getTenderSourceSnapshot: async () => null },
    knowledgeBaseService: {},
    config: {},
    updateTask: async (partial: Record<string, unknown>) => partial as never,
    payload: {},
    taskControl: { queueScopeId: 'q', pauseRequested: false, isPauseRequested: () => false, requestPause: async () => ({} as never) },
    previousState: {},
  }), /请先在生成技术方案中上传招标文件/);
});

test('多包项目用裁剪后的当前包来源生成偏离表行', async () => {
  const fullMarkdown = [
    '# 招标文件',
    '公共说明',
    '包1采购需求',
    '包2采购需求不得进入结果',
    '## 第六章 响应文件格式',
    '### 四、技术/商务响应与偏离表',
    '| 序号 | 磋商文件条目号 | 采购规格/商务条款 | 响应与偏离 |',
    '| --- | --- | --- | --- |',
  ].join('\n\n');
  const selectedSectionMarkdown = [
    '# 当前投标范围：包1',
    '',
    '## 第四章采购需求包1（L3-L3）',
    '',
    '一、服务范围',
    '',
    '包1采购需求',
  ].join('\n');
  let saved: Record<string, unknown> | null = null;

  await runResponseDeviationGenerationTask({
    projectId: 10,
    prisma: {} as never,
    aiService: {} as never,
    agentService: { runTask: async () => { throw new Error('不应调用'); } } as never,
    workspaceStore: {
      getTenderSourceSnapshot: async () => ({
        projectId: 10,
        fileName: '招标文件.docx',
        markdown: fullMarkdown,
        selectedSectionMarkdown,
        tenderHash: 'hash-a',
        parserLabel: '本地解析',
        selectedSectionId: 'package-1',
        selectedSectionTitle: '包1',
        selectedSectionHeadLine: '',
        bidSectionMode: 'multiple',
        analysis: { projectInfo: null, procurementList: null, responseFileRequirements: null },
      }),
      saveGeneratedRows: async (args: Record<string, unknown>) => { saved = args; return {}; },
    },
    knowledgeBaseService: {},
    config: {},
    updateTask: async (partial: Record<string, unknown>) => partial as never,
    payload: {},
    taskControl: { queueScopeId: 'q', pauseRequested: false, isPauseRequested: () => false, requestPause: async () => ({} as never) },
    previousState: {},
  });

  const rows = (saved?.extraction as { rows: Array<{ requirementPlainText: string }> }).rows;
  assert.equal(rows.length, 1);
  assert.match(rows[0].requirementPlainText, /包1采购需求/);
  assert.doesNotMatch(rows[0].requirementPlainText, /包2采购需求不得进入结果/);
});
