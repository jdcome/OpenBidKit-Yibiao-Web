import type { ProjectTenderAnalysisSnapshot, ProjectTenderSourceService } from './types';
import { buildScopedTenderMarkdown } from '../technical-plan/selectedSectionMarkdown';

interface TenderMetaRow {
  tenderFileName?: string | null;
  tenderMarkdownPath?: string | null;
  tenderMarkdownHash?: string | null;
  tenderOriginalMarkdownPath?: string | null;
  tenderOriginalMarkdownHash?: string | null;
  tenderParserLabel?: string | null;
  bidSectionMode?: string | null;
  selectedSectionId?: string | null;
  selectedSectionTitle?: string | null;
  selectedSectionHeadLine?: string | null;
}

interface TenderSourcePrisma {
  technicalPlanMeta: {
    findUnique(args: { where: { projectId: number } }): Promise<TenderMetaRow | null>;
  };
}

interface TenderSourceTechnicalPlanStore {
  readOriginalTenderMarkdown(projectId: number): Promise<string>;
  loadTechnicalPlan(projectId: number): Promise<unknown>;
}

function findBidItem(state: Record<string, unknown>, id: string): unknown {
  const items = Array.isArray(state.bidItems) ? state.bidItems : [];
  return items.find((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).id || '') === id) ?? null;
}

function analysisFromState(state: Record<string, unknown>): ProjectTenderAnalysisSnapshot {
  return {
    projectInfo: findBidItem(state, 'projectInfo'),
    procurementList: findBidItem(state, 'procurementList'),
    responseFileRequirements: findBidItem(state, 'responseFileRequirements'),
  };
}

export function createProjectTenderSourceService(
  prisma: TenderSourcePrisma,
  technicalPlanStore: TenderSourceTechnicalPlanStore,
): ProjectTenderSourceService {
  return {
    async getSnapshot(projectId) {
      const meta = await prisma.technicalPlanMeta.findUnique({ where: { projectId } });
      if (!meta || (!meta.tenderOriginalMarkdownPath && !meta.tenderMarkdownPath)) return null;

      const markdown = await technicalPlanStore.readOriginalTenderMarkdown(projectId);
      if (!markdown.trim()) return null;

      const loaded = await technicalPlanStore.loadTechnicalPlan(projectId);
      const state = loaded && typeof loaded === 'object' ? loaded as Record<string, unknown> : {};
      const mode = meta.bidSectionMode === 'multiple' ? 'multiple' : 'single';
      const scoped = buildScopedTenderMarkdown(markdown, state);
      return {
        projectId,
        fileName: String(meta.tenderFileName || ''),
        markdown,
        selectedSectionMarkdown: scoped.applied ? scoped.markdown : '',
        tenderHash: String(meta.tenderOriginalMarkdownHash || meta.tenderMarkdownHash || ''),
        parserLabel: String(meta.tenderParserLabel || ''),
        selectedSectionId: mode === 'multiple' ? String(meta.selectedSectionId || '') : '',
        selectedSectionTitle: mode === 'multiple' ? String(meta.selectedSectionTitle || '') : '',
        selectedSectionHeadLine: mode === 'multiple' ? String(meta.selectedSectionHeadLine || '') : '',
        bidSectionMode: mode,
        analysis: analysisFromState(state || {}),
      };
    },
  };
}
