import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequirements } from './extractor';
import { parseTenderBlocks } from './structure';

function extract(markdown: string) {
  const blocks = parseTenderBlocks(markdown);
  return extractRequirements(blocks, {
    blockIds: blocks.map((block) => block.id),
    sourceChapterTitle: '第三章 采购需求',
  });
}

test('三、项目原则及其编号子原则整体只生成一行', () => {
  const result = extract([
    '## 第三章 采购需求',
    '',
    '三、项目原则',
    '',
    '（1）标准性原则：测评应依据国家标准。',
    '',
    '（2）规范性原则：过程和文档应保持规范。',
  ].join('\n'));

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].aggregation, 'principles');
  assert.equal(result.rows[0].clauseNo, '第三章 采购需求 三、项目原则');
  assert.match(result.rows[0].requirementMarkdown, /（1）标准性原则/);
  assert.match(result.rows[0].requirementMarkdown, /（2）规范性原则/);
  assert.equal(result.uncoveredBlockIds.length, 0);
  assert.equal(result.duplicateBlockIds.length, 0);
});

test('测评对象说明文字和有序号的系统表格整体只生成一行', () => {
  const result = extract([
    '## 第三章 采购需求',
    '',
    '四、测评对象',
    '',
    '本项目测评对象如下：',
    '',
    '<table>',
    '<tr><th>序号</th><th>系统名称</th><th>等级</th></tr>',
    '<tr><td>1</td><td>系统A</td><td>三级</td></tr>',
    '<tr><td>2</td><td>系统B</td><td>二级</td></tr>',
    '</table>',
    '',
    '以上系统均纳入本次测评。',
  ].join('\n'));

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].aggregation, 'assessment-objects');
  assert.match(result.rows[0].requirementMarkdown, /本项目测评对象如下/);
  assert.match(result.rows[0].requirementMarkdown, /<table>/);
  assert.match(result.rows[0].requirementMarkdown, /系统A/);
  assert.match(result.rows[0].requirementMarkdown, /系统B/);
  assert.match(result.rows[0].requirementMarkdown, /以上系统均纳入/);
  assert.equal(result.uncoveredBlockIds.length, 0);
});

test('普通编号条款一条一行且无编号解释跟随最近条款', () => {
  const result = extract([
    '## 第三章 采购需求',
    '',
    '项目背景和解释性文字。',
    '',
    '1.服务范围及内容',
    '',
    '包括安全测评和整改建议。',
    '',
    '2. 服务期限',
    '',
    '自合同签订之日起一年。',
  ].join('\n'));

  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].aggregation, 'unnumbered-section');
  assert.match(result.rows[0].requirementMarkdown, /项目背景/);
  assert.equal(result.rows[1].clauseNo, '第三章 采购需求 1.服务范围及内容');
  assert.match(result.rows[1].requirementMarkdown, /整改建议/);
  assert.equal(result.rows[2].clauseNo, '第三章 采购需求 2.服务期限');
  assert.match(result.rows[2].requirementMarkdown, /合同签订/);
  assert.equal(result.uncoveredBlockIds.length, 0);
  assert.equal(result.duplicateBlockIds.length, 0);
});

test('条目号使用清洗后的来源章节完整路径，去掉包号和行号范围', () => {
  const markdown = [
    '## 第四章采购需求包1（L795-L903）',
    '',
    '包1：',
    '',
    '一、项目背景',
    '',
    '项目背景说明。',
    '',
    '二、项目目标',
    '',
    '项目目标说明。',
    '',
    '三、项目原则',
    '',
    '（1）安全性原则：保障系统安全。',
    '',
    '（2）规范性原则：过程文档规范。',
    '',
    '四、参考文件',
    '',
    'GB/T 22239-2019。',
  ].join('\n');
  const blocks = parseTenderBlocks(markdown);
  const result = extractRequirements(blocks, {
    blockIds: blocks.map((block) => block.id),
    sourceChapterTitle: '第四章采购需求包1（L795-L903）',
  });

  assert.deepEqual(result.rows.map((row) => row.clauseNo), [
    '第四章 采购需求 一、项目背景',
    '第四章 采购需求 二、项目目标',
    '第四章 采购需求 三、项目原则',
    '第四章 采购需求 四、参考文件',
  ]);
  assert.equal(result.uncoveredBlockIds.length, 0);
  assert.equal(result.duplicateBlockIds.length, 0);
});

test('加粗编号标题和同行正文拆开：标题进条目号，正文进招标文件要求', () => {
  const result = extract([
    '## 第三章 采购需求',
    '',
    '**十一、付款方式：**合同签订之日起计入服务期，出具所有测评报告后15个工作日内付款至合同总价的100%。',
  ].join('\n'));

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].clauseNo, '第三章 采购需求 十一、付款方式');
  assert.equal(result.rows[0].requirementTitle, '付款方式');
  assert.equal(result.rows[0].requirementMarkdown, '合同签订之日起计入服务期，出具所有测评报告后15个工作日内付款至合同总价的100%。');
});

test('标题独占一行时招标文件要求不重复显示同名标题', () => {
  const result = extract([
    '## 第三章 采购需求',
    '',
    '**十二、售后服务要求**',
    '',
    '本项目为交钥匙工程，供应商应根据项目要求响应。',
    '',
    '**对于上述项目要求，供应商应在响应文件中进行响应，作出承诺及说明。**',
  ].join('\n'));

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].clauseNo, '第三章 采购需求 十二、售后服务要求');
  assert.equal(result.rows[0].requirementTitle, '售后服务要求');
  assert.doesNotMatch(result.rows[0].requirementMarkdown, /十二、售后服务要求/);
  assert.match(result.rows[0].requirementMarkdown, /本项目为交钥匙工程/);
  assert.match(result.rows[0].requirementMarkdown, /对于上述项目要求/);
});

test('测评内容和方法父章节整体聚合子项，避免标题空行', () => {
  const result = extract([
    '## 第三章 采购需求',
    '',
    '六、网络安全等级保护测评内容和方法',
    '',
    '1、测评内容',
    '',
    '测评内容包括安全物理环境、安全通信网络等。',
    '',
    '2、测评流程',
    '',
    '网络安全等级测评分为四个过程，具体如下图所示：',
    '',
    '3、整体测评',
    '',
    '整体测评应综合分析各层面风险。',
    '',
    '七、服务要求',
    '',
    '供应商应按期完成服务。',
  ].join('\n'));

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].aggregation, 'method-content');
  assert.equal(result.rows[0].clauseNo, '第三章 采购需求 六、网络安全等级保护测评内容和方法');
  assert.match(result.rows[0].requirementMarkdown, /1、测评内容/);
  assert.match(result.rows[0].requirementMarkdown, /2、测评流程/);
  assert.match(result.rows[0].requirementMarkdown, /3、整体测评/);
  assert.match(result.rows[0].requirementMarkdown, /图片未保留/);
  assert.equal(result.rows[1].clauseNo, '第三章 采购需求 七、服务要求');
  assert.equal(result.uncoveredBlockIds.length, 0);
  assert.equal(result.duplicateBlockIds.length, 0);
});

test('参考文件条款把 Markdown 连字符还原为项目符号', () => {
  const result = extract([
    '## 第三章 采购需求',
    '',
    '四、参考文件',
    '',
    '-   《GB/T 22239-2019 信息安全技术 网络安全等级保护基本要求》',
    '',
    '-   《GB/T 28448-2019 信息安全技术 网络安全等级保护测评要求》',
  ].join('\n'));

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].clauseNo, '第三章 采购需求 四、参考文件');
  assert.match(result.rows[0].requirementMarkdown, /^◆ 《GB\/T 22239-2019/m);
  assert.match(result.rows[0].requirementMarkdown, /^◆ 《GB\/T 28448-2019/m);
  assert.doesNotMatch(result.rows[0].requirementMarkdown, /^-\s+/m);
});

test('技术规范书应答偏离表按一级条款聚合小数子条款', () => {
  const markdown = [
    '## 第五章 技术规范书',
    '',
    '1.总则',
    '',
    '1.1 本技术需求书条款所提出的各项要求，是本次信息系统安全等级保护测评依据参选人应根据本文件中的相关说明和要求，提供方案。',
    '',
    '1.2 参选人在测评方案书中，对能提供的信息系统安全等级保护测评进行说明，可根据具体情况在项目方案中提出建议，并附详细资料和说明。',
    '',
    '1.3 参选人应对提供信息系统安全等级保护测评时所使用的设备及软件保证拥有设备软硬件的知识产权和所有权。',
    '',
    '2.依据政策及标准',
    '',
    '- 《信息安全等级保护管理办法》',
    '',
    '3.测评范围',
    '',
    '<table>',
    '<tr><th>序号</th><th>系统名称</th></tr>',
    '<tr><td>1</td><td>业务系统</td></tr>',
    '</table>',
    '',
    '5.实施流程',
    '',
    '测评实施流程说明。',
    '',
    '6.技术服务要求',
    '',
    '技术服务要求说明。',
    '',
    '7、项目成果要求',
    '',
    '项目成果要求说明。',
  ].join('\n');
  const blocks = parseTenderBlocks(markdown);
  const result = extractRequirements(blocks, {
    blockIds: blocks.map((block) => block.id),
    sourceChapterTitle: '第五章 技术规范书',
    templateTitle: '4.技术规范书应答偏离表',
  });

  assert.deepEqual(result.rows.map((row) => row.clauseNo), [
    '第五章 技术规范书 1.总则',
    '第五章 技术规范书 2.依据政策及标准',
    '第五章 技术规范书 3.测评范围',
    '第五章 技术规范书 5.实施流程',
    '第五章 技术规范书 6.技术服务要求',
    '第五章 技术规范书 7、项目成果要求',
  ]);
  assert.match(result.rows[0].requirementMarkdown, /1\.1 本技术需求书条款/);
  assert.match(result.rows[0].requirementMarkdown, /1\.2 参选人在测评方案书中/);
  assert.match(result.rows[0].requirementMarkdown, /1\.3 参选人应对提供信息系统安全等级保护测评/);
  assert.doesNotMatch(result.rows.map((row) => row.requirementMarkdown).join('\n'), /\*\*/);
  assert.match(result.rows[2].requirementMarkdown, /业务系统/);
  assert.doesNotMatch(result.rows[2].requirementMarkdown, /5\.实施流程/);
  assert.equal(result.uncoveredBlockIds.length, 0);
  assert.equal(result.duplicateBlockIds.length, 0);
});

test('技术规范书应答偏离表不因小数子条款被解析为标题而拆行', () => {
  const markdown = [
    '## 第五章 技术规范书',
    '',
    '### 1.总则',
    '',
    '#### 1.1 本技术需求书条款所提出的各项要求，是本次信息系统安全等级保护测评依据参选人应根据本文件中的相关说明和要求，提供方案。',
    '',
    '#### 1.2 参选人在测评方案书中，对能提供的信息系统安全等级保护测评进行说明，可根据具体情况在项目方案中提出建议，并附详细资料和说明。',
    '',
    '#### 1.3 参选人应对提供信息系统安全等级保护测评时所使用的设备及软件保证拥有设备软硬件的知识产权和所有权。',
    '',
    '### 2.依据政策及标准',
    '',
    '政策标准正文。',
  ].join('\n');
  const blocks = parseTenderBlocks(markdown);
  const result = extractRequirements(blocks, {
    blockIds: blocks.map((block) => block.id),
    sourceChapterTitle: '第五章 技术规范书',
    templateTitle: '4.技术规范书应答偏离表',
  });

  assert.deepEqual(result.rows.map((row) => row.clauseNo), [
    '第五章 技术规范书 1.总则',
    '第五章 技术规范书 2.依据政策及标准',
  ]);
  assert.match(result.rows[0].requirementMarkdown, /1\.1 本技术需求书条款/);
  assert.match(result.rows[0].requirementMarkdown, /1\.2 参选人在测评方案书中/);
  assert.match(result.rows[0].requirementMarkdown, /1\.3 参选人应对提供信息系统安全等级保护测评/);
});
