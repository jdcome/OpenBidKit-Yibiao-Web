import { useEffect, useState } from 'react';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, useToast } from '../../../shared/ui';
import { useCreateDoc, useDoc, useSaveDoc, type DocsSection } from '../api/docs';

interface DocEditorProps {
  mode: 'create' | 'edit';
  // edit 模式下要编辑的文章 id；create 模式忽略。
  id?: string;
  section: DocsSection;
  onSaved: (id: string) => void;
  onCancel: () => void;
}

export default function DocEditor({ mode, id, section, onSaved, onCancel }: DocEditorProps) {
  const { showToast } = useToast();
  const createDoc = useCreateDoc();
  const saveDoc = useSaveDoc();
  const { data: article, isLoading } = useDoc(mode === 'edit' ? id : undefined);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const busy = createDoc.isPending || saveDoc.isPending;

  // 文章加载完成后回填草稿（edit 模式）。
  useEffect(() => {
    if (mode === 'edit' && article) {
      setTitle(article.title);
      setContent(article.content);
    }
  }, [article, mode]);

  if (mode === 'edit' && (isLoading || !article)) {
    return <div className="docs-article docs-article--loading">加载中…</div>;
  }

  const handleSave = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      showToast('请填写标题', 'info');
      return;
    }
    try {
      if (mode === 'edit' && id) {
        const res = await saveDoc.mutateAsync({ id, title: trimmed, content });
        showToast('已保存', 'success');
        onSaved(res.id);
      } else {
        const res = await createDoc.mutateAsync({ section, title: trimmed, content });
        showToast('已创建', 'success');
        onSaved(res.id);
      }
    } catch (err: unknown) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <div className="docs-article doc-editor">
      <div className="doc-editor-head">
        <input
          className="doc-editor-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="文章标题"
          disabled={busy}
        />
        <div className="doc-editor-actions">
          <button type="button" className="secondary-action" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="primary-action" onClick={() => void handleSave()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
      <div className="docs-editor-grid">
        <div className="docs-edit-pane">
          <MarkdownEditor
            value={content}
            onChange={setContent}
            disabled={busy}
            placeholder="输入 Markdown 正文。图片用绝对路径，如 /docs/images/标注/xx.png"
            fullscreenTitle={mode === 'edit' ? '编辑文档' : '新建文档'}
          />
        </div>
        <MarkdownFullscreenViewer className="docs-preview-pane markdown-viewer" title={`${title || '文档'}全屏预览`}>
          {content.trim() ? (
            <MarkdownRenderer allowRawHtml={false}>{content}</MarkdownRenderer>
          ) : (
            <p className="content-editor-empty">暂无预览内容</p>
          )}
        </MarkdownFullscreenViewer>
      </div>
    </div>
  );
}
