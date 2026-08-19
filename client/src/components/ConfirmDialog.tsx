// 通用确认对话框：薄封装 Radix Dialog，沿用应用统一弹窗词汇（content-regenerate-modal 遮罩 +
// .confirm-dialog 卡片 + .primary-action/.secondary-action 按钮）。供退出登录等二次确认场景复用。
import * as Dialog from '@radix-ui/react-dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
  busy,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="confirm-dialog">
          <Dialog.Title className="confirm-dialog-title">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="confirm-dialog-desc">{description}</Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          <div className="confirm-dialog-actions">
            <Dialog.Close asChild>
              <button type="button" className="secondary-action" disabled={busy}>{cancelText}</button>
            </Dialog.Close>
            <button type="button" className="primary-action" onClick={onConfirm} disabled={busy}>
              {busy ? '处理中…' : confirmText}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default ConfirmDialog;
