// 资产/资质条目编辑器（新增/编辑）：名称/备注/到期日/标签/多文件。
// 弹窗遵循项目规范：fixed + overflow-y-auto + 10vh padding，禁用 items-center 居中（防长内容被裁切）。
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  useCreateAssetItem,
  useUpdateAssetItem,
  type AssetLibraryId,
  type AssetItem,
  type AssetFileMeta,
} from '../api/assetLibrary';
import { useToast } from '../../../shared/ui';
import FileDropField from './FileDropField';

interface AssetItemEditorProps {
  open: boolean;
  library: AssetLibraryId;
  item: AssetItem | null; // null = 新建
  onClose: () => void;
}

interface ExistingFile extends AssetFileMeta {
  /** 标记本次编辑中被移除的旧文件，保存时不提交其 id。 */
  removed?: boolean;
}

const ACCEPT = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.md';

function toDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

function AssetItemEditor({ open, library, item, onClose }: AssetItemEditorProps) {
  const { showToast } = useToast();
  const createMut = useCreateAssetItem(library);
  const updateMut = useUpdateAssetItem(library);

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [tags, setTags] = useState('');
  const [existingFiles, setExistingFiles] = useState<ExistingFile[]>([]);
  const [newFiles, setNewFiles] = useState<File[]>([]);

  // 每次打开时按 item 重置表单（新建清空，编辑回填）。
  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? '');
    setNotes(item?.notes ?? '');
    setExpiryDate(toDateInput(item?.expiryDate));
    setTags((item?.tags ?? []).join(', '));
    setExistingFiles((item?.files ?? []).map((f) => ({ ...f, removed: false })));
    setNewFiles([]);
  }, [open, item]);

  const isEdit = !!item;
  const saving = createMut.isPending || updateMut.isPending;

  const handlePick = (files: FileList | null) => {
    if (!files || !files.length) return;
    setNewFiles((prev) => [...prev, ...Array.from(files)]);
  };

  const removeExisting = (fileId: string) => {
    setExistingFiles((prev) => prev.map((f) => (f.fileId === fileId ? { ...f, removed: !f.removed } : f)));
  };

  const removeNew = (idx: number) => setNewFiles((prev) => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('名称不能为空', 'error');
      return;
    }
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      if (isEdit && item) {
        const removeFileIds = existingFiles.filter((f) => f.removed).map((f) => f.fileId);
        await updateMut.mutateAsync({
          id: item.id,
          input: {
            name: trimmed,
            notes,
            expiryDate: expiryDate || null,
            tags: tagList,
            files: newFiles,
            removeFileIds,
          },
        });
        showToast('已保存修改', 'success');
      } else {
        await createMut.mutateAsync({
          name: trimmed,
          notes,
          expiryDate: expiryDate || null,
          tags: tagList,
          files: newFiles,
        });
        showToast('已新增条目', 'success');
      }
      onClose();
    } catch (err) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content className="asset-editor-modal">
          <div className="asset-editor-card">
            <Dialog.Title className="asset-editor-title">
              {isEdit ? '编辑条目' : '新增条目'}
            </Dialog.Title>

            <label className="asset-field">
              <span className="asset-field-label">名称</span>
              <input
                type="text"
                className="asset-field-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：xxx 软件著作权登记书"
                autoFocus
              />
            </label>

            <label className="asset-field">
              <span className="asset-field-label">备注</span>
              <textarea
                className="asset-field-input asset-field-textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="可选：用途、适用范围、说明等"
              />
            </label>

            <div className="asset-field-row">
              <label className="asset-field">
                <span className="asset-field-label">到期日期</span>
                <input
                  type="date"
                  className="asset-field-input"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                />
              </label>
              <label className="asset-field">
                <span className="asset-field-label">标签</span>
                <input
                  type="text"
                  className="asset-field-input"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="逗号分隔，如：软著, 平台"
                />
              </label>
            </div>

            <div className="asset-field">
              <span className="asset-field-label">文件</span>
              <FileDropField accept={ACCEPT} onPick={(files) => handlePick(files)} />

              {(existingFiles.some((f) => !f.removed) || newFiles.length > 0) && (
                <ul className="asset-file-list">
                  {existingFiles.map((f) => (
                    <li key={f.fileId} className={f.removed ? 'is-removed' : ''}>
                      <span className="asset-file-name" title={f.originalName}>{f.originalName}</span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => removeExisting(f.fileId)}
                      >
                        {f.removed ? '撤销' : '移除'}
                      </button>
                    </li>
                  ))}
                  {newFiles.map((f, idx) => (
                    <li key={`${f.name}-${idx}`}>
                      <span className="asset-file-name" title={f.name}>{f.name}</span>
                      <button type="button" className="text-button" onClick={() => removeNew(idx)}>移除</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="asset-editor-actions">
              <Dialog.Close asChild>
                <button type="button" className="secondary-action" disabled={saving}>取消</button>
              </Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void handleSave()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default AssetItemEditor;
