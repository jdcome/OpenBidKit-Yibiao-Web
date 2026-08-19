// M1-P6 SSE 客户端：单条多路复用连接 + 按 channel 解复用。
//
// 用 @microsoft/fetch-event-source（基于 fetch，可带 Authorization 头，不走 URL ?token=）。
// 服务端 /api/events 每帧带 `event: <channel>`，本管理器按 channel 分发到对应监听器。
// 一条连接服务 tasks / kb-document / ai-http-error / export-progress 全域。
//
// 生命周期由 AuthProvider 驱动：login 后 start()，logout 时 stop()，boot 时若已登录也 start()。
// 401（token 失效）：停止重连，等下一次 axios 401 触发 reload → 重新登录后重启。
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { TOKEN_KEY, getActiveProjectId } from './http';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export type SseChannel = 'tasks' | 'kb-document' | 'ai-http-error' | 'export-progress' | 'agent-question';
type Listener = (data: unknown) => void;

// 401 时抛出以让 fetch-event-source 停止重连（默认它会无限退避重试）。
class FatalSseError extends Error {}

class SseManager {
  private listeners = new Map<SseChannel, Set<Listener>>();
  private ctrl: AbortController | null = null;
  private started = false;

  /** 订阅某 channel。返回退订函数。订阅会触发自动连接（若已登录）。 */
  subscribe(channel: SseChannel, cb: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb);
    // 已有监听器即尝试连接（无 token 时静默，等 login 后 start）。
    this.start();
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.listeners.delete(channel);
    };
  }

  /** 启动 SSE 连接（幂等）。无 token 时记 started 标志、不连；login 后再调即连。 */
  start(): void {
    if (this.started) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return; // 未登录；AuthProvider login 成功后会再调 start()
    this.started = true;
    this.open(token);
  }

  /** 停止连接并清 started 标志（logout 时调用）。监听器不动——下次 start 仍生效。 */
  stop(): void {
    this.started = false;
    this.ctrl?.abort();
    this.ctrl = null;
  }

  /** 切换活跃项目后重连：关闭旧连接（无 projectId 或旧 projectId），用新 projectId 重开。
   *  未启动时静默（等 start 时自然读到新 projectId）。*/
  reconnect(): void {
    if (!this.started) return;
    this.stop();
    this.start();
  }

  private open(token: string): void {
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;

    // EventSource 不能带自定义头 → projectId 走 ?projectId= 查询参数；服务端 events 路由自解析。
    const pid = getActiveProjectId();
    const url = pid != null ? `${BASE_URL}/events?projectId=${pid}` : `${BASE_URL}/events`;

    // fetch-event-source 在内部循环重连；headers 在每次 fetch 时重新读取闭包外的 token。
    // 但 token 7 天有效，重连窗口内不会过期；真过期时 onopen 401 → FatalSseError 终止。
    void fetchEventSource(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      // 标签页切到后台也保持连接（默认隐藏时会断）。
      openWhenHidden: true,
      async onopen(res: Response): Promise<void> {
        if (res.status === 401) {
          throw new FatalSseError(); // token 失效，停止重连
        }
        if (!res.ok && res.status !== 200) {
          throw new Error(`SSE 连接失败：HTTP ${res.status}`);
        }
      },
      onmessage: (ev) => {
        const channel = ev.event as SseChannel | undefined;
        if (!channel) return;
        let data: unknown = ev.data;
        if (typeof ev.data === 'string') {
          try {
            data = JSON.parse(ev.data);
          } catch {
            /* 保留原始字符串 */
          }
        }
        const set = this.listeners.get(channel);
        if (!set || set.size === 0) return;
        for (const cb of set) {
          try {
            cb(data);
          } catch {
            /* 单个监听器异常不影响其他 */
          }
        }
      },
      onerror: (err: unknown) => {
        if (err instanceof FatalSseError) {
          this.started = false; // 不再重连；等重新登录后 start()
          throw err; // 抛出 → fetch-event-source 停止重试
        }
        // 其他错误（网络抖动/服务重启）：默认退避重试，不抛。
      },
    }).catch(() => {
      // FatalSseError 或 abort 到此；已处理。
    });
  }
}

export const sseManager = new SseManager();
