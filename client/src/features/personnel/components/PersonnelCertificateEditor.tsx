// 证书编辑器（新增/编辑）：证书名/类别/到期/取得日期/备注 + 多文件。
// 复用 FileDropField（可靠上传）与 .asset-editor-modal 卡片样式；弹窗内嵌于人物详情之上（Radix 嵌套 Dialog）。
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  useAddCertificate,
  useUpdateCertificate,
  type PersonnelCertificate,
  type CertificateInput,
} from '../api/personnel';
import type { AssetFileMeta } from '../../asset-library/api/assetLibrary';
import { useToast } from '../../../shared/ui';
import FileDropField from '../../asset-library/components/FileDropField';

interface PersonnelCertificateEditorProps {
  profileId: string;
  cert: PersonnelCertificate | null; // null = 新建
  onClose: () => void;
}

interface ExistingFile extends AssetFileMeta {
  removed?: boolean;
}

const ACCEPT = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.md';

function toDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

function PersonnelCertificateEditor({ profileId, cert, onClose }: PersonnelCertificateEditorProps) {
  const { showToast } = useToast();
  const addMut = useAddCertificate(profileId);
  const updateMut = useUpdateCertificate(profileId);

  const [certName, setCertName] = useState('');
  const [certType, setCertType] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [obtainedAt, setObtainedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [existingFiles, setExistingFiles] = useState<ExistingFile[]>([]);
  const [newFiles, setNewFiles] = useState<File[]>([]);

  useEffect(() => {
    setCertName(cert?.certName ?? '');
    setCertType(cert?.certType ?? '');
    setExpiryDate(toDateInput(cert?.expiryDate));
    setObtainedAt(toDateInput(cert?.obtainedAt));
    setNotes(cert?.notes ?? '');
    setExistingFiles((cert?.files ?? []).map((f) => ({ ...f, removed: false })));
    setNewFiles([]);
  }, [cert]);

  const isEdit = !!cert;
  const saving = addMut.isPending || updateMut.isPending;

  const handlePick = (files: FileList | null) => {
    if (!files || !files.length) return;
    setNewFiles((prev) => [...prev, ...Array.from(files)]);
  };
  const removeExisting = (fileId: string) => {
    setExistingFiles((prev) => prev.map((f) => (f.fileId === fileId ? { ...f, removed: !f.removed } : f)));
  };
  const removeNew = (idx: number) => setNewFiles((prev) => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    const trimmed = certName.trim();
    if (!trimmed) {
      showToast('证书名称不能为空', 'error');
      return;
    }
    const input: CertificateInput = {
      certName: trimmed,
      certType,
      expiryDate: expiryDate || null,
      obtainedAt: obtainedAt || null,
      notes,
      files: newFiles,
    };
    try {
      if (isEdit && cert) {
        const removeFileIds = existingFiles.filter((f) => f.removed).map((f) => f.fileId);
        await updateMut.mutateAsync({ certId: cert.id, input: { ...input, removeFileIds } });
        showToast('已保存证书', 'success');
      } else {
        await addMut.mutateAsync(input);
        showToast('已添加证书', 'success');
      }
      onClose();
    } catch (err) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content className="asset-editor-modal">
          <div className="asset-editor-card">
            <Dialog.Title className="asset-editor-title">{isEdit ? '编辑证书' : '添加证书'}</Dialog.Title>

            <label className="asset-field">
              <span className="asset-field-label">证书名称</span>
              <input
                type="text"
                className="asset-field-input"
                value={certName}
                onChange={(e) => setCertName(e.target.value)}
                placeholder="如：一级建造师执业资格证书"
                autoFocus
              />
            </label>

            <label className="asset-field">
              <span className="asset-field-label">类别 / 专业</span>
              <input
                type="text"
                className="asset-field-input"
                value={certType}
                onChange={(e) => setCertType(e.target.value)}
                placeholder="如：建筑工程"
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
                <span className="asset-field-label">取得日期</span>
                <input
                  type="date"
                  className="asset-field-input"
                  value={obtainedAt}
                  onChange={(e) => setObtainedAt(e.target.value)}
                />
              </label>
            </div>

            <label className="asset-field">
              <span className="asset-field-label">备注</span>
              <textarea
                className="asset-field-input asset-field-textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="可选"
              />
            </label>

            <div className="asset-field">
              <span className="asset-field-label">证书文件</span>
              <FileDropField accept={ACCEPT} onPick={(files) => handlePick(files)} />

              {(existingFiles.some((f) => !f.removed) || newFiles.length > 0) && (
                <ul className="asset-file-list">
                  {existingFiles.map((f) => (
                    <li key={f.fileId} className={f.removed ? 'is-removed' : ''}>
                      <span className="asset-file-name" title={f.originalName}>{f.originalName}</span>
                      <button type="button" className="text-button" onClick={() => removeExisting(f.fileId)}>
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

export default PersonnelCertificateEditor;
