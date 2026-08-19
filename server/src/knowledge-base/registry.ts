// 进程内「正在跑知识抽取」的文档 id 集合。
// 用途：store.recoverInterruptedDocuments() 在 list()/getMigrationStatus() 时排除这些 id，
// 避免把正在 extracting/matching 的文档误标 error。extraction.ts 在 runKnowledgeExtraction
// 起 finally 处 register/unregister。
const activeExtractionIds = new Set<string>();

export function registerActiveExtraction(documentId: string): void {
  activeExtractionIds.add(documentId);
}

export function unregisterActiveExtraction(documentId: string): void {
  activeExtractionIds.delete(documentId);
}

export function getActiveExtractionIds(): string[] {
  return [...activeExtractionIds];
}
