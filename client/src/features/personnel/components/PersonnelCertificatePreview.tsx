// 证书文件预览：大图画廊（图片/PDF）+ 备注 + 文件下载。
// 对标 AssetItemPreview；文件经 usePersonnelFileUrl 取 objectURL（Bearer 由 axios 注入）。
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { usePersonnelFileUrl, type PersonnelCertificate } from '../api/personnel';
import type { AssetFileMeta } from '../../asset-library/api/assetLibrary';
import { http } from '../../../shared/api/http';

interface PersonnelCertificatePreviewProps {
  open: boolean;
  profileId: string | null;
  cert: PersonnelCertificate | null;
  onClose: () => void;
}

function isImage(meta: AssetFileMeta): boolean {
  return meta.mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(meta.originalName);
}
function isPdf(meta: AssetFileMeta): boolean {
  return meta.mimeType === 'application/pdf' || /\.pdf$/i.test(meta.originalName);
}

async function downloadFile(profileId: string, certId: string, meta: AssetFileMeta) {
  try {
    const res = await http.get(`/personnel/${profileId}/certificates/${certId}/files/${meta.fileId}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.originalName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // ignore
  }
}

function CertFileViewer({ profileId, certId, meta }: { profileId: string; certId: string; meta: AssetFileMeta }) {
  const url = usePersonnelFileUrl(profileId, certId, meta.fileId);
  if (!url) return <div className="asset-preview-loading">加载中…</div>;
  if (isImage(meta)) return <img className="asset-preview-image" src={url} alt={meta.originalName} />;
  if (isPdf(meta)) return <iframe className="asset-preview-pdf" title={meta.originalName} src={url} />;
  return (
    <div className="asset-preview-unsupported">
      <span>该文件类型不支持在线预览</span>
      <button type="button" className="secondary-action" onClick={() => void downloadFile(profileId, certId, meta)}>下载查看</button>
    </div>
  );
}

function formatExpiry(iso: string | null): { text: string; tone: 'expired' | 'expiring' | 'ok' } | null {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  const date = iso.slice(0, 10);
  if (days < 0) return { text: `已过期 · ${date}`, tone: 'expired' };
  if (days <= 30) return { text: `临期 ${days} 天 · ${date}`, tone: 'expiring' };
  return { text: `到期 ${date}`, tone: 'ok' };
}

function PersonnelCertificatePreview({ open, profileId, cert, onClose }: PersonnelCertificatePreviewProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    setActiveIdx(0);
  }, [cert?.id]);

  if (!open || !cert || !profileId) return null;
  const safeIdx = activeIdx < cert.files.length ? activeIdx : 0;
  const active = cert.files[safeIdx];
  const expiry = formatExpiry(cert.expiryDate);

  return (
    <Dialog.Root open onOpenChange={(next) => { if (next === false) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content className="asset-preview-modal">
          <div className="asset-preview-card">
            <div className="asset-preview-head">
              <div>
                <Dialog.Title className="asset-preview-title">{cert.certName}</Dialog.Title>
                <div className="asset-preview-meta">
                  {cert.certType && <span className="asset-tag-chip">{cert.certType}</span>}
                  {expiry && <span className={`asset-expiry-badge is-${expiry.tone}`}>{expiry.text}</span>}
                </div>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="asset-preview-close" aria-label="关闭">×</button>
              </Dialog.Close>
            </div>

            {cert.files.length === 0 ? (
              <div className="asset-preview-empty">该证书暂无文件</div>
            ) : (
              <>
                <div className="asset-preview-stage">
                  <CertFileViewer profileId={profileId} certId={cert.id} meta={active} />
                </div>
                <div className="asset-preview-files">
                  {cert.files.map((f, idx) => (
                    <button
                      key={f.fileId}
                      type="button"
                      className={`asset-preview-thumb${idx === activeIdx ? ' is-active' : ''}`}
                      onClick={() => setActiveIdx(idx)}
                      title={f.originalName}
                    >
                      <span className="asset-preview-thumb-name">{f.originalName}</span>
                      <span
                        className="asset-preview-thumb-dl"
                        onClick={(e) => { e.stopPropagation(); void downloadFile(profileId, cert.id, f); }}
                        role="button"
                        tabIndex={-1}
                        aria-label="下载"
                      >
                        下载
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {cert.notes && (
              <div className="asset-preview-notes">
                <span className="asset-preview-notes-label">备注</span>
                <p>{cert.notes}</p>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default PersonnelCertificatePreview;
