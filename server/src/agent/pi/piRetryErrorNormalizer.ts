// Pi 运行时错误归一扩展（移植自桌面 electron/services/pi/piRetryErrorNormalizer.cjs）。
// 把上游网关的瞬时错误文案归一成 pi 原生重试能识别的表达，注册为 SDK 内联 extension。
// 纯逻辑、无外部依赖、无 Electron 耦合。

const RETRYABLE_ERROR_PREFIX = 'Provider returned error: ';
const UPSTREAM_TEMPORARILY_UNAVAILABLE_PATTERN = /\bupstream service temporarily unavailable\b/i;
export const PI_RETRY_ERROR_NORMALIZER_NAME = 'yibiao-retry-error-normalizer';
export const PI_RETRY_ERROR_NORMALIZER_PATH = `<inline:${PI_RETRY_ERROR_NORMALIZER_NAME}>`;

// 已知网关瞬时错误 → pi 原生重试能识别的错误表达。
export function normalizePiRetryableErrorMessage(value: unknown): string {
  const message = String(value ?? '').trim();
  if (!message || message.startsWith(RETRYABLE_ERROR_PREFIX)) return message;
  if (!UPSTREAM_TEMPORARILY_UNAVAILABLE_PATTERN.test(message)) return message;
  return `${RETRYABLE_ERROR_PREFIX}${message}`;
}

// 对用户界面/业务状态恢复网关返回的原始错误文案。
export function restorePiErrorMessage(value: unknown): string {
  const message = String(value ?? '');
  return message.startsWith(RETRYABLE_ERROR_PREFIX)
    ? message.slice(RETRYABLE_ERROR_PREFIX.length)
    : message;
}

// pi extension 的 factory 形状：接收 pi 实例，在 message_end 事件里改写 errorMessage。
// 用 any 表达 SDK 动态边界（pi 实例类型随 SDK 版本，未固化 .d.ts）。
type PiExtensionFactory = (pi: { on: (event: string, handler: (event: any, context: any) => unknown) => void }) => unknown;

// 注册内联扩展：在 pi 判定自动重试前规范化当前 provider 的错误消息。
export function createPiRetryErrorNormalizer(): { name: string; factory: PiExtensionFactory } {
  return {
    name: PI_RETRY_ERROR_NORMALIZER_NAME,
    factory(pi) {
      pi.on('message_end', (event: any, context: any) => {
        const message = event?.message;
        if (!message || message.role !== 'assistant' || message.stopReason !== 'error') return undefined;
        if (message.provider !== 'yibiao' && context?.model?.provider !== 'yibiao') return undefined;
        const normalized = normalizePiRetryableErrorMessage(message.errorMessage);
        if (!normalized || normalized === message.errorMessage) return undefined;
        return { message: { ...message, errorMessage: normalized } };
      });
    },
  };
}
