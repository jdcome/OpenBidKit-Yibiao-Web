// 人员档案编辑器（新增/编辑）：姓名/部门/岗位/电话/备注/标签。
// 弹窗复用 .asset-editor-modal/.asset-editor-card（fixed + overflow-y-auto + 10vh，禁 items-center）。
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreateProfile, useUpdateProfile, type PersonnelProfile } from '../api/personnel';
import { useToast } from '../../../shared/ui';

interface PersonnelProfileEditorProps {
  open: boolean;
  profile: PersonnelProfile | null; // null = 新建
  onClose: () => void;
}

function PersonnelProfileEditor({ open, profile, onClose }: PersonnelProfileEditorProps) {
  const { showToast } = useToast();
  const createMut = useCreateProfile();
  const updateMut = useUpdateProfile();

  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [position, setPosition] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? '');
    setDepartment(profile?.department ?? '');
    setPosition(profile?.position ?? '');
    setPhone(profile?.phone ?? '');
    setNotes(profile?.notes ?? '');
    setTags((profile?.tags ?? []).join(', '));
  }, [open, profile]);

  const isEdit = !!profile;
  const saving = createMut.isPending || updateMut.isPending;

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('姓名不能为空', 'error');
      return;
    }
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      if (isEdit && profile) {
        await updateMut.mutateAsync({
          id: profile.id,
          input: { name: trimmed, department, position, phone, notes, tags: tagList },
        });
        showToast('已保存修改', 'success');
      } else {
        await createMut.mutateAsync({ name: trimmed, department, position, phone, notes, tags: tagList });
        showToast('已新增人员', 'success');
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
            <Dialog.Title className="asset-editor-title">{isEdit ? '编辑人员' : '新增人员'}</Dialog.Title>

            <label className="asset-field">
              <span className="asset-field-label">姓名</span>
              <input
                type="text"
                className="asset-field-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：张三"
                autoFocus
              />
            </label>

            <div className="asset-field-row">
              <label className="asset-field">
                <span className="asset-field-label">部门</span>
                <input
                  type="text"
                  className="asset-field-input"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="如：技术部"
                />
              </label>
              <label className="asset-field">
                <span className="asset-field-label">岗位</span>
                <input
                  type="text"
                  className="asset-field-input"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  placeholder="如：项目经理"
                />
              </label>
            </div>

            <div className="asset-field-row">
              <label className="asset-field">
                <span className="asset-field-label">联系电话</span>
                <input
                  type="text"
                  className="asset-field-input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="可选"
                />
              </label>
              <label className="asset-field">
                <span className="asset-field-label">标签</span>
                <input
                  type="text"
                  className="asset-field-input"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="逗号分隔"
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

export default PersonnelProfileEditor;
