// 共享新建项目弹窗：仪表盘、侧栏项目切换器等多入口复用。白卡 Radix 弹窗，收集名称（必填）
// 与描述（可选），提交时回调 onCreate。校验与提示通过 onError 上抛，由调用方决定 toast。
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

interface CreateProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, description: string) => Promise<void>;
  onError: (msg: string) => void;
}

function CreateProjectModal({ open, onOpenChange, onCreate, onError }: CreateProjectModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      onError('项目名称必填');
      return;
    }
    setBusy(true);
    try {
      await onCreate(n, description.trim());
    } catch (err) {
      onError(`创建失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (o) { setName(''); setDescription(''); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="create-project-dialog">
          <Dialog.Title>新建项目</Dialog.Title>
          <Dialog.Description className="sr-only">填写项目名称与可选描述以创建新项目。</Dialog.Description>
          <div className="create-project-dialog-body">
            <label className="dashboard-field">
              项目名称
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder="例如：XX项目技术方案"
              />
            </label>
            <label className="dashboard-field">
              项目描述（可选）
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="简要描述项目背景"
              />
            </label>
          </div>
          <div className="dashboard-dialog-actions">
            <Dialog.Close asChild>
              <button type="button" className="secondary-action">取消</button>
            </Dialog.Close>
            <button type="button" className="primary-action" onClick={() => void submit()} disabled={busy}>
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default CreateProjectModal;
