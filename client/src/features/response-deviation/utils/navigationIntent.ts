const KEY = 'yibiao_response_deviation_intent';
export interface ResponseDeviationNavigationIntent { projectId: number; tenderHash: string; selectedSectionId: string; createdAt: number }
export function writeResponseDeviationIntent(intent: Omit<ResponseDeviationNavigationIntent, 'createdAt'>): void {
  sessionStorage.setItem(KEY, JSON.stringify({ ...intent, createdAt: Date.now() }));
}
export function consumeResponseDeviationIntent(projectId: number): ResponseDeviationNavigationIntent | null {
  const raw = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ResponseDeviationNavigationIntent;
    if (parsed.projectId !== projectId || Date.now() - parsed.createdAt > 10 * 60_000) return null;
    return parsed;
  } catch { return null; }
}
