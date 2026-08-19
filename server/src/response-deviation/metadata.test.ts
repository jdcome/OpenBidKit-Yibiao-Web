import assert from 'node:assert/strict';
import test from 'node:test';
import { extractProjectFields, extractTemplateSchema, sanitizeProjectFieldPatch } from './metadata';
import { parseTenderBlocks } from './structure';

test('优先复用 STEP02 字段并补充项目编号、采购编号和包信息', () => {
  const fields = extractProjectFields({
    fileName: '采购文件.docx',
    markdown: '项目名称：网络安全测评\n项目编号：XM-01\n政府采购编号：湘财采计[2026]9号\n包号：第2包',
    selectedSectionTitle: '第二包 数据分类分级服务',
    analysis: { projectInfo: { content: '项目名称：网络安全测评\n项目编号：XM-01' } },
  } as never);
  assert.equal(fields.projectName.value, '网络安全测评');
  assert.equal(fields.projectNumber.value, 'XM-01');
  assert.equal(fields.procurementNumber.value, '湘财采计[2026]9号');
  assert.equal(fields.packageNumber.value, '第2包');
  assert.match(fields.packageName.value, /数据分类分级服务/);
});

test('项目字段清洗 Markdown 转义且不把 HTML 表格识别为包名称', () => {
  const fields = extractProjectFields({
    fileName: '采购文件.docx',
    markdown: [
      '项目名称：网络安全测评',
      '项目编号：ZTFZB1-20261591**',
      '政府采购编号：湘财采计\\[2026\\]000281号',
      '包名称：<table><tbody><tr><td><p>序号</p></td><td><p>磋商文件条目号</p></td></tr></tbody></table>',
    ].join('\n'),
    selectedSectionTitle: '包1',
    analysis: {},
  } as never);
  assert.equal(fields.projectNumber.value, 'ZTFZB1-20261591');
  assert.equal(fields.procurementNumber.value, '湘财采计[2026]000281号');
  assert.equal(fields.packageName.value, '');
  assert.equal(fields.packageNumber.value, '1');
});

test('当前选择包号可从包1标题继承为纯数字，包名称无名称时留空', () => {
  const fields = extractProjectFields({
    fileName: '采购文件.docx',
    markdown: '项目名称：网络安全测评\n项目编号：XM-01',
    selectedSectionTitle: '包1',
    analysis: {},
  } as never);
  assert.equal(fields.packageNumber.value, '1');
  assert.equal(fields.packageName.value, '');
});

test('空包号后紧跟包名称标签时不把字段名当成包号', () => {
  const fields = extractProjectFields({
    fileName: '采购文件.docx',
    markdown: '项目名称：网络安全测评\n包号： 包名称：',
    selectedSectionTitle: '包1',
    analysis: {},
  } as never);
  assert.equal(fields.packageNumber.value, '1');
  assert.equal(fields.packageName.value, '');
});

test('响应文件模板中的空采购代理编号不误识别为项目编号', () => {
  const fields = extractProjectFields({
    fileName: '采购文件.docx',
    markdown: '我方已仔细研究了 (项目名称)的竞争性磋商文件（政府采购编号： ；采购代理编号： ）的全部内容，知悉参加竞争性磋商的风险，我方承诺接受磋商文件的全部条款且无任何异议。',
    selectedSectionTitle: '包1',
    analysis: {},
  } as never);
  assert.equal(fields.projectNumber.value, '');
  assert.equal(fields.projectNumber.source, 'empty');
});

test('手动保存项目字段时也过滤响应文件模板泄漏的项目编号', () => {
  const patch = sanitizeProjectFieldPatch({
    projectNumber: {
      value: '）的全部内容，知悉参加竞争性磋商的风险，我方承诺接受磋商文件的全部条款且无任何异议。',
      source: 'manual',
      evidence: '采购代理编号： ）的全部内容，知悉参加竞争性磋商的风险',
    },
  });
  assert.deepEqual(patch, {
    projectNumber: {
      value: '',
      source: 'manual',
      evidence: '采购代理编号： ）的全部内容，知悉参加竞争性磋商的风险',
    },
  });
});

test('从招标原表识别列名且保留人工响应列为空', () => {
  const blocks = parseTenderBlocks(`## 四、采购需求响应程度

| 序号 | 磋商文件条目号 | 招标文件要求 | 响应文件的规格 | 响应与偏离 | 偏离说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 3.1 | 原要求 | | | |
`);
  const schema = extractTemplateSchema(blocks, '四、采购需求响应程度');
  assert.deepEqual(schema.columns, ['序号', '磋商文件条目号', '招标文件要求', '响应文件的规格', '响应与偏离', '偏离说明']);
  assert.equal(schema.detected, true);
});

test('技术规范书应答偏离表只保留招标原表的五列表头', () => {
  const blocks = parseTenderBlocks(`**4.技术规范书应答偏离表**

| 序号 | 比选文件条目号 | 比选文件对应的内容 | 参选文件偏离情况 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 第五章 技术规范书 | 技术规范正文 | 无偏离 | / |
`);
  const schema = extractTemplateSchema(blocks, '技术规范书应答偏离表');
  assert.equal(schema.detected, true);
  assert.deepEqual(schema.columns, ['序号', '比选文件条目号', '比选文件对应的内容', '参选文件偏离情况', '说明']);
});

test('技术规范书应答偏离表存在目录项时仍定位后文真实 HTML 原表', () => {
  const blocks = parseTenderBlocks(`4.技术规范书应答偏离表 102

## 第五章 技术规范书

1.总则

1.1 本技术需求书条款所提出的各项要求，是本次信息系统安全等级保护测评依据参选人应根据本文件中的相关说明和要求，提供方案。

${Array.from({ length: 28 }, (_, index) => `过渡正文 ${index + 1}`).join('\n\n')}

**4.技术规范书应答偏离表**

**技术规范书应答偏离表**

项目名称： 比选编号： 分包（采购包）： /

<table><tbody><tr><td><p>序号</p></td><td><p>比选文件条目号</p></td><td><p>比选文件对应的内容</p></td><td><p>参选文件偏离情况</p></td><td><p>说明</p></td></tr><tr><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>

注：1.参选人应当逐条对照比选文件技术规范书。
`);
  const schema = extractTemplateSchema(blocks, '技术规范书应答偏离表');
  assert.equal(schema.detected, true);
  assert.equal(schema.source, 'html-table');
  assert.deepEqual(schema.columns, ['序号', '比选文件条目号', '比选文件对应的内容', '参选文件偏离情况', '说明']);
  assert.match(schema.prefixMarkdown || '', /项目名称/);
  assert.match(schema.suffixMarkdown || '', /逐条对照/);
  assert.doesNotMatch(`${schema.prefixMarkdown || ''}\n${schema.suffixMarkdown || ''}`, /\*\*/);
});

test('识别偏离表模板字段区、原始表头和表后说明签章区', () => {
  const blocks = parseTenderBlocks(`## 四、技术/商务响应与偏离表

政府采购编号：________________     项目名称：________________

包号：________     包名称：________________

| 序号 | 磋商文件条目号 | 采购规格/商务条款 | 响应文件的规格/商务条款 | 响应与偏离 | 说明 |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

说明：1、“响应与偏离”应注明“响应”或“偏离”。

2、属磋商文件规定可能变动的内容在“说明”栏中注明。

供应商名称（盖单位章）：________________

法定代表人或其委托代理人（签字）：________________

日期：____ 年 ____ 月 ____ 日

## 五、其他格式
`);
  const schema = extractTemplateSchema(blocks, '四、技术/商务响应与偏离表');
  assert.equal(schema.detected, true);
  assert.equal(schema.source, 'markdown-table');
  assert.deepEqual(schema.columns, ['序号', '磋商文件条目号', '采购规格/商务条款', '响应文件的规格/商务条款', '响应与偏离', '说明']);
  assert.match(schema.prefixMarkdown || '', /政府采购编号/);
  assert.match(schema.prefixMarkdown || '', /包名称/);
  assert.match(schema.suffixMarkdown || '', /响应与偏离/);
  assert.match(schema.suffixMarkdown || '', /供应商名称/);
  assert.doesNotMatch(schema.suffixMarkdown || '', /五、其他格式/);
});

test('HTML 偏离表只使用首行作为模板表头', () => {
  const blocks = parseTenderBlocks(`## 四、技术响应与偏离表

<table><tbody><tr><td>序号</td><td>磋商文件条目号</td><td>采购规格/商务条款</td><td>响应文件的规格/商务条款</td><td>响应与偏离</td><td>说明</td></tr><tr><td>1</td><td>一</td><td>正文</td><td></td><td></td><td></td></tr></tbody></table>
`);
  const schema = extractTemplateSchema(blocks, '四、技术响应与偏离表');
  assert.deepEqual(schema.columns, ['序号', '磋商文件条目号', '采购规格/商务条款', '响应文件的规格/商务条款', '响应与偏离', '说明']);
});

test('标题格式不完全一致时可按偏离表表头语义兜底识别模板', () => {
  const blocks = parseTenderBlocks(`## 四、 技术 / 商务响应与偏离表

政府采购编号：________  项目名称：________

| 序号 | 磋商文件条目号 | 采购规格/商务条款 | 响应文件的规格/商务条款 | 响应与偏离 | 说明 |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

说明：1、“响应与偏离”应注明“响应”或“偏离”。
`);
  const schema = extractTemplateSchema(blocks, '四、技术/商务响应与偏离表');
  assert.equal(schema.detected, true);
  assert.deepEqual(schema.columns, ['序号', '磋商文件条目号', '采购规格/商务条款', '响应文件的规格/商务条款', '响应与偏离', '说明']);
  assert.match(schema.prefixMarkdown || '', /政府采购编号/);
  assert.match(schema.suffixMarkdown || '', /响应与偏离/);
});

test('粗体表单标题作为模板边界时不吞入上一表签章或下一份表单', () => {
  const blocks = parseTenderBlocks(`供应商名称（盖单位章）：

法定代表人或其委托代理人(签字)：____

**四、技术/商务响应与偏离表**

政府采购编号： 项目名称：

包号： 包名称：

<table><tbody><tr><td>序号</td><td>磋商文件条目号</td><td>采购规格/商务条款</td><td>响应文件的规格/商务条款</td><td>响应与偏离</td><td>说明</td></tr><tr><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>

说明：1、“响应与偏离”应注明“响应”或“偏离”。

供应商名称（盖单位章）：

日期：____ 年 ____ 月 ____ 日

**五、提供享受政府采购政策的证明材料和清单表**

附件8-1

**中小企业声明函**
`);
  const schema = extractTemplateSchema(blocks, '四、技术/商务响应与偏离表');
  assert.equal(schema.detected, true);
  assert.equal(schema.source, 'html-table');
  assert.deepEqual(schema.columns, ['序号', '磋商文件条目号', '采购规格/商务条款', '响应文件的规格/商务条款', '响应与偏离', '说明']);
  assert.match(schema.prefixMarkdown || '', /政府采购编号/);
  assert.doesNotMatch(schema.prefixMarkdown || '', /法定代表人/);
  assert.match(schema.suffixMarkdown || '', /供应商名称/);
  assert.doesNotMatch(schema.suffixMarkdown || '', /中小企业声明函/);
});
