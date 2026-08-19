// 代称替换层单元测试（standalone tsx 断言脚本，无测试框架依赖）。
// 运行：cd server && npx tsx src/tasks/utils/subjectReplacement.test.ts
// 覆盖 spec §9：正向 / 防误伤 / 长同义词优先 / 幂等 / 空入参 / 多组共存。

import {
  type SubjectReplacement,
  normalizeSubjectReplacements,
  serializeSubjectReplacements,
  applySubjectReplacement,
} from './subjectReplacement';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${msg}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${msg}`);
  }
}
function assertEq<T>(actual: T, expected: T, msg: string) {
  const ok = actual === expected;
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${msg}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

const REPLACEMENTS: SubjectReplacement[] = [
  { fullname: '湖南金盾信息评估中心有限公司', synonyms: ['中标人', '供应商', '投标人', '我方'] },
  { fullname: '长沙市图书馆', synonyms: ['采购人', '招标人', '甲方'] },
];

console.log('\n[1] 正向：正常上下文应替换');
assertEq(
  applySubjectReplacement('的中标人应当按照要求提供服务', REPLACEMENTS),
  '的湖南金盾信息评估中心有限公司应当按照要求提供服务',
  '的中标人 → 的<fullname>（前导"的"不阻止）',
);
assertEq(
  applySubjectReplacement('和采购人签订合同后，中标人将进场', REPLACEMENTS),
  '和长沙市图书馆签订合同后，湖南金盾信息评估中心有限公司将进场',
  '和采购人 / 中标人将 → 两者都换',
);
assertEq(
  applySubjectReplacement('中标人，请确认', REPLACEMENTS),
  '湖南金盾信息评估中心有限公司，请确认',
  '中标人， → <fullname>，（标点边界）',
);
assertEq(
  applySubjectReplacement('我方承诺完成全部工作', REPLACEMENTS),
  '湖南金盾信息评估中心有限公司承诺完成全部工作',
  '我方 → <fullname>',
);

console.log('\n[2] 防误伤：前缀否定 / 后缀扩词不应替换');
assertEq(
  applySubjectReplacement('非中标人不得索赔', REPLACEMENTS),
  '非中标人不得索赔',
  '非中标人 不换（前缀"非"）',
);
assertEq(
  applySubjectReplacement('未中标人已通知', REPLACEMENTS),
  '未中标人已通知',
  '未中标人 不换（前缀"未"）',
);
assertEq(
  applySubjectReplacement('不中标人无权', REPLACEMENTS),
  '不中标人无权',
  '不中标人 不换（前缀"不"）',
);
assertEq(
  applySubjectReplacement('无中标人参与', REPLACEMENTS),
  '无中标人参与',
  '无中标人 不换（前缀"无"）',
);
assertEq(
  applySubjectReplacement('中标人员名单已公示', REPLACEMENTS),
  '中标人员名单已公示',
  '中标人员 不换（后缀"员"）',
);
assertEq(
  applySubjectReplacement('中标人类别', REPLACEMENTS),
  '中标人类别',
  '中标人类 不换（后缀"类"）',
);
assertEq(
  applySubjectReplacement('中标人们需注意', REPLACEMENTS),
  '中标人们需注意',
  '中标人们 不换（后缀"们"）',
);

console.log('\n[3] 长同义词优先：长者先匹配，不被短者拆解');
{
  const longFirst: SubjectReplacement[] = [
    { fullname: '甲公司', synonyms: ['中标', '中标人'] },
  ];
  assertEq(
    applySubjectReplacement('的中标人将进场', longFirst),
    '的甲公司将进场',
    '中标 + 中标人 并存：中标人 整体换，不被"中标"先拆',
  );
}

console.log('\n[4] 幂等：fullname 含某 synonym 时不在结果上二次替换');
{
  const selfRef: SubjectReplacement[] = [
    { fullname: '中标人有限公司', synonyms: ['中标人'] },
  ];
  assertEq(
    applySubjectReplacement('中标人应当按照要求，中标人有限公司负责', selfRef),
    '中标人有限公司应当按照要求，中标人有限公司负责',
    'fullname 自含 synonym：首次替换后不二次替换已替换片段',
  );
}

console.log('\n[5] 空入参：no-op');
assertEq(applySubjectReplacement('中标人应当', []), '中标人应当', '空 replacements → 原样');
assertEq(applySubjectReplacement('中标人应当', null), '中标人应当', 'null replacements → 原样');
assertEq(applySubjectReplacement('中标人应当', undefined), '中标人应当', 'undefined replacements → 原样');
assertEq(applySubjectReplacement('', REPLACEMENTS), '', '空 content → 空串');

console.log('\n[6] 多组共存：我方组 + 采购人组同时生效');
assertEq(
  applySubjectReplacement('甲方有权监督中标人，中标人对甲方负责', REPLACEMENTS),
  '长沙市图书馆有权监督湖南金盾信息评估中心有限公司，湖南金盾信息评估中心有限公司对长沙市图书馆负责',
  '甲方/中标人 交叉共存全换',
);

console.log('\n[7] normalizeSubjectReplacements：JSON 字符串 → 数组（剔空/去重）');
assertEq(
  JSON.stringify(normalizeSubjectReplacements('[{"fullname":"甲","synonyms":["x","x","y"]},{"fullname":"","synonyms":["z"]},{"fullname":"乙","synonyms":[]}]')),
  JSON.stringify([{ fullname: '甲', synonyms: ['x', 'y'] }]),
  '剔 fullname 空 / synonyms 空 / synonyms 去重',
);
assertEq(
  JSON.stringify(normalizeSubjectReplacements(null)),
  '[]',
  'null → []',
);
assertEq(
  JSON.stringify(normalizeSubjectReplacements(undefined)),
  '[]',
  'undefined → []',
);
assertEq(
  JSON.stringify(normalizeSubjectReplacements('not-json')),
  '[]',
  '非法 JSON → []',
);
assertEq(
  JSON.stringify(normalizeSubjectReplacements([{ fullname: '甲', synonyms: ['x'] }])),
  JSON.stringify([{ fullname: '甲', synonyms: ['x'] }]),
  '已是数组直通',
);
{
  const ok = normalizeSubjectReplacements([{ fullname: '甲', synonyms: ['x', '甲'] }]);
  assert(ok.length === 1 && ok[0].synonyms.length === 1, 'synonym 等于 fullname 时剔除该 synonym');
}

console.log('\n[8] serializeSubjectReplacements：数组 ↔ JSON 字符串（空→null）');
assertEq(serializeSubjectReplacements([]), null, '空数组 → null');
assertEq(serializeSubjectReplacements(null), null, 'null → null');
assertEq(
  serializeSubjectReplacements([{ fullname: '甲', synonyms: ['x'] }]),
  '[{"fullname":"甲","synonyms":["x"]}]',
  '非空 → JSON 字符串',
);

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) {
  process.exit(1);
}
