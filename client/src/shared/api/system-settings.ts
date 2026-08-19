import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './http';

export interface SystemSettings {
  systemName: string;
  logoDataUrl: string | null;
}

interface SystemSettingsResponse extends SystemSettings {
  success?: boolean;
  message?: string;
}

// 基本设置（系统名称 + Logo）：GET 公开（登录页需要），PUT 仅管理员。
// 用 react-query 全局缓存（queryKey ['system-settings']），Sidebar/LoginPage/SettingsPage 共享。
export async function getSystemSettings(): Promise<SystemSettings> {
  const { data } = await http.get<SystemSettings>('/system-settings');
  return { systemName: data.systemName, logoDataUrl: data.logoDataUrl ?? null };
}

export function useSystemSettings() {
  return useQuery({
    queryKey: ['system-settings'],
    queryFn: getSystemSettings,
    staleTime: Infinity,
  });
}

export async function saveSystemSettings(payload: Partial<Pick<SystemSettings, 'systemName' | 'logoDataUrl'>>): Promise<SystemSettings> {
  const { data } = await http.put<SystemSettingsResponse>('/system-settings', payload);
  return { systemName: data.systemName, logoDataUrl: data.logoDataUrl ?? null };
}

export function useSaveSystemSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<Pick<SystemSettings, 'systemName' | 'logoDataUrl'>>) => saveSystemSettings(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['system-settings'] }),
  });
}
