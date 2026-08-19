import { http } from './http';
import type { ResponseDeviationAvailability, ResponseDeviationExportValidation, ResponseDeviationWorkspace } from '../../features/response-deviation/types';

function parseFilename(disposition?: string): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) try { return decodeURIComponent(encoded); } catch { /* ignore */ }
  return '技术响应与偏离表.docx';
}

export const responseDeviationApi = {
  availability: () => http.get<ResponseDeviationAvailability>('/response-deviation/availability').then((r) => r.data),
  workspace: () => http.get<ResponseDeviationWorkspace>('/response-deviation').then((r) => r.data),
  generate: (force = false) => http.post('/response-deviation/generate', { force }).then((r) => r.data),
  patchProjectFields: (fields: Record<string, unknown>) => http.patch<ResponseDeviationWorkspace>('/response-deviation/project-fields', fields).then((r) => r.data),
  patchRow: (rowId: string, patch: Record<string, string>) => http.patch(`/response-deviation/rows/${encodeURIComponent(rowId)}`, patch).then((r) => r.data),
  confirm: () => http.post<ResponseDeviationWorkspace>('/response-deviation/confirm').then((r) => r.data),
  evidence: (rowId: string) => http.get(`/response-deviation/source/${encodeURIComponent(rowId)}`).then((r) => r.data),
  exportValidation: () => http.get<ResponseDeviationExportValidation>('/response-deviation/export-validation').then((r) => r.data),
  async exportWord() {
    const response = await http.post('/response-deviation/export', {}, { responseType: 'blob', timeout: 120000 });
    const url = URL.createObjectURL(response.data as Blob);
    const a = document.createElement('a');
    a.href = url; a.download = parseFilename(response.headers['content-disposition']); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};
