// 资产/资质条目预览：大图画廊（图片/PDF）+ 备注 + 文件列表（逐个下载）。
// 文件字节经 useAssetFileUrl 取 objectURL（Bearer 由 axios 注入，URL 不泄露 token）。
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  useAssetFileUrl,
  type AssetLibraryId,
  type AssetItem,
  type AssetFileMeta,
} from '../api/assetLibrary';
import { http } from '../../../shared/api/http';

interface AssetItemPreviewProps {
  open: boolean;
  library: AssetLibraryId;
  item: AssetItem | null;
  onClose: () => void;
}

function isImage(meta: AssetFileMeta): boolean {
  return meta.mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(meta.originalName);
}
function isPdf(meta: AssetFileMeta): boolean {
  return meta.mimeType === 'application/pdf' || /\.pdf$/i.test(meta.originalName);
}

// 下载：重新取 blob（避免依赖 viewer 是否已渲染该文件），用临时 <a> 触发保存。
async function downloadFile(library: AssetLibraryId, id: string, meta: AssetFileMeta) {
  try {
    const res = await http.get(`/asset-library/${library}/${id}/files/${meta.fileId}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.originalName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // ignore: 用户可重试
  }
}

function AssetFileViewer({ library, id, meta }: { library: AssetLibraryId; id: string; meta: AssetFileMeta }) {
  const url = useAssetFileUrl(library, id, meta.fileId);
  if (!url) return <div className="asset-preview-loading">加载中…</div>;
  if (isImage(meta)) {
    return <img className="asset-preview-image" src={url} alt={meta.originalName} />;
  }
  if (isPdf(meta)) {
    return <iframe className="asset-preview-pdf" title={meta.originalName} src={url} />;
  }
  return (
    <div className="asset-preview-unsupported">
      <span>该文件类型不支持在线预览</span>
      <button type="button" className="secondary-action" onClick={() => void downloadFile(library, id, meta)}>下载查看</button>
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

function AssetItemPreview({ open, library, item, onClose }: AssetItemPreviewProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  // 切换条目时重置到第一个文件（避免上一个条目的索引越界）
  useEffect(() => {
    setActiveIdx(0);
  }, [item?.id]);
  if (!item) return null;

  const safeIdx = activeIdx < item.files.length ? activeIdx : 0;
  const active = item.files[safeIdx];
  const expiry = formatExpiry(item.expiryDate);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (next === false) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content className="asset-preview-modal">
          <div className="asset-preview-card">
            <div className="asset-preview-head">
              <div>
                <Dialog.Title className="asset-preview-title">{item.name}</Dialog.Title>
                <div className="asset-preview-meta">
                  {expiry && <span className={`asset-expiry-badge is-${expiry.tone}`}>{expiry.text}</span>}
                  {item.tags.map((t) => <span key={t} className="asset-tag-chip">{t}</span>)}
                </div>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="asset-preview-close" aria-label="关闭">×</button>
              </Dialog.Close>
            </div>

            {item.files.length === 0 ? (
              <div className="asset-preview-empty">该条目暂无文件</div>
            ) : (
              <>
                <div className="asset-preview-stage">
                  <AssetFileViewer library={library} id={item.id} meta={active} />
                </div>
                <div className="asset-preview-files">
                  {item.files.map((f, idx) => (
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
                        onClick={(e) => { e.stopPropagation(); void downloadFile(library, item.id, f); }}
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

            {item.notes && (
              <div className="asset-preview-notes">
                <span className="asset-preview-notes-label">备注</span>
                <p>{item.notes}</p>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default AssetItemPreview;
