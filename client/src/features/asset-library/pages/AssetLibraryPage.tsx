// 资产/资质库页（三库共用，library prop 区分）：搜索 + 到期筛选 tab + 卡片网格 + 新增/编辑/预览/删除。
// 不在列表拉文件字节（避免 N 次 blob 请求）；缩略用占位图块，预览弹窗才取真实文件。
import { useMemo, useState } from 'react';
import {
  useAssetItems,
  useDeleteAssetItem,
  type AssetLibraryId,
  type AssetItem,
  type ExpiryFilter,
} from '../api/assetLibrary';
import { useToast } from '../../../shared/ui';
import ConfirmDialog from '../../../components/ConfirmDialog';
import AssetItemEditor from '../components/AssetItemEditor';
import AssetItemPreview from '../components/AssetItemPreview';

interface AssetLibraryPageProps {
  library: AssetLibraryId;
}

const LIBRARY_META: Record<AssetLibraryId, { title: string; kicker: string; description: string }> = {
  tool: { title: '工具模板库', kicker: '工具资产', description: '工具功能截图、软著、采购证明等。' },
  company: { title: '公司资质库', kicker: '公司资质', description: '公司资质证书、认证证书等，支持到期提醒。' },
  personnel: { title: '人员资质库', kicker: '人员资质', description: '人员资质证书、证书等，支持到期提醒。' },
};

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

function AssetLibraryPage({ library }: AssetLibraryPageProps) {
  const meta = LIBRARY_META[library];
  const { showToast } = useToast();
  const [q, setQ] = useState('');
  const [expiry, setExpiry] = useState<ExpiryFilter | undefined>(undefined);
  const { data, isLoading } = useAssetItems(library, { q, expiry });
  const deleteMut = useDeleteAssetItem(library);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [previewItem, setPreviewItem] = useState<AssetItem | null>(null);
  const [deleting, setDeleting] = useState<AssetItem | null>(null);

  const counts = data?.counts ?? { expiring: 0, expired: 0 };
  const items = data?.items ?? [];

  const tabs = useMemo(
    () => [
      { key: undefined as ExpiryFilter | undefined, label: '全部' },
      { key: 'expiring' as ExpiryFilter, label: '临期≤30天', count: counts.expiring },
      { key: 'expired' as ExpiryFilter, label: '已到期', count: counts.expired },
    ],
    [counts],
  );

  const handleNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const handleEdit = (item: AssetItem) => {
    setEditing(item);
    setEditorOpen(true);
  };
  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMut.mutateAsync(deleting.id);
      showToast('已删除', 'success');
      setDeleting(null);
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <div className="asset-library-page">
      <div className="asset-library-shell">
        <header className="asset-library-head">
          <div className="asset-library-head-text">
            <span className="section-kicker">{meta.kicker}</span>
            <h2>{meta.title}</h2>
            <p>{meta.description}</p>
          </div>
          <button type="button" className="primary-action" onClick={handleNew}>+ 新增条目</button>
        </header>

        <div className="asset-library-toolbar">
          <input
            type="text"
            className="asset-library-input"
            placeholder="搜索名称、备注或标签"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="asset-library-tabs">
            {tabs.map((t) => (
              <button
                key={String(t.key)}
                type="button"
                className={`asset-library-tab${expiry === t.key ? ' is-active' : ''}`}
                onClick={() => setExpiry(t.key)}
              >
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span className={`asset-library-tab-count${t.key === 'expired' ? ' is-danger' : ''}`}>{t.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="asset-library-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="asset-library-empty">
            {q || expiry ? '无匹配条目' : '暂无条目，点击右上角「新增条目」上传'}
          </div>
        ) : (
          <div className="asset-card-grid">
            {items.map((item) => {
              const d = daysUntil(item.expiryDate);
              const hasImg = item.files.some((f) => f.mimeType.startsWith('image/'));
              return (
                <article key={item.id} className="asset-card">
                  <button
                    type="button"
                    className={`asset-card-thumb${hasImg ? ' is-image' : ''}`}
                    onClick={() => setPreviewItem(item)}
                    aria-label="预览"
                  >
                    <span className="asset-card-thumb-icon" aria-hidden="true">
                      {hasImg ? <ImageGlyph /> : <FileGlyph />}
                    </span>
                    <span className="asset-card-thumb-count">{item.files.length} 个文件</span>
                  </button>
                  <div className="asset-card-body">
                    <div className="asset-card-title-row">
                      <strong className="asset-card-name" title={item.name}>{item.name}</strong>
                      {d !== null && d < 0 && <span className="asset-expiry-badge is-expired">已过期</span>}
                      {d !== null && d >= 0 && d <= 30 && (
                        <span className="asset-expiry-badge is-expiring">临期 {d}天</span>
                      )}
                    </div>
                    {item.notes && <p className="asset-card-notes">{item.notes}</p>}
                    {item.tags.length > 0 && (
                      <div className="asset-card-tags">
                        {item.tags.map((t) => <span key={t} className="asset-tag-chip">{t}</span>)}
                      </div>
                    )}
                    <div className="asset-card-actions">
                      <button type="button" onClick={() => setPreviewItem(item)}>预览</button>
                      <button type="button" onClick={() => handleEdit(item)}>编辑</button>
                      <button type="button" className="is-danger" onClick={() => setDeleting(item)}>删除</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <AssetItemEditor
        open={editorOpen}
        library={library}
        item={editing}
        onClose={() => setEditorOpen(false)}
      />
      <AssetItemPreview
        open={!!previewItem}
        library={library}
        item={previewItem}
        onClose={() => setPreviewItem(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        title="删除条目"
        description={`确认删除「${deleting?.name ?? ''}」？其全部文件将被清除，此操作不可撤销。`}
        confirmText="删除"
        busy={deleteMut.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => { if (!deleteMut.isPending) setDeleting(null); }}
      />
    </div>
  );
}

function FileGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3.75h6.7L18 8.05v12.2H7z" />
      <path d="M13.5 4v4.35h4.25" />
      <path d="M9.5 12.8h5" />
      <path d="M9.5 16h3.5" />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5.5" width="16" height="13" rx="2" />
      <circle cx="9" cy="10" r="1.4" />
      <path d="m5 17 4.2-4.2 3.1 3.1 2.6-2.6L19 17" />
    </svg>
  );
}

export default AssetLibraryPage;
