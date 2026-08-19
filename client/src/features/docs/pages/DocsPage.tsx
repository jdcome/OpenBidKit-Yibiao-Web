import { useMemo, useState } from 'react';
import MarkdownRenderer from '../../../shared/ui/MarkdownRenderer';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/api/auth';
import ConfirmDialog from '../../../components/ConfirmDialog';
import DocEditor from '../components/DocEditor';
import {
  groupDocs,
  useDeleteDoc,
  useDoc,
  useDocs,
  useReorderDocs,
} from '../api/docs';

type Editing = { mode: 'create' | 'edit'; id?: string };

// 使用文档单 section 视图（由顶级菜单「使用文档」的子菜单 使用/配置 进入）。
// 旧版 3-tab（使用/配置/反馈）已拆分：反馈独立为顶级「问题FAQ」模块。
export default function DocsPage({ section }: { section: 'usage' | 'config' }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { showToast } = useToast();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  const { data: list } = useDocs();
  const grouped = useMemo(() => groupDocs(list ?? []), [list]);
  const items = grouped[section];
  const currentId = selectedId ?? items[0]?.id ?? null;
  const deleteDoc = useDeleteDoc();
  const reorderDocs = useReorderDocs();

  const { data: selectedDetail, isLoading: detailLoading } = useDoc(editing ? undefined : currentId);

  const selectItem = (id: string) => {
    setEditing(null);
    setSelectedId(id);
  };

  const startEdit = (id: string) => {
    setSelectedId(id);
    setEditing({ mode: 'edit', id });
  };

  const startCreate = () => {
    setEditing({ mode: 'create' });
  };

  const move = async (id: string, dir: -1 | 1) => {
    const idx = items.findIndex((it) => it.id === id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= items.length) return;
    const next = [...items];
    [next[idx], next[target]] = [next[target], next[idx]];
    const payload = next.map((it, i) => ({ id: it.id, sortOrder: i + 1 }));
    try {
      await reorderDocs.mutateAsync({ section, items: payload });
    } catch {
      showToast('排序失败', 'error');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteDoc.mutateAsync(deleting.id);
      showToast('已删除', 'success');
      if (currentId === deleting.id) setSelectedId(null);
      setDeleting(null);
    } catch {
      showToast('删除失败', 'error');
    }
  };

  return (
    <div className="docs-page">
      <div className="docs-body">
        <aside className="docs-sidebar">
          {items.length === 0 ? (
            <div className="docs-nav-empty">{isAdmin ? '暂无文章，点击下方新增' : '暂无文章'}</div>
          ) : (
            items.map((item, idx) => (
              <div
                key={item.id}
                className={`docs-nav-item ${item.id === currentId && !editing ? 'is-active' : ''}`}
                onClick={() => selectItem(item.id)}
              >
                <span className="docs-nav-item-title">{item.title}</span>
                {isAdmin && (
                  <div className="docs-nav-item-admin">
                    <button type="button" title="上移" disabled={idx === 0} onClick={(e) => { e.stopPropagation(); void move(item.id, -1); }}>↑</button>
                    <button type="button" title="下移" disabled={idx === items.length - 1} onClick={(e) => { e.stopPropagation(); void move(item.id, 1); }}>↓</button>
                    <button type="button" title="编辑" onClick={(e) => { e.stopPropagation(); startEdit(item.id); }}>✎</button>
                    <button type="button" title="删除" className="docs-nav-item-del" onClick={(e) => { e.stopPropagation(); setDeleting({ id: item.id, title: item.title }); }}>✕</button>
                  </div>
                )}
              </div>
            ))
          )}
          {isAdmin && (
            <button type="button" className="docs-nav-add" onClick={startCreate}>＋ 新增文章</button>
          )}
        </aside>

        <div className="docs-content" key={editing ? `edit-${editing.id ?? 'new'}` : currentId ?? 'empty'}>
          {editing ? (
            <DocEditor
              mode={editing.mode}
              id={editing.id}
              section={section}
              onSaved={(id) => {
                setEditing(null);
                if (id) setSelectedId(id);
              }}
              onCancel={() => setEditing(null)}
            />
          ) : selectedDetail ? (
            <div className="markdown-viewer docs-article">
              <MarkdownRenderer>{selectedDetail.content}</MarkdownRenderer>
            </div>
          ) : detailLoading ? (
            <div className="docs-article docs-article--loading">加载中…</div>
          ) : (
            <div className="docs-article docs-article--error">暂无内容</div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleting}
        title="确认删除文章"
        description={deleting ? `删除「${deleting.title}」？此操作不可撤销。` : undefined}
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
        busy={deleteDoc.isPending}
      />
    </div>
  );
}
