// M1-P6 SSE 总线：每项目进程内 pub/sub。
//
// 泛化自 P1 的 ai/httpError.ts 进程内订阅者模式（原来只 aiHttpError 用），
// 收口成统一 EventBus：任何 server 模块 emit(projectId, channel, data)，
// /api/events SSE 路由 subscribe(projectId) 后把事件流回该项目的浏览器。
//
// 设计要点：
//  - 单实例（进程内），水平扩展时换 Redis pub/sub。
//  - 按 projectId 隔离：A 项目的 AI 报错不会弹到 B 项目屏幕。
//  - 同步 fan-out：单个订阅者抛错不影响其他订阅者。
//  - emit 是同步的（订阅者回调同步执行）；订阅者应快速转写入 SSE 流后即返回。

export type SseChannel =
  | 'tasks' // 任务引擎进度：{task, ...patch}（对齐桌面 tasks:event 包络）
  | 'kb-document' // 知识库抽取流水线：{document}
  | 'ai-http-error' // AI 上游 HTML 类错误弹窗：AiHttpErrorPayload
  | 'export-progress' // 导出 Word 进度：WordExportProgressEvent
  | 'agent-question'; // pi ask-user 挂起问题下发：AgentPendingQuestion（project_id 路由）

export interface SseEvent {
  channel: SseChannel;
  data: unknown;
  // 单调递增 id，作为 SSE 的 id 字段，供客户端 Last-Event-ID 断线重连。
  id: number;
}

type Subscriber = (event: SseEvent) => void;

class EventBus {
  private subscribers = new Map<string, Set<Subscriber>>();
  private seq = 0;

  /** 订阅某项目的事件流。返回退订函数。 */
  subscribe(projectId: string, cb: Subscriber): () => void {
    let set = this.subscribers.get(projectId);
    if (!set) {
      set = new Set();
      this.subscribers.set(projectId, set);
    }
    set.add(cb);
    return () => {
      const current = this.subscribers.get(projectId);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.subscribers.delete(projectId);
    };
  }

  /** 向某项目广播一条事件。无订阅者时静默丢弃（非错误）。 */
  emit(projectId: string, channel: SseChannel, data: unknown): void {
    const set = this.subscribers.get(projectId);
    if (!set || set.size === 0) return;
    const event: SseEvent = { channel, data, id: (this.seq += 1) };
    for (const cb of set) {
      try {
        cb(event);
      } catch {
        /* 单个订阅者异常不得影响其他订阅者 */
      }
    }
  }

  /** 当前订阅者计数（诊断/测试用）。 */
  subscriberCount(projectId: string): number {
    return this.subscribers.get(projectId)?.size ?? 0;
  }
}

export const eventBus = new EventBus();
