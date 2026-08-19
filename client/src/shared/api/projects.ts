import { http } from './http';

// 代称替换表（与 server tasks/utils/subjectReplacement.ts 对齐）。
export interface SubjectReplacement {
  fullname: string;
  synonyms: string[];
}

// 项目实体（对齐 server routes/projects.ts 返回）。
export interface Project {
  id: number;
  projectCode: string;
  name: string;
  description?: string;
  bidderName?: string; // 我方（投标方）公司全称，STEP 04 录入/确认
  subjectReplacements?: SubjectReplacement[]; // 代称替换表，STEP 04 编辑；落库前确定性替换
  status: string;
  ownerId: number;
  ownerName?: string;
  progress?: number;
  isComplete?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStats {
  total: number;
  active: number;
  thisMonth: number;
  completionRate: number;
  runningTasks: number;
}

export async function fetchProjects(): Promise<Project[]> {
  const { data } = await http.get<Project[]>('/projects');
  return data;
}

export async function fetchProjectStats(): Promise<ProjectStats> {
  const { data } = await http.get<ProjectStats>('/projects/stats');
  return data;
}

export async function fetchProjectDetail(id: number): Promise<Project> {
  const { data } = await http.get<Project>(`/projects/${id}`);
  return data;
}

export async function createProject(payload: { name: string; description?: string; bidderName?: string }): Promise<Project> {
  const { data } = await http.post<Project>('/projects', payload);
  return data;
}

export async function updateProject(
  id: number,
  patch: Partial<Pick<Project, 'name' | 'description' | 'status' | 'bidderName' | 'subjectReplacements'>>,
): Promise<Project> {
  const { data } = await http.patch<Project>(`/projects/${id}`, patch);
  return data;
}

export async function deleteProject(id: number): Promise<void> {
  await http.delete(`/projects/${id}`);
}

export async function activateProject(id: number): Promise<void> {
  await http.post(`/projects/${id}/activate`);
}
