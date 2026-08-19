// 人员资质库 API 客户端（一人多证）：PersonnelProfile 1→N Certificate。
// 对标 assetLibrary.ts：react-query + shared/api/http。公司共享（无 userId）。
// 证书文件经 GET .../certificates/:certId/files/:fileId 取回（Bearer），预览用 axios blob → objectURL。
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../../shared/api/http';
import type { AssetFileMeta } from '../../asset-library/api/assetLibrary';

export type ExpiryFilter = 'active' | 'expiring' | 'expired';

export interface PersonnelCertificate {
  id: string;
  profileId: string;
  certName: string;
  certType: string;
  files: AssetFileMeta[];
  expiryDate: string | null;
  obtainedAt: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonnelProfile {
  id: string;
  name: string;
  department: string;
  position: string;
  phone: string;
  notes: string;
  tags: string[];
  certificates: PersonnelCertificate[];
  certCount: number;
  expiringCount: number;
  expiredCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonnelExpiringItem {
  profileId: string;
  profileName: string;
  department: string;
  certId: string;
  certName: string;
  certType: string;
  expiryDate: string;
  daysUntil: number;
}

export interface PersonnelListResponse {
  profiles: PersonnelProfile[];
  counts: { expiring: number; expired: number };
}

export interface ProfileInput {
  name: string;
  department?: string;
  position?: string;
  phone?: string;
  notes?: string;
  tags?: string[];
}

export interface CertificateInput {
  certName: string;
  certType?: string;
  expiryDate?: string | null;
  obtainedAt?: string | null;
  notes?: string;
  files?: File[];
  removeFileIds?: string[];
}

function buildProfileForm(input: ProfileInput): FormData {
  const form = new FormData();
  form.append('name', input.name);
  if (input.department !== undefined) form.append('department', input.department);
  if (input.position !== undefined) form.append('position', input.position);
  if (input.phone !== undefined) form.append('phone', input.phone);
  if (input.notes !== undefined) form.append('notes', input.notes);
  if (input.tags !== undefined) form.append('tags', (input.tags ?? []).join(','));
  return form;
}

function buildCertForm(input: CertificateInput): FormData {
  const form = new FormData();
  form.append('certName', input.certName);
  if (input.certType !== undefined) form.append('certType', input.certType);
  if (input.expiryDate !== undefined) form.append('expiryDate', input.expiryDate ?? '');
  if (input.obtainedAt !== undefined) form.append('obtainedAt', input.obtainedAt ?? '');
  if (input.notes !== undefined) form.append('notes', input.notes);
  if (input.removeFileIds && input.removeFileIds.length) {
    form.append('removeFileIds', input.removeFileIds.join(','));
  }
  for (const f of input.files ?? []) form.append('files', f, f.name);
  return form;
}

const MP = { headers: { 'Content-Type': 'multipart/form-data' } };

async function listProfiles(q?: string, expiry?: ExpiryFilter): Promise<PersonnelListResponse> {
  const { data } = await http.get<PersonnelListResponse>('/personnel', {
    params: { q: q || undefined, expiry: expiry || undefined },
  });
  return data;
}

export function usePersonnelProfiles(opts: { q?: string; expiry?: ExpiryFilter } = {}) {
  return useQuery({
    queryKey: ['personnel', { q: opts.q ?? '', expiry: opts.expiry ?? '' }],
    queryFn: () => listProfiles(opts.q, opts.expiry),
  });
}

export function usePersonnelProfile(id: string | null) {
  return useQuery({
    queryKey: ['personnel', 'profile', id],
    queryFn: async () => {
      const { data } = await http.get<{ profile: PersonnelProfile }>(`/personnel/${id}`);
      return data.profile;
    },
    enabled: !!id,
  });
}

export function useExpiringPersonnel(withinDays = 30) {
  return useQuery({
    queryKey: ['personnel', 'expiring', withinDays],
    queryFn: async () => {
      const { data } = await http.get<{ items: PersonnelExpiringItem[] }>('/personnel/expiring', {
        params: { withinDays },
      });
      return data.items;
    },
  });
}

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProfileInput) => {
      const { data } = await http.post<{ profile: PersonnelProfile }>('/personnel', buildProfileForm(input), MP);
      return data.profile;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personnel'] });
      qc.invalidateQueries({ queryKey: ['personnel', 'expiring'] });
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: ProfileInput }) => {
      const { data } = await http.patch<{ profile: PersonnelProfile }>(`/personnel/${id}`, buildProfileForm(input), MP);
      return data.profile;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personnel'] });
      qc.invalidateQueries({ queryKey: ['personnel', 'expiring'] });
    },
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => http.delete(`/personnel/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personnel'] });
      qc.invalidateQueries({ queryKey: ['personnel', 'expiring'] });
    },
  });
}

export function useAddCertificate(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CertificateInput) => {
      const { data } = await http.post<{ certificate: PersonnelCertificate; profile: PersonnelProfile }>(
        `/personnel/${profileId}/certificates`,
        buildCertForm(input),
        MP,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personnel'] });
      qc.invalidateQueries({ queryKey: ['personnel', 'expiring'] });
    },
  });
}

export function useUpdateCertificate(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ certId, input }: { certId: string; input: CertificateInput }) => {
      const { data } = await http.patch<{ certificate: PersonnelCertificate; profile: PersonnelProfile }>(
        `/personnel/${profileId}/certificates/${certId}`,
        buildCertForm(input),
        MP,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personnel'] });
      qc.invalidateQueries({ queryKey: ['personnel', 'expiring'] });
    },
  });
}

export function useDeleteCertificate(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (certId: string) => http.delete(`/personnel/${profileId}/certificates/${certId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personnel'] });
      qc.invalidateQueries({ queryKey: ['personnel', 'expiring'] });
    },
  });
}

// 证书文件预览 URL：axios blob → objectURL；卸载或 fileId 变化时 revoke。
export function usePersonnelFileUrl(
  profileId: string | null,
  certId: string | null,
  fileId: string | null,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!profileId || !certId || !fileId) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let created: string | null = null;
    http
      .get(`/personnel/${profileId}/certificates/${certId}/files/${fileId}`, { responseType: 'blob' })
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
  }, [profileId, certId, fileId]);
  return url;
}
