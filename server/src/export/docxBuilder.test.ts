import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { buildDocxResult } from './docxBuilder';

function readZipEntry(buffer: Buffer, entryName: string): string {
  let offset = 0;
  while (offset + 30 < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataStart = nameStart + fileNameLength + extraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    if (name === entryName) {
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      throw new Error(`Unsupported zip compression method: ${method}`);
    }
    offset = dataStart + compressedSize;
  }
  return '';
}

test('技术方案导出对投标主体替换结果插入核对批注', async () => {
  const result = await buildDocxResult({
    project_name: '批注测试项目',
    subject_replacement_comment_terms: ['湖南金盾信息评估中心有限公司'],
    outline: [{
      id: '1',
      title: '服务方案',
      content: '湖南金盾信息评估中心有限公司将按要求完成服务。',
    }],
  });

  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  const commentsXml = readZipEntry(result.buffer, 'word/comments.xml');
  assert.match(documentXml, /<w:commentReference/);
  assert.match(commentsXml, /请核对代称替换是否正确/);
});

test('HTML 表格数字序号首行不会被误设为表头', async () => {
  const result = await buildDocxResult({
    project_name: '跨页表格测试',
    outline: [{
      id: '1',
      title: '系统范围',
      content: '<table><tr><td>1</td><td>互联网医院</td><td>三级</td></tr><tr><td>2</td><td>HIS系统</td><td>三级</td></tr></table>',
    }],
  });

  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  const firstRow = documentXml.match(/<w:tr[\s\S]*?<\/w:tr>/)?.[0] || '';
  assert.match(firstRow, /互联网医院/);
  assert.doesNotMatch(firstRow, /<w:shd[^>]*w:fill="EEF5FF"/);
});

test('HTML 表格显式 th 仍使用表头样式', async () => {
  const result = await buildDocxResult({
    project_name: '显式表头测试',
    outline: [{
      id: '1',
      title: '系统范围',
      content: '<table><tr><th>序号</th><th>系统名称</th><th>系统等级</th></tr><tr><td>1</td><td>互联网医院</td><td>三级</td></tr></table>',
    }],
  });

  const documentXml = readZipEntry(result.buffer, 'word/document.xml');
  const firstRow = documentXml.match(/<w:tr[\s\S]*?<\/w:tr>/)?.[0] || '';
  assert.match(firstRow, /系统名称/);
  assert.match(firstRow, /<w:shd[^>]*w:fill="EEF5FF"/);
});
