import test from 'node:test';
import assert from 'node:assert/strict';
import type { TechnicalProposalStructureRequirement } from './technicalProposalStructure';
import type { OutlinePayload } from './outlineGenerationHelpers';
import { buildProposalStructureCoverage } from './proposalStructureCoverage';

const xmRequirement: TechnicalProposalStructureRequirement = {
  title: '九、响应方案',
  mode: 'explicit_checklist',
  aliasesMatched: ['响应方案'],
  evidence: '响应方案参考内容如下',
  items: [
    { title: '对项目的理解' },
    { title: '服务范围及内容' },
    { title: '服务工作的依据、工作目标' },
    { title: '服务机构设置（框图）、岗位职责' },
    { title: '拟投入本项目的服务人员及主要人员简历' },
    { title: '拟分包计划及情况说明' },
    { title: '服务质量、进度、保密等保证措施' },
    { title: '服务工作重点、难点分析' },
    { title: '对本项目的合理化建议' },
  ],
};

const beforeFinalGateOutline: OutlinePayload = {
  outline: [
    {
      id: 'root-service',
      title: '服务方案',
      children: [
        { id: 'n1', title: '项目特点与需求理解' },
        { id: 'n2', title: '测评范围与服务内容理解' },
        { id: 'n3', title: '服务依据与工作目标' },
        { id: 'n7', title: '服务质量、进度、保密措施' },
        { id: 'n8', title: '项目重点难点分析' },
        { id: 'n9', title: '合理化建议' },
      ],
    },
  ],
};

const finalOutline: OutlinePayload = {
  outline: [
    {
      id: 'root-service',
      title: '服务方案',
      children: [
        { id: 'n1', title: '项目特点与需求理解' },
        { id: 'n2', title: '测评范围与服务内容理解' },
        { id: 'n3', title: '服务依据与工作目标' },
        { id: 'n4', title: '项目组织与岗位职责' },
        { id: 'n5', title: '人员配置与主要人员简历' },
        { id: 'n6', title: '拟分包计划及情况说明' },
        { id: 'n7', title: '服务质量、进度、保密措施' },
        { id: 'n8', title: '项目重点难点分析' },
        { id: 'n9', title: '合理化建议' },
      ],
    },
  ],
};

test('builds XM2026 response plan coverage and marks final gate repairs', () => {
  const baseline = buildProposalStructureCoverage(xmRequirement, beforeFinalGateOutline, {
    generatedAt: new Date('2026-08-13T00:00:00.000Z'),
  });
  const coverage = buildProposalStructureCoverage(xmRequirement, finalOutline, {
    baseline,
    generatedAt: new Date('2026-08-13T00:10:00.000Z'),
  });

  assert.ok(coverage);
  assert.equal(coverage.total, 9);
  assert.equal(coverage.covered_total, 9);
  assert.equal(coverage.repaired, 3);
  assert.equal(coverage.missing, 0);
  assert.deepEqual(
    coverage.items.filter((item) => item.status === 'repaired').map((item) => item.index),
    [4, 5, 6],
  );
  assert.equal(coverage.items[0].matches[0].node_id, 'n1');
  assert.match(coverage.items[3].evidence, /最终审核前未充分覆盖/);
});

test('marks missing response requirement when final outline has no match', () => {
  const requirement: TechnicalProposalStructureRequirement = {
    title: '技术方案',
    mode: 'explicit_checklist',
    aliasesMatched: ['技术方案'],
    evidence: '',
    items: [{ title: '驻场服务安排' }],
  };
  const coverage = buildProposalStructureCoverage(requirement, {
    outline: [{ id: 'only', title: '项目理解' }],
  });

  assert.ok(coverage);
  assert.equal(coverage.missing, 1);
  assert.equal(coverage.items[0].status, 'missing');
});

test('returns null for self-defined or absent response plan requirement', () => {
  assert.equal(buildProposalStructureCoverage({ ...xmRequirement, mode: 'self_defined', items: [] }, finalOutline), null);
  assert.equal(buildProposalStructureCoverage(null, finalOutline), null);
});
