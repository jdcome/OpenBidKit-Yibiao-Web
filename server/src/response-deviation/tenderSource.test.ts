import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectTenderSourceService } from './tenderSource';

function createMeta(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 10,
    tenderFileName: '招标文件.docx',
    tenderMarkdownPath: 'technical-plan/10/tender.md',
    tenderMarkdownHash: 'working-hash',
    tenderOriginalMarkdownPath: 'technical-plan/10/tender.original.md',
    tenderOriginalMarkdownHash: 'hash-a',
    tenderParserLabel: '本地解析',
    bidSectionMode: 'multiple',
    selectedSectionId: 'package-2',
    selectedSectionTitle: '包2 等保测评服务',
    selectedSectionHeadLine: '## 包2 等保测评服务',
    ...overrides,
  };
}

test('复用原始 Markdown、文件指纹和当前标段，不复制或重新解析文件', async () => {
  let readCount = 0;
  const prisma = {
    technicalPlanMeta: {
      findUnique: async () => createMeta(),
    },
  };
  const technicalPlanStore = {
    readOriginalTenderMarkdown: async () => {
      readCount += 1;
      return '# 招标文件\n\n## 包2 等保测评服务\n\n### 采购需求\n内容';
    },
    loadTechnicalPlan: async () => ({
      bidItems: [
        { id: 'projectInfo', content: '{"项目名称":"等保测评服务"}' },
        { id: 'procurementList', content: '采购内容' },
        { id: 'responseFileRequirements', content: '响应文件要求' },
      ],
    }),
  };

  const service = createProjectTenderSourceService(prisma as never, technicalPlanStore as never);
  const result = await service.getSnapshot(10);

  assert.equal(readCount, 1);
  assert.equal(result?.tenderHash, 'hash-a');
  assert.equal(result?.selectedSectionId, 'package-2');
  assert.equal(result?.selectedSectionTitle, '包2 等保测评服务');
  assert.match(result?.markdown || '', /采购需求/);
  assert.deepEqual(result?.analysis.projectInfo, { id: 'projectInfo', content: '{"项目名称":"等保测评服务"}' });
});

test('没有已上传招标文件时返回 null', async () => {
  const prisma = {
    technicalPlanMeta: {
      findUnique: async () => createMeta({ tenderMarkdownPath: null, tenderOriginalMarkdownPath: null }),
    },
  };
  const technicalPlanStore = {
    readOriginalTenderMarkdown: async () => {
      throw new Error('不应读取');
    },
    loadTechnicalPlan: async () => ({}),
  };

  const result = await createProjectTenderSourceService(prisma as never, technicalPlanStore as never).getSnapshot(10);
  assert.equal(result, null);
});

test('单标段项目规范化为空标段标识', async () => {
  const prisma = {
    technicalPlanMeta: {
      findUnique: async () => createMeta({
        bidSectionMode: 'single',
        selectedSectionId: null,
        selectedSectionTitle: null,
        selectedSectionHeadLine: null,
      }),
    },
  };
  const technicalPlanStore = {
    readOriginalTenderMarkdown: async () => '# 招标文件\n\n## 采购需求',
    loadTechnicalPlan: async () => ({ bidItems: [] }),
  };

  const result = await createProjectTenderSourceService(prisma as never, technicalPlanStore as never).getSnapshot(10);
  assert.equal(result?.bidSectionMode, 'single');
  assert.equal(result?.selectedSectionId, '');
  assert.equal(result?.selectedSectionTitle, '');
});

test('多标段项目额外提供按 includeRanges 裁剪的当前包 Markdown', async () => {
  const prisma = {
    technicalPlanMeta: {
      findUnique: async () => createMeta({
        selectedSectionId: 'package-1',
        selectedSectionTitle: '包1',
        selectedSectionHeadLine: null,
      }),
    },
  };
  const technicalPlanStore = {
    readOriginalTenderMarkdown: async () => [
      '# 招标文件',
      '公共说明',
      '包1采购需求',
      '包2采购需求',
      '公共响应文件格式',
    ].join('\n'),
    loadTechnicalPlan: async () => ({
      tenderFile: { selectedSectionId: 'package-1' },
      bidSectionMode: 'multiple',
      bidSections: [
        { id: 'package-1', title: '包1', includeRanges: [{ startLine: 3, endLine: 3, reason: '包1采购需求' }] },
        { id: 'package-2', title: '包2', includeRanges: [{ startLine: 4, endLine: 4, reason: '包2采购需求' }] },
      ],
      bidItems: [],
    }),
  };

  const result = await createProjectTenderSourceService(prisma as never, technicalPlanStore as never).getSnapshot(10);

  assert.match(result?.markdown || '', /包2采购需求/);
  assert.match(result?.selectedSectionMarkdown || '', /包1采购需求/);
  assert.doesNotMatch(result?.selectedSectionMarkdown || '', /包2采购需求/);
});
