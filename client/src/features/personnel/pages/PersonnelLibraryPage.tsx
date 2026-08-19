// 人员资质库页：人物档案卡片网格（一人多证）。搜索 + 到期筛选 tab + 新增/详情/编辑/删除。
// 与 AssetLibraryPage 同 KB 风格；点击人物卡片打开详情弹窗管理其证书。
import { useMemo, useState } from 'react';
import {
  usePersonnelProfiles,
  useDeleteProfile,
  type ExpiryFilter,
  type PersonnelProfile,
} from '../api/personnel';
import { useToast } from '../../../shared/ui';
import ConfirmDialog from '../../../components/ConfirmDialog';
import PersonnelProfileEditor from '../components/PersonnelProfileEditor';
import PersonnelProfileDetail from '../components/PersonnelProfileDetail';

const TABS: { key: ExpiryFilter | undefined; label: string; count?: number }[] = [
  { key: undefined, label: '全部' },
  { key: 'expiring', label: '临期≤30天' },
  { key: 'expired', label: '已到期' },
];

function initial(name: string): string {
  const t = name.trim();
  return t ? t.slice(0, 1).toUpperCase() : '?';
}

function PersonnelLibraryPage() {
  const { showToast } = useToast();
  const [q, setQ] = useState('');
  const [expiry, setExpiry] = useState<ExpiryFilter | undefined>(undefined);
  const { data, isLoading } = usePersonnelProfiles({ q, expiry });
  const deleteMut = useDeleteProfile();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PersonnelProfile | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PersonnelProfile | null>(null);

  const counts = data?.counts ?? { expiring: 0, expired: 0 };
  const profiles = data?.profiles ?? [];

  const tabs = useMemo<{ key: ExpiryFilter | undefined; label: string; count?: number }[]>(
    () => [
      { ...TABS[0] },
      { ...TABS[1], count: counts.expiring },
      { ...TABS[2], count: counts.expired },
    ],
    [counts],
  );

  const handleNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const handleEdit = (profile: PersonnelProfile) => {
    setEditing(profile);
    setEditorOpen(true);
  };
  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMut.mutateAsync(deleting.id);
      showToast('已删除人员', 'success');
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
            <span className="section-kicker">人员资质</span>
            <h2>人员资质库</h2>
            <p>按人管理其资质证书，每本证书独立到期提醒。</p>
          </div>
          <button type="button" className="primary-action" onClick={handleNew}>+ 新增人员</button>
        </header>

        <div className="asset-library-toolbar">
          <input
            type="text"
            className="asset-library-input"
            placeholder="搜索姓名、部门、岗位或证书"
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
        ) : profiles.length === 0 ? (
          <div className="asset-library-empty">
            {q || expiry ? '无匹配人员' : '暂无人员，点击右上角「新增人员」建档'}
          </div>
        ) : (
          <div className="personnel-table-wrap">
            <table className="personnel-table">
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>部门</th>
                  <th>岗位</th>
                  <th>电话</th>
                  <th>证书</th>
                  <th>到期</th>
                  <th className="col-actions-head">操作</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr
                    key={p.id}
                    className="personnel-row"
                    title="点击查看详情"
                    onClick={() => setDetailId(p.id)}
                  >
                    <td className="col-name">
                      <span className="personnel-row-initial">{initial(p.name)}</span>
                      <span className="personnel-row-namecol">
                        <strong title={p.name}>{p.name}</strong>
                        {p.tags.length > 0 && (
                          <span className="personnel-row-tags">
                            {p.tags.map((t) => <span key={t} className="asset-tag-chip">{t}</span>)}
                          </span>
                        )}
                      </span>
                    </td>
                    <td>{p.department || '—'}</td>
                    <td>{p.position || '—'}</td>
                    <td className="col-phone">{p.phone || '—'}</td>
                    <td className="col-cert">{p.certCount} 本</td>
                    <td className="col-expiry">
                      {p.expiringCount === 0 && p.expiredCount === 0 ? (
                        <span className="personnel-row-muted">—</span>
                      ) : (
                        <span className="personnel-row-badges">
                          {p.expiringCount > 0 && <span className="asset-expiry-badge is-expiring">临期 {p.expiringCount}</span>}
                          {p.expiredCount > 0 && <span className="asset-expiry-badge is-expired">过期 {p.expiredCount}</span>}
                        </span>
                      )}
                    </td>
                    <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="text-button" onClick={() => handleEdit(p)}>编辑</button>
                      <button type="button" className="text-button is-danger" onClick={() => setDeleting(p)}>删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PersonnelProfileEditor
        open={editorOpen}
        profile={editing}
        onClose={() => setEditorOpen(false)}
      />
      <PersonnelProfileDetail
        profileId={detailId}
        onClose={() => setDetailId(null)}
        onEditProfile={(p) => { setDetailId(null); handleEdit(p); }}
        onDeleteProfile={(p) => { setDetailId(null); setDeleting(p); }}
      />
      <ConfirmDialog
        open={!!deleting}
        title="删除人员"
        description={`确认删除「${deleting?.name ?? ''}」？其全部证书及文件将被清除，此操作不可撤销。`}
        confirmText="删除"
        busy={deleteMut.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => { if (!deleteMut.isPending) setDeleting(null); }}
      />
    </div>
  );
}

export default PersonnelLibraryPage;
