import { http } from './http';

// 用户实体（对齐 server routes/users.ts publicUser 返回）。
export interface SystemUser {
  id: number;
  username: string;
  displayName: string | null;
  phone: string | null;
  department: string | null;
  role: string;
  status: string;
  modules: string[];
  createdAt: string;
}

export interface UsersListResult {
  users: SystemUser[];
  pendingCount: number;
}

export async function fetchUsers(status?: string): Promise<UsersListResult> {
  const { data } = await http.get<UsersListResult>('/users', { params: status ? { status } : {} });
  return data;
}

export async function approveUser(id: number): Promise<void> {
  await http.post(`/users/${id}/approve`);
}

export async function disableUser(id: number): Promise<void> {
  await http.post(`/users/${id}/disable`);
}

export async function enableUser(id: number): Promise<void> {
  await http.post(`/users/${id}/enable`);
}

export interface UserUpdatePatch {
  displayName?: string;
  department?: string;
  role?: string;
  modules?: string[];
  password?: string;
}

export async function updateUser(id: number, patch: UserUpdatePatch): Promise<void> {
  await http.put(`/users/${id}`, patch);
}

export async function deleteUser(id: number): Promise<void> {
  await http.delete(`/users/${id}`);
}
