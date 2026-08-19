import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMirrorOutlineSubtree,
  normalizeMirrorTextForCarry,
  refineMirrorTreeForOutline,
  type MirrorTreeNode,
} from './mirrorProcurement';

test('镜像搬运时将连续标准规范书名号清单拆成逐项换行', () => {
  const source = '《GB/T 20272—2006 信息安全技术 操作系统安全技术要求》 《GB/T 20273—2006 信息安全技术 数据库管理系统安全技术要求》 《信息安全等级保护管理办法》（公通字〔2007〕43 号文件）';

  assert.equal(normalizeMirrorTextForCarry(source), [
    '《GB/T 20272—2006 信息安全技术 操作系统安全技术要求》',
    '《GB/T 20273—2006 信息安全技术 数据库管理系统安全技术要求》',
    '《信息安全等级保护管理办法》（公通字〔2007〕43 号文件）',
  ].join('\n\n'));
});

test('镜像结构后处理将实施原则短条目压回正文而不是生成多级标题', () => {
  const tree: MirrorTreeNode = {
    title: '服务需求',
    children: [
      {
        title: '实施原则',
        children: [
          { title: '保密原则', sourceText: '保密原则：对测评的过程数据和结果数据严格保密，未经授权不得泄露给任何单位和个人。' },
          { title: '标准性原则', sourceText: '标准性原则：测评方案的设计与实施应依据国家信息系统安全等级保护的相关标准进行。' },
          { title: '规范性原则', sourceText: '规范性原则：工作中的过程和文档，具有很好的规范性。' },
        ],
      },
    ],
  };

  const refined = refineMirrorTreeForOutline(tree);
  const principle = refined.children?.[0];
  assert.equal(principle?.title, '实施原则');
  assert.equal(principle?.children, undefined);
  assert.match(principle?.sourceText || '', /保密原则：对测评的过程数据和结果数据严格保密/);
  assert.match(principle?.sourceText || '', /标准性原则：测评方案的设计与实施应依据国家信息系统安全等级保护/);

  const outline = buildMirrorOutlineSubtree(refined, '项目概述');
  const principleOutline = outline.children?.[0];
  assert.equal(principleOutline?.title, '实施原则');
  assert.equal(principleOutline?.children, undefined);
  assert.match(principleOutline?.mirrorSourceText || '', /规范性原则：工作中的过程和文档/);
});

test('镜像目录落库前修复表格序号列空值', () => {
  const tree: MirrorTreeNode = {
    title: '服务需求',
    children: [
      {
        title: '安全物理环境测评',
        sourceText: [
          '<table><thead><tr><th>序号</th><th>安全子类</th><th>测评指标描述</th></tr></thead><tbody>',
          '<tr><td></td><td><p>物理位置选择</p></td><td><p>检查机房位置。</p></td></tr>',
          '<tr><td>  </td><td><p>物理访问控制</p></td><td><p>检查出入口。</p></td></tr>',
          '<tr><td><p>3</p></td><td><p>防盗窃和防破坏</p></td><td><p>检查防盗。</p></td></tr>',
          '</tbody></table>',
        ].join(''),
      },
    ],
  };

  const outline = buildMirrorOutlineSubtree(tree, '项目概述');
  const sourceText = outline.children?.[0]?.mirrorSourceText || '';

  assert.match(sourceText, /<td><p>1<\/p><\/td><td><p>物理位置选择<\/p><\/td>/);
  assert.match(sourceText, /<td><p>2<\/p><\/td><td><p>物理访问控制<\/p><\/td>/);
  assert.match(sourceText, /<td><p>3<\/p><\/td><td><p>防盗窃和防破坏<\/p><\/td>/);
});

test('镜像表格序号修复不会改动列数不一致的说明行', () => {
  const tree: MirrorTreeNode = {
    title: '服务需求',
    children: [
      {
        title: '测评指标',
        sourceText: [
          '<table><tbody>',
          '<tr><td>序号</td><td>安全子类</td><td>测评指标描述</td></tr>',
          '<tr><td colspan="3">说明：下列内容仅供参考</td></tr>',
          '<tr><td></td><td>物理位置选择</td><td>检查机房位置。</td></tr>',
          '</tbody></table>',
        ].join(''),
      },
    ],
  };

  const outline = buildMirrorOutlineSubtree(tree, '项目概述');
  const sourceText = outline.children?.[0]?.mirrorSourceText || '';

  assert.match(sourceText, /<td colspan="3">说明：下列内容仅供参考<\/td>/);
  assert.match(sourceText, /<td><p>1<\/p><\/td><td>物理位置选择<\/td>/);
});
