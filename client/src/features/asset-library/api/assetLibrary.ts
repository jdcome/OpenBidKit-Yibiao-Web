// 资产/资质库 API 客户端：三库（tool/company/personnel）共用，公司共享（无 userId）。
// 对标 system-settings.ts：react-query + shared/api/http（axios 实例自动注入 /api 前缀与 Bearer）。
// 文件字节经 GET .../files/:fileId 取回（Bearer 鉴权），预览用 axios blob → objectURL，避免把 JWT 放进 URL/日志。
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../../shared/api/http';

export type AssetLibraryId = 'tool' | 'company' | 'personnel';
export type ExpiryFilter = 'active' | 'expiring' | 'expired';

export interface AssetFileMeta {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  ext: string;
}

export interface AssetItem {
  id: string;
  library: string;
  name: string;
  notes: string;
  files: AssetFileMeta[];
  expiryDate: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AssetExpiringItem extends AssetItem {
  daysUntil: number;
}

export interface AssetListResponse {
  items: AssetItem[];
  counts: { expiring: number; expired: number };
}

export interface AssetItemInput {
  name: string;
  notes?: string;
  expiryDate?: string | null;
  tags?: string[];
  files?: File[];
  removeFileIds?: string[];
}

// multipart FormData：字段 name/notes/expiryDate/tags + 多个文件 part（fieldname 不影响后端收集）。
function buildForm(input: AssetItemInput): FormData {
  const form = new FormData();
  form.append('name', input.name);
  if (input.notes !== undefined) form.append('notes', input.notes);
  if (input.expiryDate !== undefined) form.append('expiryDate', input.expiryDate ?? '');
  if (input.tags !== undefined) form.append('tags', (input.tags ?? []).join(','));
  if (input.removeFileIds && input.removeFileIds.length) {
    form.append('removeFileIds', input.removeFileIds.join(','));
  }
  for (const f of input.files ?? []) form.append('files', f, f.name);
  return form;
}

async function listItems(library: AssetLibraryId, q?: string, expiry?: ExpiryFilter): Promise<AssetListResponse> {
  const { data } = await http.get<AssetListResponse>(`/asset-library/${library}`, {
    params: { q: q || undefined, expiry: expiry || undefined },
  });
  return data;
}

export function useAssetItems(library: AssetLibraryId, opts: { q?: string; expiry?: ExpiryFilter } = {}) {
  return useQuery({
    queryKey: ['asset-library', library, { q: opts.q ?? '', expiry: opts.expiry ?? '' }],
    queryFn: () => listItems(library, opts.q, opts.expiry),
  });
}

export function useAssetItem(library: AssetLibraryId, id: string | null) {
  return useQuery({
    queryKey: ['asset-library', library, 'item', id],
    queryFn: async () => {
      const { data } = await http.get<{ item: AssetItem }>(`/asset-library/${library}/${id}`);
      return data.item;
    },
    enabled: !!id,
  });
}

export function useExpiringAssets(withinDays = 30) {
  return useQuery({
    queryKey: ['asset-library', 'expiring', withinDays],
    queryFn: async () => {
      const { data } = await http.get<{ items: AssetExpiringItem[] }>('/asset-library/expiring', {
        params: { withinDays },
      });
      return data.items;
    },
  });
}

export function useCreateAssetItem(library: AssetLibraryId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssetItemInput) => {
      const { data } = await http.post<{ item: AssetItem }>(`/asset-library/${library}`, buildForm(input), {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return data.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['asset-library', library] });
      qc.invalidateQueries({ queryKey: ['asset-library', 'expiring'] });
    },
  });
}

export function useUpdateAssetItem(library: AssetLibraryId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: AssetItemInput }) => {
      const { data } = await http.patch<{ item: AssetItem }>(`/asset-library/${library}/${id}`, buildForm(input), {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return data.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['asset-library', library] });
      qc.invalidateQueries({ queryKey: ['asset-library', 'expiring'] });
    },
  });
}

export function useDeleteAssetItem(library: AssetLibraryId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => http.delete(`/asset-library/${library}/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['asset-library', library] });
      qc.invalidateQueries({ queryKey: ['asset-library', 'expiring'] });
    },
  });
}

// 文件预览 URL：axios 取 blob（自动带 Bearer）→ objectURL；组件卸载或 fileId 变化时 revoke。
// 返回 null 时表示加载中/失败，UI 显示占位。
export function useAssetFileUrl(library: AssetLibraryId, id: string | null, fileId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !fileId) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let created: string | null = null;
    http
      .get(`/asset-library/${library}/${id}/files/${fileId}`, { responseType: 'blob' })
      .then((res) => {
        if (revoked) return;
        created = URL.createObjectURL(res.data as Blob);
        setUrl(created);
      })
      .catch(() => {
        if (!revoked) setUrl(null);
      });
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [library, id, fileId]);
  return url;
}
