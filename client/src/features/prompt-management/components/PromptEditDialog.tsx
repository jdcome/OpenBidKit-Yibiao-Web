// 提示词编辑弹窗：按 item 类型差异化字段（system 仅 label+promptText；builtin 全字段+恢复默认；custom 全字段+删除）。
// 弹窗遵循项目规范：fixed + overflow-y-auto + 10vh padding，禁 items-center。
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import {
  usePromptDetail,
  useUpdatePrompt,
  useDeletePrompt,
  useResetPrompt,
  type PromptOutput,
} from '../api/prompts';
import { useToast } from '../../../shared/ui';

interface PromptEditDialogProps {
  promptId: string | null;
  onClose: () => void;
}

const OUTPUT_OPTIONS: { value: PromptOutput; label: string }[] = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'json', label: 'JSON' },
];

function PromptEditDialog({ promptId, onClose }: PromptEditDialogProps) {
  const { showToast } = useToast();
  const { data: item, isLoading } = usePromptDetail(promptId);
  const updateMut = useUpdatePrompt();
  const deleteMut = useDeletePrompt();
  const resetMut = useResetPrompt();

  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [groupName, setGroupName] = useState('');
  const [output, setOutput] = useState<PromptOutput>('markdown');
  const [required, setRequired] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [promptText, setPromptText] = useState('');
  const [dirty, setDirty] = useState(false);

  // 详情加载后填充表单（每次打开/切换 promptId 重填一次）。
  useEffect(() => {
    if (!item) return;
    setLabel(item.label);
    setDescription(item.description);
    setGroupName(item.groupName);
    setOutput(item.output);
    setRequired(item.required);
    setEnabled(item.enabled);
    setPromptText(item.promptText);
    setDirty(false);
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isSystem = item?.isSystem ?? false;
  const builtin = item?.builtin ?? false;

  const handleField = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };

  const buildPatch = () => {
    if (!item) return null;
    const patch: Record<string, unknown> = {};
    if (label !== item.label) patch.label = label;
    if (promptText !== item.promptText) patch.promptText = promptText;
    if (!isSystem) {
      if (description !== item.description) patch.description = description;
      if (groupName !== item.groupName) patch.groupName = groupName;
      if (output !== item.output) patch.output = output;
      if (required !== item.required) patch.required = required;
      if (enabled !== item.enabled) patch.enabled = enabled;
    }
    return patch;
  };

  const handleSave = async () => {
    if (!item) return;
    const patch = buildPatch();
    if (!patch || Object.keys(patch).length === 0) {
      showToast('无待保存改动', 'info');
      return;
    }
    try {
      await updateMut.mutateAsync({ id: item.id, patch });
      showToast('已保存', 'success');
      setDirty(false);
      onClose();
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      showToast(`保存失败：${anyErr.response?.data?.error || (err instanceof Error ? err.message : String(err))}`, 'error');
    }
  };

  const handleReset = async () => {
    if (!item) return;
    if (!window.confirm('恢复该提示词为内置默认文本？当前编辑的正文将被覆盖，元数据（标签/分组等）保留。')) return;
    try {
      const refreshed = await resetMut.mutateAsync(item.id);
      setPromptText(refreshed.promptText);
      setDirty(false);
      showToast('已恢复默认', 'success');
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      showToast(`恢复失败：${anyErr.response?.data?.error || (err instanceof Error ? err.message : String(err))}`, 'error');
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!window.confirm(`删除自定义提示词「${item.label}」？此操作不可撤销。`)) return;
    try {
      await deleteMut.mutateAsync(item.id);
      showToast('已删除', 'success');
      onClose();
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      showToast(`删除失败：${anyErr.response?.data?.error || (err instanceof Error ? err.message : String(err))}`, 'error');
    }
  };

  const busy = updateMut.isPending || deleteMut.isPending || resetMut.isPending;

  return (
    <Dialog.Root open={Boolean(promptId)} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content className="prompt-edit-modal" aria-describedby={undefined}>
          <div className="prompt-edit-card">
          <Dialog.Title className="prompt-edit-title">
            {item ? `编辑提示词 · ${item.label}` : '编辑提示词'}
          </Dialog.Title>
          <Dialog.Description className="sr-only">编辑提示词的标签、正文与元数据。</Dialog.Description>

          {isLoading || !item ? (
            <div className="prompt-edit-loading">加载中…</div>
          ) : (
            <>
              <div className="prompt-edit-meta">
                <span className="prompt-edit-tag">{item.runnerKey === 'bid-analysis' ? '招标解析' : '废标检查'}</span>
                <span className="prompt-edit-tag">{item.itemKey}</span>
                {isSystem && <span className="prompt-edit-tag is-system">系统</span>}
                {builtin ? <span className="prompt-edit-tag is-builtin">内置</span> : <span className="prompt-edit-tag is-custom">自定义</span>}
              </div>

              <div className="prompt-edit-body">
                <label className="prompt-field">
                  <span className="prompt-field-label">标签</span>
                  <input type="text" value={label} onChange={(e) => handleField(setLabel)(e.target.value)} />
                </label>

                {!isSystem && (
                  <>
                    <label className="prompt-field">
                      <span className="prompt-field-label">说明</span>
                      <input type="text" value={description} onChange={(e) => handleField(setDescription)(e.target.value)} />
                    </label>
                    <div className="prompt-field-row">
                      <label className="prompt-field">
                        <span className="prompt-field-label">分组</span>
                        <input type="text" value={groupName} onChange={(e) => handleField(setGroupName)(e.target.value)} />
                      </label>
                      <label className="prompt-field">
                        <span className="prompt-field-label">输出格式</span>
                        <select value={output} onChange={(e) => handleField(setOutput)(e.target.value as PromptOutput)}>
                          {OUTPUT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                    </div>
                    <div className="prompt-field-row">
                      <label className={`prompt-checkbox${item.builtin && item.required ? ' is-locked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={required}
                          disabled={item.builtin && item.required}
                          onChange={(e) => handleField(setRequired)(e.target.checked)}
                        />
                        必填项
                        {item.builtin && item.required ? <small>（内置必填，不可关闭）</small> : null}
                      </label>
                      <label className="prompt-checkbox">
                        <input type="checkbox" checked={enabled} onChange={(e) => handleField(setEnabled)(e.target.checked)} />
                        启用
                      </label>
                    </div>
                  </>
                )}

                <label className="prompt-field prompt-field-text">
                  <span className="prompt-field-label">提示词正文</span>
                  <textarea
                    value={promptText}
                    onChange={(e) => handleField(setPromptText)(e.target.value)}
                    rows={18}
                    spellCheck={false}
                  />
                </label>
              </div>

              <div className="prompt-edit-actions">
                <div className="prompt-edit-actions-left">
                  {builtin && (
                    <button type="button" className="text-button" onClick={() => void handleReset()} disabled={busy}>
                      恢复默认
                    </button>
                  )}
                  {!builtin && (
                    <button type="button" className="text-button is-danger" onClick={() => void handleDelete()} disabled={busy}>
                      删除
                    </button>
                  )}
                </div>
                <div className="prompt-edit-actions-right">
                  <Dialog.Close asChild>
                    <button type="button" className="secondary-action" disabled={busy}>取消</button>
                  </Dialog.Close>
                  <button type="button" className="primary-action" onClick={() => void handleSave()} disabled={busy || !dirty}>
                    {busy ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            </>
          )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default PromptEditDialog;
