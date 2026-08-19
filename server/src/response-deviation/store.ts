import type { ExtractedRequirementRow, ExtractionResult, ProjectTenderSourceSnapshot, ResponseDeviationAvailability } from './types';
import { sanitizeProjectFieldPatch } from './metadata';

export const RESPONSE_DEVIATION_EXTRACTOR_VERSION = '2026-08-15-v3';

export interface ExistingManualRow {
  id: string;
  clauseNo: string;
  sourceFingerprint: string;
  responseText: string;
  deviationStatus: string;
  deviationExplanation: string;
  notes: string;
  manualEdited: boolean;
}

export interface ReconciledRequirementRow extends ExtractedRequirementRow {
  responseText: string;
  deviationStatus: string;
  deviationExplanation: string;
  notes: string;
  manualEdited: boolean;
}

function manualKey(row: Pick<ExistingManualRow, 'clauseNo' | 'sourceFingerprint'>): string {
  return `${row.clauseNo}\u0000${row.sourceFingerprint}`;
}

export function reconcileGeneratedRows(existing: ExistingManualRow[], generated: ExtractedRequirementRow[]): {
  rows: ReconciledRequirementRow[];
  orphanedManualRows: ExistingManualRow[];
} {
  const existingByKey = new Map(existing.map((row) => [manualKey(row), row]));
  const used = new Set<string>();
  const rows = generated.map((row) => {
    const key = manualKey(row);
    const previous = existingByKey.get(key);
    if (previous) used.add(previous.id);
    return {
      ...row,
      responseText: previous?.responseText || '',
      deviationStatus: previous?.deviationStatus || '',
      deviationExplanation: previous?.deviationExplanation || '',
      notes: previous?.notes || '',
      manualEdited: previous?.manualEdited === true,
    };
  });
  return {
    rows,
    orphanedManualRows: existing.filter((row) => row.manualEdited && !used.has(row.id)),
  };
}

type LoosePrisma = any;

export function createResponseDeviationStore(prisma: LoosePrisma) {
  const getWorkspace = async (projectId: number) => {
    const workspace = await prisma.responseDeviationWorkspace.findUnique({ where: { projectId } });
    const rows = workspace
      ? await prisma.responseDeviationRow.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } })
      : [];
    return workspace ? { ...workspace, rows } : { projectId, status: 'empty', rows: [], generationTaskJson: null };
  };

  return {
    getWorkspace,

    async getRow(projectId: number, rowId: string) {
      return prisma.responseDeviationRow.findFirst({ where: { id: rowId, projectId } });
    },

    async saveGeneratedRows(args: {
      projectId: number;
      userId?: number;
      source: ProjectTenderSourceSnapshot;
      availability: ResponseDeviationAvailability;
      extraction: ExtractionResult;
      templateSchema?: unknown;
      projectFields?: unknown;
    }) {
      const { projectId, userId, source, availability, extraction } = args;
      await prisma.$transaction(async (tx: LoosePrisma) => {
        const [existingWorkspace, existingRows] = await Promise.all([
          tx.responseDeviationWorkspace.findUnique({ where: { projectId } }),
          tx.responseDeviationRow.findMany({ where: { projectId } }),
        ]);
        const reconciled = reconcileGeneratedRows(existingRows as ExistingManualRow[], extraction.rows);
        await tx.responseDeviationRow.deleteMany({ where: { projectId } });
        await tx.responseDeviationWorkspace.upsert({
          where: { projectId },
          create: {
            projectId,
            userId: userId ?? null,
            status: 'review',
            extractorVersion: RESPONSE_DEVIATION_EXTRACTOR_VERSION,
            tenderHash: source.tenderHash,
            selectedSectionId: source.selectedSectionId,
            selectedSectionTitle: source.selectedSectionTitle,
            templateTitle: availability.templateTitle,
            templateKind: availability.kind,
            templateSchemaJson: args.templateSchema ?? {},
            projectFieldsJson: args.projectFields ?? {},
            sourceScopeJson: {
              title: availability.sourceChapterTitle,
              blockIds: availability.sourceBlockIds,
            },
            statsJson: {
              rowCount: reconciled.rows.length,
              coveredCount: extraction.coveredBlockIds.length,
              uncoveredBlockIds: extraction.uncoveredBlockIds,
              duplicateBlockIds: extraction.duplicateBlockIds,
              orphanedManualCount: reconciled.orphanedManualRows.length,
            },
            orphanedRowsJson: reconciled.orphanedManualRows,
          },
          update: {
            userId: userId ?? existingWorkspace?.userId ?? null,
            status: 'review',
            extractorVersion: RESPONSE_DEVIATION_EXTRACTOR_VERSION,
            tenderHash: source.tenderHash,
            selectedSectionId: source.selectedSectionId,
            selectedSectionTitle: source.selectedSectionTitle,
            templateTitle: availability.templateTitle,
            templateKind: availability.kind,
            templateSchemaJson: args.templateSchema ?? existingWorkspace?.templateSchemaJson ?? {},
            projectFieldsJson: args.projectFields ?? existingWorkspace?.projectFieldsJson ?? {},
            sourceScopeJson: {
              title: availability.sourceChapterTitle,
              blockIds: availability.sourceBlockIds,
            },
            statsJson: {
              rowCount: reconciled.rows.length,
              coveredCount: extraction.coveredBlockIds.length,
              uncoveredBlockIds: extraction.uncoveredBlockIds,
              duplicateBlockIds: extraction.duplicateBlockIds,
              orphanedManualCount: reconciled.orphanedManualRows.length,
            },
            orphanedRowsJson: reconciled.orphanedManualRows,
            confirmedAt: null,
          },
        });
        if (reconciled.rows.length) {
          await tx.responseDeviationRow.createMany({
            data: reconciled.rows.map((row, index) => ({
              projectId,
              userId: userId ?? null,
              sortOrder: index,
              sequenceNo: String(index + 1),
              clauseNo: row.clauseNo,
              requirementTitle: row.requirementTitle,
              requirementMarkdown: row.requirementMarkdown,
              requirementPlainText: row.requirementPlainText,
              sourceEvidenceJson: { blockIds: row.sourceBlockIds },
              sourceFingerprint: row.sourceFingerprint,
              aggregation: row.aggregation,
              confidence: row.confidence,
              responseText: row.responseText,
              deviationStatus: row.deviationStatus,
              deviationExplanation: row.deviationExplanation,
              notes: row.notes,
              manualEdited: row.manualEdited,
            })),
          });
        }
      });
      return getWorkspace(projectId);
    },

    async patchRow(projectId: number, rowId: string, patch: Partial<Pick<ExistingManualRow, 'responseText' | 'deviationStatus' | 'deviationExplanation' | 'notes'>>) {
      const row = await prisma.responseDeviationRow.findFirst({ where: { id: rowId, projectId } });
      if (!row) throw new Error('偏离表行不存在或不属于当前项目');
      return prisma.responseDeviationRow.update({
        where: { id: rowId },
        data: { ...patch, manualEdited: true },
      });
    },

    async updateProjectFields(projectId: number, fields: unknown) {
      const current = await prisma.responseDeviationWorkspace.findUnique({ where: { projectId } });
      if (!current) throw new Error('请先生成技术响应与偏离表');
      const previous = current.projectFieldsJson && typeof current.projectFieldsJson === 'object'
        ? current.projectFieldsJson as Record<string, unknown>
        : {};
      const patch = sanitizeProjectFieldPatch(fields);
      await prisma.responseDeviationWorkspace.update({ where: { projectId }, data: { projectFieldsJson: { ...previous, ...patch } } });
      return getWorkspace(projectId);
    },

    async confirmWorkspace(projectId: number) {
      const workspace = await prisma.responseDeviationWorkspace.findUnique({ where: { projectId } });
      if (!workspace) throw new Error('请先生成技术响应与偏离表');
      const stats = (workspace.statsJson || {}) as Record<string, unknown>;
      if (Array.isArray(stats.uncoveredBlockIds) && stats.uncoveredBlockIds.length) throw new Error('仍有未覆盖的招标原文，请先复核');
      if (Array.isArray(stats.duplicateBlockIds) && stats.duplicateBlockIds.length) throw new Error('存在重复引用的招标原文，请先复核');
      await prisma.responseDeviationWorkspace.update({
        where: { projectId },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
      return getWorkspace(projectId);
    },

    async markStaleIfSourceChanged(projectId: number, tenderHash: string, selectedSectionId: string) {
      const workspace = await prisma.responseDeviationWorkspace.findUnique({ where: { projectId } });
      if (!workspace) return false;
      const stale = workspace.tenderHash !== tenderHash || workspace.selectedSectionId !== selectedSectionId;
      if (stale && workspace.status !== 'stale') {
        await prisma.responseDeviationWorkspace.update({ where: { projectId }, data: { status: 'stale' } });
      }
      return stale;
    },

    async loadResponseDeviation(projectId: number) {
      const data = await getWorkspace(projectId);
      return {
        ...data,
        generationTask: (data as Record<string, unknown>).generationTaskJson ?? null,
      };
    },

    async updateResponseDeviation(projectId: number, partial: Record<string, unknown>) {
      const data: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(partial, 'generationTask')) data.generationTaskJson = partial.generationTask;
      if (Object.prototype.hasOwnProperty.call(partial, 'status')) data.status = partial.status;
      if (Object.prototype.hasOwnProperty.call(partial, 'stats')) data.statsJson = partial.stats;
      await prisma.responseDeviationWorkspace.upsert({
        where: { projectId },
        create: { projectId, ...data },
        update: data,
      });
      const next = await getWorkspace(projectId);
      return {
        ...next,
        generationTask: (next as Record<string, unknown>).generationTaskJson ?? null,
      };
    },
  };
}

export type ResponseDeviationStore = ReturnType<typeof createResponseDeviationStore>;
