import test from 'node:test';
import assert from 'node:assert/strict';
import { detectResponseDeviationAvailability } from './detector';
import { parseTenderBlocks } from './structure';
import type { ProjectTenderSourceSnapshot } from './types';

function snapshot(markdown: string, overrides: Partial<ProjectTenderSourceSnapshot> = {}): ProjectTenderSourceSnapshot {
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
    ...overrides,
  };
}

test('识别采购需求响应程度为技术响应表', () => {
  const markdown = [
    '# 招标文件',
    '## 第三章 采购需求',
    '1. 服务范围',
    '## 第六章 响应文件格式',
    '### 四、采购需求响应程度',
    '| 序号 | 招标文件要求 | 投标文件应答 | 响应/偏离 | 偏离说明 |',
    '| --- | --- | --- | --- | --- |',
  ].join('\n\n');
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), snapshot(markdown));
  assert.equal(result.available, true);
  assert.equal(result.kind, 'technical');
  assert.equal(result.templateTitle, '四、采购需求响应程度');
  assert.equal(result.sourceChapterTitle, '第三章 采购需求');
});

test('多标段仅锁定当前包采购需求', () => {
  const markdown = [
    '# 招标文件',
    '## 包1 网络安全服务',
    '### 采购需求',
    '1. 包1要求不得进入结果',
    '## 包2 等保测评服务',
    '### 采购需求',
    '1. 包2要求应进入结果',
    '## 响应文件格式',
    '### 技术参数响应表',
    '| 序号 | 技术要求 | 响应内容 | 偏离说明 |',
    '| --- | --- | --- | --- |',
  ].join('\n\n');
  const source = snapshot(markdown, {
    bidSectionMode: 'multiple',
    selectedSectionId: 'package-2',
    selectedSectionTitle: '包2 等保测评服务',
    selectedSectionHeadLine: '## 包2 等保测评服务',
  });
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), source);
  assert.equal(result.available, true);
  assert.ok(result.sourceBlockIds.length > 0);
  assert.match(result.sourceText, /包2要求应进入结果/);
  assert.doesNotMatch(result.sourceText, /包1要求不得进入结果/);
});

test('多标段未选择时要求先选择标段', () => {
  const markdown = '## 包1\n\n### 采购需求\n\n内容\n\n## 技术响应表';
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), snapshot(markdown, {
    bidSectionMode: 'multiple',
    selectedSectionId: '',
  }));
  assert.equal(result.available, false);
  assert.equal(result.reason, 'package-required');
});

test('只有独立商务条款偏离表时不提供技术工作台', () => {
  const markdown = [
    '## 采购需求',
    '1. 服务内容',
    '## 商务条款偏离表',
    '| 序号 | 商务条款 | 响应内容 | 偏离说明 |',
    '| --- | --- | --- | --- |',
  ].join('\n\n');
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), snapshot(markdown));
  assert.equal(result.available, false);
  assert.equal(result.kind, 'business-only');
});

test('评分表中出现采购需求响应字样不应误识别为偏离表模板', () => {
  const markdown = `## 四、评标方法

<table><tr><td>技术评分</td><td>采购需求响应</td></tr><tr><td>15分</td><td>全部满足得满分</td></tr></table>

## 五、采购需求

1. 服务范围
`;
  const blocks = parseTenderBlocks(markdown);
  const result = detectResponseDeviationAvailability(blocks, snapshot(markdown));
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no-template');
});

test('识别技术规范书应答偏离表并定位技术规范书来源章节', () => {
  const markdown = [
    '# 招标文件',
    '',
    '**第五章 技术规范书**',
    '',
    '**1.总则**',
    '',
    '本技术规范书适用于本项目的信息系统等级保护测评服务。',
    '',
    '**2.服务内容**',
    '',
    '供应商应完成测评、整改建议、报告编制等工作。',
    '',
    '**第六章 参选文件格式**',
    '',
    '**3.技术规范书点对点应答**',
    '',
    '参选人应对技术规范书逐条应答。',
    '',
    '**4.技术规范书应答偏离表**',
    '',
    '| 序号 | 比选文件条目号 | 比选文件对应的内容 | 参选文件偏离情况 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    '| 1 | 第五章 技术规范书 1.总则 | 本技术规范书适用于本项目。 | 无偏离 | / |',
  ].join('\n');
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), snapshot(markdown));
  assert.equal(result.available, true);
  assert.equal(result.kind, 'technical');
  assert.equal(result.templateTitle, '4.技术规范书应答偏离表');
  assert.equal(result.sourceChapterTitle, '第五章 技术规范书');
  assert.match(result.sourceText, /信息系统等级保护测评服务/);
});

test('技术规范书点对点应答没有偏离表表头时不弹工作台入口', () => {
  const markdown = [
    '# 招标文件',
    '',
    '**第五章 技术规范书**',
    '',
    '供应商应逐条响应技术规范书。',
    '',
    '**3.技术规范书点对点应答**',
    '',
    '参选人应针对技术规范书条款逐项作出正偏离、负偏离或无偏离说明。',
  ].join('\n');
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), snapshot(markdown));
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no-template');
});

test('目录页中的技术规范书应答偏离表条目没有真实表格时不识别为模板', () => {
  const markdown = [
    '# 目录',
    '',
    '第五章 技术规范书 50',
    '',
    '4.技术规范书应答偏离表 80',
    '',
    '# 第五章 技术规范书',
    '',
    '真实技术规范正文。',
  ].join('\n');
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), snapshot(markdown));
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no-template');
});

test('技术评分表包含响应和偏离字样也不应误识别为偏离表模板', () => {
  const markdown = [
    '# 招标文件',
    '',
    '## 第五章 技术规范书',
    '',
    '技术规范正文。',
    '',
    '## 评审因素和标准',
    '',
    '| 评审因素 | 分值 | 评分细则 |',
    '| --- | --- | --- |',
    '| 技术部分 | 50分 | 供应商响应方案不得存在重大偏离，评分细则按优良中差计分。 |',
  ].join('\n');
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), snapshot(markdown));
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no-template');
});

test('Word 转换出的粗体段落章节也能识别来源边界', () => {
  const markdown = `**第四章 采购需求**

一、项目背景

项目说明。

**四、技术/商务响应与偏离表**

| 序号 | 磋商文件条目号 | 采购规格/商务条款 | 响应与偏离 |
| --- | --- | --- | --- |
`;
  const blocks = parseTenderBlocks(markdown);
  const result = detectResponseDeviationAvailability(blocks, snapshot(markdown));
  assert.equal(result.available, true);
  assert.equal(result.sourceChapterTitle, '第四章 采购需求');
  assert.equal(result.kind, 'combined');
});

test('目录中的同名章节不覆盖后面的真实采购需求和表单', () => {
  const markdown = `第三章 采购需求

第四章 响应文件格式

# 第三章 采购需求

1. 真实服务要求

（4）技术/商务响应与偏离表

# 第五章 响应文件格式

## 四、技术/商务响应与偏离表

| 序号 | 磋商文件条目号 | 采购规格/商务条款 | 响应文件的规格 | 响应与偏离 | 说明 |
| --- | --- | --- | --- | --- | --- |
`;
  const result = detectResponseDeviationAvailability(parseTenderBlocks(markdown), snapshot(markdown));
  assert.equal(result.templateTitle, '四、技术/商务响应与偏离表');
  assert.match(result.sourceText, /真实服务要求/);
});

test('多包 includeRanges 裁剪来源时仍识别公共技术商务偏离表模板', () => {
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
    '包1采购需求',
  ].join('\n');

  const result = detectResponseDeviationAvailability(parseTenderBlocks(fullMarkdown), snapshot(fullMarkdown, {
    bidSectionMode: 'multiple',
    selectedSectionId: 'package-1',
    selectedSectionTitle: '包1',
    selectedSectionHeadLine: '',
    selectedSectionMarkdown,
  }));

  assert.equal(result.available, true);
  assert.equal(result.templateTitle, '四、技术/商务响应与偏离表');
  assert.match(result.sourceText, /包1采购需求/);
  assert.doesNotMatch(result.sourceText, /包2采购需求不得进入结果/);
});
