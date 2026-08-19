import { http } from '../../../shared/api/http';

export interface FeedbackListItem {
  id: number;
  userId: number;
  displayName: string;
  content: string;
  status: string;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackReply {
  id: number;
  userId: number;
  displayName: string;
  content: string;
  images: string[];
  isAdmin: boolean;
  createdAt: string;
}

export interface FeedbackDetail {
  id: number;
  userId: number;
  displayName: string;
  content: string;
  images: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  replies: FeedbackReply[];
}

export async function fetchFeedbacks(): Promise<FeedbackListItem[]> {
  const { data } = await http.get<FeedbackListItem[]>('/feedback');
  return data;
}

export async function fetchFeedback(id: number): Promise<FeedbackDetail> {
  const { data } = await http.get<FeedbackDetail>(`/feedback/${id}`);
  return data;
}

export async function createFeedback(content: string, images: string[]): Promise<{ id: number }> {
  const { data } = await http.post<{ id: number }>('/feedback', { content, images });
  return data;
}

export async function replyFeedback(id: number, content: string, images: string[] = []): Promise<{ id: number }> {
  const { data } = await http.post<{ id: number }>(`/feedback/${id}/replies`, { content, images });
  return data;
}

export async function updateFeedbackStatus(id: number, status: string): Promise<{ id: number; status: string }> {
  const { data } = await http.patch<{ id: number; status: string }>(`/feedback/${id}/status`, { status });
  return data;
}
