// 提示词管理 API 客户端：DB 驱动的招标解析/废标检查提示词 CRUD。
// 对标 personnel.ts：react-query + shared/api/http。管理员专属（后端 requireAdmin）。
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../../shared/api/http';

export type PromptRunnerKey = 'bid-analysis' | 'rejection-check' | 'mirror-procurement';
export type PromptOutput = 'markdown' | 'json';

// 列表项（不含 promptText）。
export interface PromptCatalogItem {
  id: string;
  runnerKey: PromptRunnerKey;
  itemKey: string;
  label: string;
  description: string;
  groupName: string;
  output: PromptOutput;
  required: boolean;
  enabled: boolean;
  builtin: boolean;
  isSystem: boolean;
  sortOrder: number;
  updatedAt: string;
}

// 详情项（含 promptText，编辑用）。
export type PromptDetail = PromptCatalogItem & { promptText: string };

export interface PromptUpdatePatch {
  label?: string;
  description?: string;
  groupName?: string;
  output?: PromptOutput;
  required?: boolean;
  promptText?: string;
  enabled?: boolean;
}

export interface PromptCreateInput {
  runnerKey: PromptRunnerKey;
  itemKey: string;
  label: string;
  description?: string;
  output?: PromptOutput;
  required?: boolean;
  promptText: string;
}

async function listCatalog(runnerKey?: PromptRunnerKey): Promise<PromptCatalogItem[]> {
  const { data } = await http.get<{ items: PromptCatalogItem[] }>('/prompts', {
    params: { runnerKey: runnerKey || undefined },
  });
  return data.items;
}

export function usePromptCatalog(runnerKey?: PromptRunnerKey) {
  return useQuery({
    queryKey: ['prompts', runnerKey ?? 'all'],
    queryFn: () => listCatalog(runnerKey),
  });
}

export function usePromptDetail(id: string | null) {
  return useQuery({
    queryKey: ['prompts', 'detail', id],
    queryFn: async () => {
      const { data } = await http.get<{ item: PromptDetail }>(`/prompts/${id}`);
      return data.item;
    },
    enabled: !!id,
  });
}

export function useCreatePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PromptCreateInput) => {
      const { data } = await http.post<{ item: PromptDetail }>('/prompts', input);
      return data.item;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prompts'] }),
  });
}

export function useUpdatePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: PromptUpdatePatch }) => {
      const { data } = await http.put<{ item: PromptDetail }>(`/prompts/${id}`, patch);
      return data.item;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['prompts'] });
      qc.invalidateQueries({ queryKey: ['prompts', 'detail', vars.id] });
    },
  });
}

export function useDeletePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => http.delete(`/prompts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prompts'] }),
  });
}

export function useResetPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await http.post<{ item: PromptDetail }>(`/prompts/${id}/reset`);
      return data.item;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['prompts'] });
      qc.invalidateQueries({ queryKey: ['prompts', 'detail', vars] });
    },
  });
}

export function useResetAllPrompts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runnerKey?: PromptRunnerKey) => {
      const { data } = await http.post<{ success: boolean; count: number }>('/prompts/reset-all', null, {
        params: { runnerKey: runnerKey || undefined },
      });
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prompts'] }),
  });
}
