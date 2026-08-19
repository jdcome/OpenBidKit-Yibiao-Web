import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeSubjectIdentity,
  buildSubjectIdentityReplacements,
  shouldBlockSubjectIdentityBeforeNext,
  shouldPromptSubjectIdentityConfirmation,
} from './subjectIdentity';

test('识别医院采购人自称并返回证据片段', () => {
  const analysis = analyzeSubjectIdentity({
    bidderName: '内蒙古思沃科技有限公司',
    buyerName: '永州市中心医院',
    tenderMarkdown: '免费提供信息安全相关的咨询与建议，并参与我院信息安全长期规划的制定。质保期内，乙方接到甲方故障报修通知后处理。',
    existingReplacements: [],
  });

  const buyerAliases = analysis.buyer.aliases.map((item) => item.alias);
  assert.ok(buyerAliases.includes('我院'));
  const hospitalAlias = analysis.buyer.aliases.find((item) => item.alias === '我院');
  assert.equal(hospitalAlias?.confidence, 'high');
  assert.equal(hospitalAlias?.needsReview, false);
  assert.match(hospitalAlias?.evidence || '', /参与我院信息安全长期规划/);

  const replacements = buildSubjectIdentityReplacements({
    bidderName: '内蒙古思沃科技有限公司',
    buyerName: '永州市中心医院',
    tenderMarkdown: analysis.tenderMarkdown,
    existingReplacements: [],
  });
  assert.deepEqual(replacements, [
    { fullname: '内蒙古思沃科技有限公司', synonyms: ['中标人', '供应商', '投标人', '我方', '乙方', '成交人'] },
    { fullname: '永州市中心医院', synonyms: ['采购人', '招标人', '甲方', '我院'] },
  ]);
});

test('招标文件出现我方时保留在我方组但标记需确认', () => {
  const analysis = analyzeSubjectIdentity({
    bidderName: '湖南金盾信息评估中心有限公司',
    buyerName: '长沙市图书馆',
    tenderMarkdown: '合同条款中写明：我方负责验收，中标人应配合采购人完成项目交付。',
    existingReplacements: [],
  });

  const bidderAlias = analysis.bidder.aliases.find((item) => item.alias === '我方');
  assert.equal(bidderAlias?.group, 'bidder');
  assert.equal(bidderAlias?.needsReview, true);
  assert.equal(bidderAlias?.reason, '招标文件中出现“我方”，需确认它是否代表投标方。');
  assert.match(bidderAlias?.evidence || '', /我方负责验收/);
});

test('默认投标人侧代称包含成交人', () => {
  const replacements = buildSubjectIdentityReplacements({
    bidderName: '湖南金盾信息评估中心有限公司',
    buyerName: '长沙市图书馆',
    tenderMarkdown: '采购人：长沙市图书馆。',
    existingReplacements: [],
  });

  assert.deepEqual(replacements[0]?.synonyms, ['中标人', '供应商', '投标人', '我方', '乙方', '成交人']);
});

test('已有替换表优先，不重复加入已存在代称', () => {
  const replacements = buildSubjectIdentityReplacements({
    bidderName: '甲公司',
    buyerName: '乙医院',
    tenderMarkdown: '我院将组织验收，供应商应响应。',
    existingReplacements: [
      { fullname: '甲公司', synonyms: ['供应商'] },
      { fullname: '乙医院', synonyms: ['采购人', '我院'] },
    ],
  });

  assert.deepEqual(replacements, [
    { fullname: '甲公司', synonyms: ['供应商', '中标人', '投标人', '我方', '乙方', '成交人'] },
    { fullname: '乙医院', synonyms: ['采购人', '我院', '招标人', '甲方'] },
  ]);
});

test('已有替换表但本项目尚未确认过主体时仍应主动提示', () => {
  assert.equal(shouldPromptSubjectIdentityConfirmation({
    bidderName: '内蒙古思沃科技有限公司',
    buyerName: '永州市中心医院',
    tenderMarkdown: '采购人：永州市中心医院。我院将组织项目验收。',
    existingReplacements: [
      { fullname: '内蒙古思沃科技有限公司', synonyms: ['中标人', '供应商'] },
      { fullname: '永州市中心医院', synonyms: ['采购人', '我院'] },
    ],
    promptStatus: null,
  }), true);

  assert.equal(shouldPromptSubjectIdentityConfirmation({
    bidderName: '内蒙古思沃科技有限公司',
    buyerName: '永州市中心医院',
    tenderMarkdown: '采购人：永州市中心医院。我院将组织项目验收。',
    existingReplacements: [
      { fullname: '内蒙古思沃科技有限公司', synonyms: ['中标人', '供应商'] },
      { fullname: '永州市中心医院', synonyms: ['采购人', '我院'] },
    ],
    promptStatus: 'confirmed',
  }), false);
});

test('进入正文生成前只接受已确认状态，稍后处理仍需拦截', () => {
  assert.equal(shouldBlockSubjectIdentityBeforeNext(null), true);
  assert.equal(shouldBlockSubjectIdentityBeforeNext('dismissed'), true);
  assert.equal(shouldBlockSubjectIdentityBeforeNext('confirmed'), false);
});
