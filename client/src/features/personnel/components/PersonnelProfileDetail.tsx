// 人物详情大弹窗：头部信息 + 证书列表（一人多证，每本独立到期）+ 添加/编辑/删除/预览证书。
// 遵循项目弹窗规范：fixed + overflow-y-auto + 10vh，禁 items-center。证书编辑/预览为嵌套 Radix Dialog。
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  usePersonnelProfile,
  useDeleteCertificate,
  type PersonnelCertificate,
  type PersonnelProfile,
} from '../api/personnel';
import { useToast } from '../../../shared/ui';
import ConfirmDialog from '../../../components/ConfirmDialog';
import PersonnelCertificateEditor from './PersonnelCertificateEditor';
import PersonnelCertificatePreview from './PersonnelCertificatePreview';

interface PersonnelProfileDetailProps {
  profileId: string | null;
  onClose: () => void;
  onEditProfile: (profile: PersonnelProfile) => void;
  onDeleteProfile: (profile: PersonnelProfile) => void;
}

function certExpiry(iso: string | null): { text: string; tone: 'expired' | 'expiring' | 'ok' | 'none' } {
  if (!iso) return { text: '无到期', tone: 'none' };
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  const date = iso.slice(0, 10);
  if (days < 0) return { text: `已过期 · ${date}`, tone: 'expired' };
  if (days <= 30) return { text: `临期 ${days} 天 · ${date}`, tone: 'expiring' };
  return { text: `到期 ${date}`, tone: 'ok' };
}

function PersonnelProfileDetail({
  profileId,
  onClose,
  onEditProfile,
  onDeleteProfile,
}: PersonnelProfileDetailProps) {
  const { showToast } = useToast();
  const { data: profile, isLoading } = usePersonnelProfile(profileId);
  const deleteCertMut = useDeleteCertificate(profileId ?? '');

  const [editingCert, setEditingCert] = useState<PersonnelCertificate | null>(null);
  const [certEditorOpen, setCertEditorOpen] = useState(false);
  const [previewCert, setPreviewCert] = useState<PersonnelCertificate | null>(null);
  const [deletingCert, setDeletingCert] = useState<PersonnelCertificate | null>(null);

  // 关闭详情时清空内部弹窗状态
  useEffect(() => {
    if (!profileId) {
      setEditingCert(null);
      setCertEditorOpen(false);
      setPreviewCert(null);
      setDeletingCert(null);
    }
  }, [profileId]);

  const open = !!profileId;

  const handleAddCert = () => {
    setEditingCert(null);
    setCertEditorOpen(true);
  };
  const handleEditCert = (cert: PersonnelCertificate) => {
    setEditingCert(cert);
    setCertEditorOpen(true);
  };
  const handleDeleteCert = async () => {
    if (!deletingCert) return;
    try {
      await deleteCertMut.mutateAsync(deletingCert.id);
      showToast('已删除证书', 'success');
      setDeletingCert(null);
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content className="personnel-detail-modal">
          <div className="personnel-detail-card">
            {isLoading || !profile ? (
              <div className="asset-library-empty">加载中…</div>
            ) : (
              <>
                <div className="personnel-detail-head">
                  <div className="personnel-detail-headtext">
                    <Dialog.Title className="personnel-detail-title">{profile.name}</Dialog.Title>
                    <div className="personnel-detail-sub">
                      {[profile.department, profile.position].filter(Boolean).join(' · ')}
                      {profile.phone && <span className="personnel-detail-phone">{profile.phone}</span>}
                    </div>
                    {profile.tags.length > 0 && (
                      <div className="asset-card-tags">
                        {profile.tags.map((t) => <span key={t} className="asset-tag-chip">{t}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="personnel-detail-headactions">
                    <button type="button" className="text-button" onClick={() => onEditProfile(profile)}>编辑人员</button>
                    <button type="button" className="text-button is-danger" onClick={() => onDeleteProfile(profile)}>删除人员</button>
                    <Dialog.Close asChild>
                      <button type="button" className="asset-preview-close" aria-label="关闭">×</button>
                    </Dialog.Close>
                  </div>
                </div>

                {profile.notes && <p className="personnel-detail-notes">{profile.notes}</p>}

                <div className="personnel-cert-section">
                  <div className="personnel-cert-section-head">
                    <h3>资质证书（{profile.certificates.length}）</h3>
                    <button type="button" className="primary-action personnel-cert-add" onClick={handleAddCert}>+ 添加证书</button>
                  </div>

                  {profile.certificates.length === 0 ? (
                    <div className="asset-library-empty">暂无证书，点击「添加证书」开始建档</div>
                  ) : (
                    <ul className="personnel-cert-list">
                      {profile.certificates.map((cert) => {
                        const exp = certExpiry(cert.expiryDate);
                        return (
                          <li key={cert.id} className="personnel-cert-row">
                            <div className="personnel-cert-info">
                              <div className="personnel-cert-name-row">
                                <strong className="personnel-cert-name" title={cert.certName}>{cert.certName}</strong>
                                <span className={`asset-expiry-badge is-${exp.tone}`}>{exp.text}</span>
                              </div>
                              {cert.certType && <span className="personnel-cert-type">{cert.certType}</span>}
                              <div className="personnel-cert-meta">
                                {cert.files.length > 0 && <span>{cert.files.length} 个文件</span>}
                                {cert.obtainedAt && <span>取得于 {cert.obtainedAt.slice(0, 10)}</span>}
                                {cert.notes && <span className="personnel-cert-notes" title={cert.notes}>{cert.notes}</span>}
                              </div>
                            </div>
                            <div className="personnel-cert-actions">
                              {cert.files.length > 0 && (
                                <button type="button" onClick={() => setPreviewCert(cert)}>预览</button>
                              )}
                              <button type="button" onClick={() => handleEditCert(cert)}>编辑</button>
                              <button type="button" className="is-danger" onClick={() => setDeletingCert(cert)}>删除</button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      {certEditorOpen && profileId && (
        <PersonnelCertificateEditor
          profileId={profileId}
          cert={editingCert}
          onClose={() => setCertEditorOpen(false)}
        />
      )}
      <PersonnelCertificatePreview
        open={!!previewCert}
        profileId={profileId}
        cert={previewCert}
        onClose={() => setPreviewCert(null)}
      />
      <ConfirmDialog
        open={!!deletingCert}
        title="删除证书"
        description={`确认删除证书「${deletingCert?.certName ?? ''}」及其全部文件？此操作不可撤销。`}
        confirmText="删除"
        busy={deleteCertMut.isPending}
        onConfirm={() => void handleDeleteCert()}
        onCancel={() => { if (!deleteCertMut.isPending) setDeletingCert(null); }}
      />
    </Dialog.Root>
  );
}

export default PersonnelProfileDetail;
