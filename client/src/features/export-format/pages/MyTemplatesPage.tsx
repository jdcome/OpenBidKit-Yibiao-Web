import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/api/auth';
import type { ExportTemplateRecord } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { TemplatePreview } from './ExportFormatPage';

interface MyTemplatesPageProps {
  onCreateTemplate: () => void;
  onEditTemplate: (templateId: string) => void;
}

type TemplateFilter = 'mine' | 'shared' | 'all';

const templateDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function MyTemplatesPage({ onCreateTemplate, onEditTemplate }: MyTemplatesPageProps) {
  const { showToast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [filter, setFilter] = useState<TemplateFilter>('mine');
  const [templates, setTemplates] = useState<ExportTemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<ExportTemplateRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const visibleTemplates = useMemo(() => {
    if (filter === 'shared') return templates.filter((t) => t.is_shared);
    if (filter === 'all') return templates;
    // mine：当前用户创建的（含自己私有的 + 自己创建的共享）。
    return templates.filter((t) => t.owner_id === user?.id);
  }, [templates, filter, user?.id]);

  const selectedTemplate = visibleTemplates.find((t) => t.template_id === selectedId) || visibleTemplates[0] || null;
  const previewConfig = selectedTemplate?.config || DEFAULT_EXPORT_FORMAT;
  const previewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(previewConfig), [previewConfig]);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const items = await window.yibiao?.templates.list();
      const nextTemplates = items || [];
      setTemplates(nextTemplates);
      setSelectedId((prev) => (nextTemplates.some((t) => t.template_id === prev) ? prev : nextTemplates[0]?.template_id || ''));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取模板列表失败', 'error');
      setTemplates([]);
      setSelectedId('');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  // admin 切换到「全部用户」外的筛选时，若当前选中的 tab 被 admin 收回（不会发生，仅兜底）。
  const handleToggleShared = async (template: ExportTemplateRecord) => {
    setTogglingId(template.template_id);
    try {
      const next = !template.is_shared;
      await window.yibiao?.templates.setShared(template.template_id, next);
      showToast(next ? '已设为共享' : '已取消共享', 'success');
      await loadTemplates();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '调整共享失败', 'error');
    } finally {
      setTogglingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;

    setDeleting(true);
    try {
      const result = await window.yibiao?.templates.delete(deleteTarget.template_id);
      const nextTemplates = templates.filter((t) => t.template_id !== deleteTarget.template_id);
      setTemplates(nextTemplates);
      setSelectedId((prev) => (prev === deleteTarget.template_id ? nextTemplates[0]?.template_id || '' : prev));
      setDeleteTarget(null);
      showToast(result?.message || '模板已删除', result?.success === false ? 'info' : 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除模板失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const filterTabs: { key: TemplateFilter; label: string }[] = [
    { key: 'mine', label: '我的模板' },
    { key: 'shared', label: '共享模板' },
    ...(isAdmin ? [{ key: 'all' as const, label: '全部用户' }] : []),
  ];

  const emptyCopy = filter === 'shared'
    ? { strong: '还没有共享模板', span: '管理员将模板设为共享后，会出现在这里供全员使用。' }
    : filter === 'all'
      ? { strong: '还没有任何用户保存模板', span: '所有用户保存的导出模板都会汇总在这里。' }
      : { strong: '还没有保存模板', span: '进入新建模板页配置排版样式，保存后会出现在这里。' };

  return (
    <div className="template-library-page">
      <section className="template-library-panel" aria-label="我的模板">
        <div className="template-library-head">
          <div>
            <span className="section-kicker">模版设置</span>
            <h2>导出模板</h2>
            <p>查看、编辑和删除已保存的标书导出模板，共享模板全员可用。</p>
          </div>
          <button type="button" className="primary-action" onClick={onCreateTemplate}>新建模板</button>
        </div>

        <div className="template-library-filter" role="tablist" aria-label="模板筛选">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={filter === tab.key}
              className={`template-filter-tab${filter === tab.key ? ' is-active' : ''}`}
              onClick={() => { setFilter(tab.key); setSelectedId(''); }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="template-library-list">
          {loading ? <div className="template-library-empty"><strong>正在读取模板</strong><span>请稍候...</span></div> : null}
          {!loading && visibleTemplates.length === 0 ? (
            <div className="template-library-empty">
              <strong>{emptyCopy.strong}</strong>
              <span>{emptyCopy.span}</span>
              {filter === 'mine' ? <button type="button" className="primary-action" onClick={onCreateTemplate}>新建第一个模板</button> : null}
            </div>
          ) : null}
          {!loading && visibleTemplates.map((template) => {
            const selected = selectedTemplate?.template_id === template.template_id;
            const canEdit = !!template.can_edit;
            const busy = togglingId === template.template_id;
            return (
              <article className={`template-library-card${selected ? ' is-active' : ''}`} key={template.template_id}>
                <button type="button" className="template-library-card-main" onClick={() => setSelectedId(template.template_id)}>
                  <span className="template-library-card-title">
                    {template.template_name}
                    {template.is_shared ? <em className="template-shared-badge">共享</em> : null}
                  </span>
                  <small>
                    {filter === 'all' && template.owner_name ? `归属：${template.owner_name} · ` : ''}
                    更新于 {formatTemplateDate(template.updated_at)}
                  </small>
                </button>
                <div className="template-library-card-actions">
                  {isAdmin ? (
                    <button
                      type="button"
                      className={`template-share-toggle${template.is_shared ? ' is-on' : ''}`}
                      onClick={() => void handleToggleShared(template)}
                      disabled={busy}
                      title={template.is_shared ? '点击取消共享' : '点击设为共享'}
                    >
                      {busy ? '处理中' : template.is_shared ? '● 共享' : '○ 私有'}
                    </button>
                  ) : null}
                  {canEdit ? (
                    <>
                      <button type="button" onClick={() => onEditTemplate(template.template_id)}>编辑</button>
                      <button type="button" className="is-danger" onClick={() => setDeleteTarget(template)}>删除</button>
                    </>
                  ) : (
                    <span className="template-readonly-hint">只读</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="template-library-preview-shell" aria-label="模板预览">
        {selectedTemplate ? (
          <>
            <div className="template-library-preview-head">
              <div>
                <span className="section-kicker">实时预览</span>
                <h3>{selectedTemplate.template_name}</h3>
              </div>
              {selectedTemplate.can_edit ? (
                <button type="button" className="secondary-action" onClick={() => onEditTemplate(selectedTemplate.template_id)}>编辑模板</button>
              ) : null}
            </div>
            <TemplatePreview config={previewConfig} previewStyle={previewStyle} />
          </>
        ) : (
          <div className="template-library-preview-empty">
            <strong>暂无模板可预览</strong>
            <span>保存模板后，这里会展示模板效果。</span>
          </div>
        )}
      </section>

      <Dialog.Root open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="template-delete-dialog">
            <Dialog.Title>删除模板</Dialog.Title>
            <Dialog.Description>
              确定删除“{deleteTarget?.template_name || '未命名模板'}”吗？删除后无法在我的模板中继续编辑。
            </Dialog.Description>
            <div className="template-delete-actions">
              <Dialog.Close className="secondary-action" type="button" disabled={deleting}>取消</Dialog.Close>
              <button type="button" className="danger-action" onClick={() => void confirmDelete()} disabled={deleting}>{deleting ? '删除中' : '确认删除'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function formatTemplateDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '时间未知';
  }
  return templateDateFormatter.format(date);
}

export default MyTemplatesPage;
