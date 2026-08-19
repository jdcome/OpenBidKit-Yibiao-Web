// 招标解析任务目录（DB 驱动）：从 /prompts?runnerKey=bid-analysis 派生前端展示用的任务列表。
// 替代旧的同源镜像 services/bidAnalysisWorkflow.ts——前端只读元数据(id/label/description/required/output/groupName)，
// 提示词正文由后端 runner 从 DB 读取。enabled 优先：禁用项与系统提示词不进目录。
import { useMemo } from 'react';
import { usePromptCatalog } from '../../prompt-management/api/prompts';

export interface BidAnalysisCatalogTask {
  id: string;        // = PromptCatalogItem.itemKey（与 runner selected_task_ids 对齐）
  label: string;
  description: string;
  required: boolean;
  output: 'markdown' | 'json';
  groupName: string;
  sortOrder: number;
}

export function useBidAnalysisCatalog() {
  const query = usePromptCatalog('bid-analysis');
  const tasks = useMemo<BidAnalysisCatalogTask[]>(() => {
    const items = (query.data ?? []).filter((it) => it.enabled && !it.isSystem);
    return items
      .map((it) => ({
        id: it.itemKey,
        label: it.label,
        description: it.description,
        required: it.required,
        output: it.output,
        groupName: it.groupName,
        sortOrder: it.sortOrder,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [query.data]);
  return { tasks, isLoading: query.isLoading };
}
