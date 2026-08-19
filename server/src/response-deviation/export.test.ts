import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { buildResponseDeviationDocx, validateResponseDeviationExport } from './export';

function readZipEntry(buffer: Buffer, filename: string): string {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(centralOffset), 0x02014b50);
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const entryName = buffer.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLength);
    if (entryName === filename) {
      assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      throw new Error(`Unsupported zip compression method: ${method}`);
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Zip entry not found: ${filename}`);
}

test('导出确认后的技术响应与偏离表并保留项目原则换行', async () => {
  const result = await buildResponseDeviationDocx({
    status: 'confirmed', templateTitle: '采购需求响应程度',
    projectFieldsJson: { projectName: { value: '测试项目' }, projectNumber: { value: 'XM-1' } },
    rows: [{ sequenceNo: '1', clauseNo: '三、项目原则', requirementMarkdown: '（1）标准性原则\n\n（2）规范性原则', responseText: '', deviationStatus: '', deviationExplanation: '' }],
  } as never);
  assert.ok(result.buffer.length > 1_000);
  assert.equal(result.buffer.subarray(0, 2).toString(), 'PK');
  assert.match(result.filename, /测试项目/);
});

test('导出的偏离表默认水平居中和垂直居中', async () => {
  const result = await buildResponseDeviationDocx({
    status: 'confirmed', templateTitle: '技术响应与偏离表',
    projectFieldsJson: { projectName: { value: '测试项目' } },
    rows: [{
      sequenceNo: '1',
      clauseNo: '第四章 采购需求 二、项目目标',
      requirementMarkdown: '项目目标说明',
      responseText: '完全响应',
      deviationStatus: '无偏离',
      deviationExplanation: '无',
    }],
  } as never);
  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  assert.match(documentXml, /<w:jc w:val="center"\/>/);
  assert.match(documentXml, /<w:vAlign w:val="center"\/>/);
});

test('导出的招标文件要求保留参考文件项目符号', async () => {
  const result = await buildResponseDeviationDocx({
    status: 'confirmed', templateTitle: '技术响应与偏离表',
    projectFieldsJson: { projectName: { value: '测试项目' } },
    rows: [{
      sequenceNo: '1',
      clauseNo: '第四章 采购需求 四、参考文件',
      requirementMarkdown: '◆ 《GB/T 22239-2019 信息安全技术 网络安全等级保护基本要求》\n\n◆ 《GB/T 28448-2019 信息安全技术 网络安全等级保护测评要求》',
      responseText: '',
      deviationStatus: '',
      deviationExplanation: '',
    }],
  } as never);
  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  assert.match(documentXml, /◆ 《GB\/T 22239-2019/);
  assert.doesNotMatch(documentXml, />-\s*《GB\/T 22239-2019/);
});

test('导出的招标文件要求保留图片缺失提示', async () => {
  const result = await buildResponseDeviationDocx({
    status: 'confirmed', templateTitle: '技术响应与偏离表',
    projectFieldsJson: { projectName: { value: '测试项目' } },
    rows: [{
      sequenceNo: '1',
      clauseNo: '第四章 采购需求 六、网络安全等级保护测评内容和方法',
      requirementMarkdown: '网络安全等级测评分为四个过程，具体如下图所示：\n\n【图片未保留：招标文件原文此处疑似包含图片，当前解析结果未保存图片，请人工核对原文件并补充。】',
      responseText: '',
      deviationStatus: '',
      deviationExplanation: '',
    }],
  } as never);
  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  assert.match(documentXml, /图片未保留/);
});

test('导出的原文 HTML 表格保留横向和纵向合并单元格', async () => {
  const result = await buildResponseDeviationDocx({
    status: 'confirmed', templateTitle: '技术响应与偏离表',
    projectFieldsJson: { projectName: { value: '测试项目' } },
    rows: [{
      sequenceNo: '1',
      clauseNo: '第四章 采购需求 七、服务内容',
      requirementMarkdown: '<table><tr><th rowspan="2">项目</th><th colspan="2">要求</th></tr><tr><td>内容</td><td>说明</td></tr></table>',
      responseText: '',
      deviationStatus: '',
      deviationExplanation: '',
    }],
  } as never);
  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  assert.match(documentXml, /<w:gridSpan w:val="2"\/>/);
  assert.match(documentXml, /<w:vMerge w:val="restart"\/>/);
  assert.match(documentXml, /<w:vMerge w:val="continue"\/>/);
});

test('未确认工作区不允许正式导出', async () => {
  await assert.rejects(() => buildResponseDeviationDocx({ status: 'review', rows: [] } as never), /确认招标侧内容/);
});

test('导出使用招标文件原始偏离表表头并保留表后说明签章区', async () => {
  const result = await buildResponseDeviationDocx({
    status: 'confirmed',
    templateTitle: '四、技术/商务响应与偏离表',
    selectedSectionTitle: '包1',
    templateSchemaJson: {
      detected: true,
      columns: ['序号', '磋商文件条目号', '采购规格/商务条款', '响应文件的规格/商务条款', '响应与偏离', '说明'],
      prefixMarkdown: '政府采购编号：________     项目名称：________\n包号：________     包名称：________',
      suffixMarkdown: '说明：1、“响应与偏离”应注明“响应”或“偏离”。\n2、属磋商文件规定可能变动的内容在“说明”栏中注明。\n供应商名称（盖单位章）：________\n法定代表人或其委托代理人（签字）：________\n日期：____ 年 ____ 月 ____ 日',
    },
    projectFieldsJson: {
      projectName: { value: '湖南省市场监督管理局2026年度信息系统等保及密码测评服务' },
      procurementNumber: { value: '湘财采计\\[2026\\]000281号' },
      packageNumber: { value: '1' },
      packageName: { value: '' },
      projectNumber: { value: '' },
    },
    rows: [{
      sequenceNo: '1',
      clauseNo: '第四章 采购需求 二、项目目标',
      requirementMarkdown: '**项目目标：**完成测评服务。',
      responseText: '',
      deviationStatus: '',
      deviationExplanation: '',
    }],
  } as never);
  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  assert.match(documentXml, /磋商文件条目号/);
  assert.match(documentXml, /采购规格\/商务条款/);
  assert.match(documentXml, /响应文件的规格\/商务条款/);
  assert.match(documentXml, /供应商名称/);
  assert.match(documentXml, /湘财采计\[2026\]000281号/);
  assert.doesNotMatch(documentXml, /招标文件条目号/);
  assert.doesNotMatch(documentXml, /招标文件要求/);
  assert.doesNotMatch(documentXml, /\*\*/);
  assert.doesNotMatch(documentXml, /\\\[2026\\\]/);
});

test('五列技术规范书应答偏离表导出不补系统默认列名', async () => {
  const result = await buildResponseDeviationDocx({
    status: 'confirmed',
    templateTitle: '技术规范书应答偏离表',
    templateSchemaJson: {
      detected: true,
      columns: ['序号', '比选文件条目号', '比选文件对应的内容', '参选文件偏离情况', '说明'],
      prefixMarkdown: '项目名称：________',
      suffixMarkdown: '参选人名称：________',
    },
    projectFieldsJson: {
      projectName: { value: '测试项目', source: 'markdown' },
    },
    rows: [{
      sequenceNo: '1',
      clauseNo: '第五章 技术规范书 1.总则',
      requirementMarkdown: '技术规范正文',
      responseText: '完全响应',
      deviationStatus: '无偏离',
      deviationExplanation: '无',
    }],
  } as never);
  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  assert.match(documentXml, /比选文件条目号/);
  assert.match(documentXml, /比选文件对应的内容/);
  assert.match(documentXml, /参选文件偏离情况/);
  assert.match(documentXml, /参选人名称/);
  assert.doesNotMatch(documentXml, /招标文件条目号/);
  assert.doesNotMatch(documentXml, /招标文件要求/);
  assert.doesNotMatch(documentXml, /投标文件应答/);
  assert.doesNotMatch(documentXml, /偏离说明/);
});

test('导出时对空项目字段和系统推导字段插入 Word 批注', async () => {
  const result = await buildResponseDeviationDocx({
    status: 'confirmed',
    templateTitle: '四、技术/商务响应与偏离表',
    selectedSectionTitle: '包1',
    templateSchemaJson: {
      detected: true,
      columns: ['序号', '磋商文件条目号', '采购规格/商务条款', '响应文件的规格/商务条款', '响应与偏离', '说明'],
      prefixMarkdown: '政府采购编号：________     项目名称：________\n项目编号：________     包名称：________\n包号：________',
      suffixMarkdown: '说明：1、“响应与偏离”应注明“响应”或“偏离”。',
    },
    projectFieldsJson: {
      projectName: { value: '测试项目', source: 'markdown' },
      procurementNumber: { value: '湘财采计[2026]000281号', source: 'markdown' },
      projectNumber: { value: '', source: 'empty' },
      packageName: { value: '', source: 'empty' },
      packageNumber: { value: '1', source: 'package' },
    },
    rows: [{
      sequenceNo: '1',
      clauseNo: '第四章 采购需求 二、项目目标',
      requirementMarkdown: '项目目标说明',
      responseText: '',
      deviationStatus: '',
      deviationExplanation: '',
    }],
  } as never);
  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  const commentsXml = readZipEntry(result.buffer, 'word/comments.xml');
  assert.match(documentXml, /<w:commentReference/);
  assert.match(commentsXml, /请人工补充\/审核项目编号/);
  assert.match(commentsXml, /请人工补充\/审核包名称/);
  assert.match(commentsXml, /系统根据当前选择标段自动填充包号，请人工审核/);
  assert.doesNotMatch(commentsXml, /请人工补充\/审核项目名称/);
});

test('硬校验阻断脏字段和过长条目号', () => {
  const validation = validateResponseDeviationExport({
    status: 'confirmed',
    selectedSectionTitle: '包1',
    templateSchemaJson: {
      columns: ['序号', '磋商文件条目号', '采购规格/商务条款', '响应文件的规格/商务条款', '响应与偏离', '说明'],
      prefixMarkdown: '包号：____',
      suffixMarkdown: '供应商名称（盖单位章）：____',
    },
    projectFieldsJson: { packageName: { value: '<table><tbody></tbody></table>' }, packageNumber: { value: '2' } },
    rows: [{
      sequenceNo: '1',
      clauseNo: '第四章 采购需求 十一、付款方式 合同签订之日起计入服务期，出具所有测评报告后15个工作日内付款至合同总价的100%。采购人付款前成交供应商应出具合法有效发票。',
      requirementMarkdown: '',
    }],
  } as never);
  assert.equal(validation.status, 'error');
  assert.ok(validation.issues.some((issue) => issue.code === 'package_number_conflict'));
  assert.ok(validation.issues.some((issue) => issue.code === 'dirty_markup'));
  assert.ok(validation.issues.some((issue) => issue.code === 'clause_no_contains_body'));
  assert.ok(validation.issues.some((issue) => issue.code === 'empty_requirement'));
});

test('硬校验不因章节标题行缺少正文而阻断导出', () => {
  const validation = validateResponseDeviationExport({
    status: 'confirmed',
    selectedSectionTitle: '包1',
    templateSchemaJson: {
      columns: ['序号', '磋商文件条目号', '采购规格/商务条款', '响应文件的规格/商务条款', '响应与偏离', '说明'],
      prefixMarkdown: '包号：____',
      suffixMarkdown: '供应商名称（盖单位章）：____',
    },
    projectFieldsJson: { packageNumber: { value: '1' }, packageName: { value: '' }, projectNumber: { value: '' } },
    rows: [{
      sequenceNo: '6',
      clauseNo: '第四章 采购需求 六、网络安全等级保护测评内容和方法',
      requirementPlainText: '网络安全等级保护测评内容和方法',
      requirementTitle: '网络安全等级保护测评内容和方法',
      requirementMarkdown: '',
    }],
  } as never);
  assert.equal(validation.status, 'warning');
  assert.ok(validation.issues.some((issue) => issue.code === 'title_only_requirement'));
  assert.ok(!validation.issues.some((issue) => issue.code === 'empty_requirement'));
});
