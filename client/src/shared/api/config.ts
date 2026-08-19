import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './http';
import type { ClientConfig, ConfigSaveResult } from '../types/config';

export type { ClientConfig };

export interface ConfigSaveResponse extends ConfigSaveResult {
  config?: ClientConfig;
}

// config 命名空间：对应 window.yibiao.config.load() 的 Web 实现。
// GET /config 返回合并归一化后的真实 ClientConfig（非管理员 key 脱敏）。
export async function fetchConfig(): Promise<ClientConfig> {
  const { data } = await http.get<{ config: ClientConfig }>('/config');
  return data.config;
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: fetchConfig });
}

// 管理员：写平台配置（含 AI key）。空 key 不覆盖现有。
export async function saveConfig(config: Partial<ClientConfig>): Promise<ConfigSaveResponse> {
  const { data } = await http.put<ConfigSaveResponse>('/config', config);
  return data;
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: Partial<ClientConfig>) => saveConfig(config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });
}

// 任意用户：写个人偏好白名单（provider 选择/导出样式/开关），不涉 key。
export async function saveUserConfig(patch: Partial<ClientConfig>): Promise<ConfigSaveResponse> {
  const { data } = await http.put<ConfigSaveResponse>('/config/user', patch);
  return data;
}

export function useSaveUserConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ClientConfig>) => saveUserConfig(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });
}
