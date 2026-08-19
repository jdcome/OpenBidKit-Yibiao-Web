// 新建自定义提示词弹窗：runnerKey + itemKey + label + 正文 + 元数据。
// 创建后列表刷新，可再进编辑弹窗细调。itemKey 须字母开头、仅字母数字下划线，且不与内置项冲突（后端校验）。
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useCreatePrompt, type PromptOutput, type PromptRunnerKey } from '../api/prompts';
import { useToast } from '../../../shared/ui';

interface CreatePromptDialogProps {
  open: boolean;
  defaultRunnerKey: PromptRunnerKey;
  onClose: () => void;
}

const RUNNER_OPTIONS: { value: PromptRunnerKey; label: string }[] = [
  { value: 'bid-analysis', label: '招标解析' },
  { value: 'rejection-check', label: '废标检查' },
  { value: 'mirror-procurement', label: '镜像采购需求' },
];

function CreatePromptDialog({ open, defaultRunnerKey, onClose }: CreatePromptDialogProps) {
  const { showToast } = useToast();
  const createMut = useCreatePrompt();
  const [runnerKey, setRunnerKey] = useState<PromptRunnerKey>(defaultRunnerKey);
  const [itemKey, setItemKey] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [output, setOutput] = useState<PromptOutput>('markdown');
  const [required, setRequired] = useState(false);
  const [promptText, setPromptText] = useState('');

  // 每次打开重置为默认。
  const handleOpenChange = (o: boolean) => {
    if (o) {
      setRunnerKey(defaultRunnerKey);
      setItemKey('');
      setLabel('');
      setDescription('');
      setOutput('markdown');
      setRequired(false);
      setPromptText('');
    } else {
      onClose();
    }
  };

  const valid = itemKey.trim() && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(itemKey.trim()) && label.trim() && promptText.trim();

  const handleSubmit = async () => {
    if (!valid) {
      showToast('itemKey 须字母开头（仅字母数字下划线），且标签/正文不能为空', 'error');
      return;
    }
    try {
      await createMut.mutateAsync({
        runnerKey,
        itemKey: itemKey.trim(),
        label: label.trim(),
        description: description.trim(),
        output,
        required,
        promptText,
      });
      showToast('已创建', 'success');
      handleOpenChange(false);
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      showToast(`创建失败：${anyErr.response?.data?.error || (err instanceof Error ? err.message : String(err))}`, 'error');
    }
  };

  const busy = createMut.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Content className="prompt-edit-modal" aria-describedby={undefined}>
          <div className="prompt-edit-card">
          <Dialog.Title className="prompt-edit-title">新建自定义提示词</Dialog.Title>
          <Dialog.Description className="sr-only">新建一个自定义提示词项。</Dialog.Description>

          <div className="prompt-edit-body">
            <div className="prompt-field-row">
              <label className="prompt-field">
                <span className="prompt-field-label">所属模块</span>
                <select value={runnerKey} onChange={(e) => setRunnerKey(e.target.value as PromptRunnerKey)}>
                  {RUNNER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="prompt-field">
                <span className="prompt-field-label">itemKey（字母开头，唯一）</span>
                <input type="text" value={itemKey} onChange={(e) => setItemKey(e.target.value)} placeholder="如 myCustomItem" />
              </label>
            </div>
            <label className="prompt-field">
              <span className="prompt-field-label">标签</span>
              <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="prompt-field">
              <span className="prompt-field-label">说明</span>
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="prompt-field-row">
              <label className="prompt-field">
                <span className="prompt-field-label">输出格式</span>
                <select value={output} onChange={(e) => setOutput(e.target.value as PromptOutput)}>
                  <option value="markdown">Markdown</option>
                  <option value="json">JSON</option>
                </select>
              </label>
              <label className="prompt-checkbox">
                <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
                必填项
              </label>
            </div>
            <label className="prompt-field prompt-field-text">
              <span className="prompt-field-label">提示词正文</span>
              <textarea value={promptText} onChange={(e) => setPromptText(e.target.value)} rows={14} spellCheck={false} />
            </label>
          </div>

          <div className="prompt-edit-actions">
            <div className="prompt-edit-actions-right">
              <Dialog.Close asChild>
                <button type="button" className="secondary-action" disabled={busy}>取消</button>
              </Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void handleSubmit()} disabled={busy || !valid}>
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default CreatePromptDialog;
