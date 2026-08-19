import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../../shared/api/http';

// 文档文章（管理员可编辑）。后端见 server/src/routes/docs.ts。
// 3 个顶级 tab 固定：usage(使用) / config(配置) / faq(反馈-常见问题)。

export type DocsSection = 'usage' | 'config' | 'faq';

export interface DocsListItem {
  id: string;
  section: DocsSection;
  title: string;
  sortOrder: number;
  updatedAt: string;
}

export interface DocsDetail extends DocsListItem {
  content: string;
}

export interface DocsGrouped {
  usage: DocsListItem[];
  config: DocsListItem[];
  faq: DocsListItem[];
}

// 把扁平列表按 section+sortOrder 分组。faq 通常只有一项。
export function groupDocs(items: DocsListItem[]): DocsGrouped {
  const out: DocsGrouped = { usage: [], config: [], faq: [] };
  for (const it of items) {
    if (it.section === 'usage' || it.section === 'config' || it.section === 'faq') {
      out[it.section].push(it);
    }
  }
  return out;
}

export async function fetchDocsList(): Promise<DocsListItem[]> {
  const { data } = await http.get<DocsListItem[]>('/docs');
  return data;
}

export async function fetchDoc(id: string): Promise<DocsDetail> {
  const { data } = await http.get<DocsDetail>(`/docs/${id}`);
  return data;
}

// 列表（全站共享，admin 改动后 invalidate 即时刷新）。
export function useDocs() {
  return useQuery({
    queryKey: ['docs'],
    queryFn: fetchDocsList,
    staleTime: Infinity,
  });
}

// 单篇详情（含 content）；id 为空时不发请求。
export function useDoc(id: string | null | undefined) {
  return useQuery({
    queryKey: ['doc', id],
    queryFn: () => fetchDoc(id as string),
    enabled: !!id,
  });
}

export async function createDoc(payload: { section: DocsSection; title: string; content: string }): Promise<{ id: string }> {
  const { data } = await http.post<{ id: string }>('/docs', payload);
  return data;
}

export async function saveDoc(payload: { id: string; title: string; content: string }): Promise<{ id: string }> {
  const { data } = await http.patch<{ id: string }>(`/docs/${payload.id}`, {
    title: payload.title,
    content: payload.content,
  });
  return data;
}

export async function deleteDoc(id: string): Promise<{ id: string }> {
  const { data } = await http.delete<{ id: string }>(`/docs/${id}`);
  return data;
}

export async function reorderDocs(payload: { section: DocsSection; items: { id: string; sortOrder: number }[] }): Promise<{ ok: boolean }> {
  const { data } = await http.put<{ ok: boolean }>('/docs/reorder', payload);
  return data;
}

export function useCreateDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createDoc,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['docs'] }),
  });
}

export function useSaveDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveDoc,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['docs'] });
      qc.invalidateQueries({ queryKey: ['doc', res.id] });
    },
  });
}

export function useDeleteDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDoc,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['docs'] }),
  });
}

export function useReorderDocs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: reorderDocs,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['docs'] }),
  });
}
