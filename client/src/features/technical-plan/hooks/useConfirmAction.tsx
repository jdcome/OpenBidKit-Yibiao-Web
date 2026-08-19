// 通用确认动作 hook：管理一个参数化 ConfirmDialog，返回 promise 风格的 confirmAsync 与
// 需挂载一次的 dialogElement。调用方自行决定是否调用 confirmAsync（即由调用方做前置判定，
// 符合「仅破坏性操作才弹」的语义）。复用 client/src/components/ConfirmDialog。
import { useCallback, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import ConfirmDialog from '../../../components/ConfirmDialog';

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
}

export function useConfirmAction() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({ title: '' });
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirmAsync = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    setOptions(opts);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setOpen(false);
    const resolver = resolverRef.current;
    resolverRef.current = null;
    if (resolver) resolver(true);
  }, []);

  const handleCancel = useCallback(() => {
    setOpen(false);
    const resolver = resolverRef.current;
    resolverRef.current = null;
    if (resolver) resolver(false);
  }, []);

  const dialogElement: ReactElement = (
    <ConfirmDialog
      open={open}
      title={options.title}
      description={options.description}
      confirmText={options.confirmText}
      cancelText={options.cancelText}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return { confirmAsync, dialogElement };
}
