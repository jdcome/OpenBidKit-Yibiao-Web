// 导出模板命名空间的 Web 实现：window.yibiao.templates.* 的底层。
// 隔离：普通用户看"自己 + 共享"；admin 看全量。服务端按 JWT user 过滤 + isShared 标志位。
import { http } from './http';

export interface TemplateDto {
  template_id: string;
  template_name: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  is_shared: boolean;
  owner_id?: number;
  owner_name?: string | null;
  can_edit?: boolean;
}

export const templatesApi = {
  list(): Promise<TemplateDto[]> {
    return http.get<TemplateDto[]>('/templates').then((r) => r.data || []);
  },
  get(templateId: string): Promise<TemplateDto | null> {
    return http.get<TemplateDto | null>(`/templates/${encodeURIComponent(templateId)}`).then((r) => r.data ?? null);
  },
  create(config: Record<string, unknown>, isShared?: boolean): Promise<TemplateDto> {
    const body = isShared === undefined ? config : { ...config, is_shared: isShared };
    return http.post<TemplateDto>('/templates', body).then((r) => r.data);
  },
  update(templateId: string, config: Record<string, unknown>): Promise<TemplateDto> {
    return http.put<TemplateDto>(`/templates/${encodeURIComponent(templateId)}`, config).then((r) => r.data);
  },
  delete(templateId: string): Promise<{ success: boolean; message: string }> {
    return http.delete<{ success: boolean; message: string }>(`/templates/${encodeURIComponent(templateId)}`).then((r) => r.data);
  },
  setShared(templateId: string, isShared: boolean): Promise<TemplateDto> {
    return http.patch<TemplateDto>(`/templates/${encodeURIComponent(templateId)}/share`, { isShared }).then((r) => r.data);
  },
};
