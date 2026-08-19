import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTechnicalProposalStructureRequirement,
  formatTechnicalProposalStructureForPrompt,
} from './technicalProposalStructure';

test('extracts explicit response plan checklist from XM2026 style text', () => {
  const markdown = `# 招标文件

九、响应方案

响应方案参考内容如下：
（1）对项目的理解；
（2）服务范围及内容；
（3）服务工作的依据、工作目标；
（4）服务机构设置（框图）、岗位职责；
（5）拟投入本项目的服务人员及主要人员简历；
（6）拟分包计划及情况说明；
（7）服务质量、进度、保密等保证措施；
（8）服务工作重点、难点分析；
（9）对本项目的合理化建议。
`;
  const result = extractTechnicalProposalStructureRequirement(markdown);
  assert.equal(result.mode, 'explicit_checklist');
  assert.equal(result.title, '九、响应方案');
  assert.equal(result.items.length, 9);
  assert.equal(result.items[0].title, '对项目的理解');
  assert.equal(result.items[8].title, '对本项目的合理化建议');
});

test('detects self-defined format without hard checklist', () => {
  const result = extractTechnicalProposalStructureRequirement('技术方案格式自拟，由投标人自行编制。');
  assert.equal(result.mode, 'self_defined');
  assert.equal(result.items.length, 0);
});

test('treats self-defined format with explicit includes as checklist', () => {
  const markdown = '技术方案格式自拟，但应包含：1. 项目理解；2. 实施方案；3. 质量保障措施。';
  const result = extractTechnicalProposalStructureRequirement(markdown);
  assert.equal(result.mode, 'explicit_checklist');
  assert.deepEqual(result.items.map((item) => item.title), ['项目理解', '实施方案', '质量保障措施']);
});

test('formats prompt block for explicit checklist', () => {
  const result = extractTechnicalProposalStructureRequirement('九、响应方案\n响应方案参考内容如下：\n（1）对项目的理解；\n（2）服务范围及内容；');
  const prompt = formatTechnicalProposalStructureForPrompt(result);
  assert.match(prompt, /技术\/响应方案章节要求/);
  assert.match(prompt, /评分表决定一级目录主线/);
  assert.match(prompt, /对项目的理解/);
});

test('does not treat numbered list item as response plan heading', () => {
  const markdown = `# 评审办法

技术评分项包括：
（7）服务工作重点、难点分析；
（8）服务质量保证措施；
（9）响应方案；

供应商须知：
1. 供应商不能提供书面说明、证明材料，或者提供的书面说明、证明材料不能证明其报价合理性的，评审小组应当将其作为无效投标处理。
2. 相关法律法规对供应商报价有规定的，从其规定。
3. 响应文件有效期。
4. 响应保证金。
5. 资格审查资料。
`;

  const result = extractTechnicalProposalStructureRequirement(markdown);
  assert.equal(result.mode, 'none');
  assert.equal(result.items.length, 0);
});

test('stops explicit response plan checklist at next Chinese chapter heading', () => {
  const markdown = `九、响应方案

响应方案参考内容如下：
（1）对项目的理解；
（2）服务范围及内容；

十、供应商须知

1. 响应文件有效期。
2. 响应保证金。
3. 资格审查资料。
`;

  const result = extractTechnicalProposalStructureRequirement(markdown);
  assert.equal(result.mode, 'explicit_checklist');
  assert.equal(result.title, '九、响应方案');
  assert.deepEqual(result.items.map((item) => item.title), ['对项目的理解', '服务范围及内容']);
});

test('does not treat technical scoring table as response chapter checklist', () => {
  const markdown = `# 附件1 评审因素和标准（包1）

<table><tbody><tr><td>技术部分（50分）</td><td>测评方案（30分）</td><td>供应商针对本项目提供的测评方案，内容应包含：①等级测评内容、②测评方法、③测评工具、④测评过程中的难点把控、⑤应急响应措施等方面。磋商小组根据方案的完整性和合理性等进行评价，每缺少一项内容扣6分。</td></tr></tbody></table>

推荐成交候选人计算方法：
1）供应商的综合得分为：所有磋商小组成员对其评标的综合得分；
2）计算过程中，算术平均值保留2位小数。

# 第五章 响应文件组成

**三、服务方案**

附件7-1：

**服务方案**

服务类项目供应商应根据第四章规定编写服务方案或服务大纲。
`;

  const result = extractTechnicalProposalStructureRequirement(markdown);
  assert.equal(result.mode, 'none');
  assert.equal(result.items.length, 0);
});
