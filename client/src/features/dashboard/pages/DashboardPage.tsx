// 仪表盘：项目统计卡片 + 项目列表（搜索/筛选/新建/查看/删除）。对标 92 Dashboard.vue。
// 视觉沿用应用设计令牌与既有面板/表格/弹窗词汇，不再使用内联深色样式。
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProjectStats, deleteProject, updateProject, type Project } from '../../../shared/api/projects';
import { useProject } from '../../../app/ProjectContext';
import { useAuth } from '../../../shared/api/auth';
import { useToast } from '../../../shared/ui';
import CreateProjectModal from '../../../components/CreateProjectModal';
import BlockCreateProjectDialog from '../../../components/BlockCreateProjectDialog';
import AssetExpiryWidget from '../components/AssetExpiryWidget';
import type { SectionId } from '../../../shared/types/navigation';

interface DashboardPageProps {
  onSectionChange: (section: SectionId) => void;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: '#98a2b3' },
  active: { label: '进行中', color: '#2174fd' },
  submitted: { label: '已提交', color: '#5b54d3' },
  completed: { label: '已完成', color: '#168a4a' },
};

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function DashboardPage({ onSectionChange }: DashboardPageProps) {
  const { projects, switchTo, createAndSwitch } = useProject();
  const { user } = useAuth();
  const { showToast } = useToast();
  const qc = useQueryClient();
  const { data: stats } = useQuery({ queryKey: ['projects', 'stats'], queryFn: fetchProjectStats });

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [blockProject, setBlockProject] = useState<Project | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (!kw) return true;
      return p.name.toLowerCase().includes(kw) || p.projectCode.toLowerCase().includes(kw);
    });
  }, [projects, search, statusFilter]);

  const handleOpen = async (p: Project) => {
    try {
      await switchTo(p.id);
      onSectionChange(p.isComplete ? 'project-summary' : 'technical-plan');
    } catch (err) {
      showToast(`切换失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  // 第5点：普通用户存在未完成项目时禁止新建。选取最近更新的未完成项目（与后端 POST 守卫一致）。
  const firstIncomplete = () => {
    const sorted = [...projects]
      .filter((p) => p.isComplete === false)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sorted[0] ?? null;
  };

  const handleNewClick = () => {
    if (user?.role !== 'admin') {
      const incomplete = firstIncomplete();
      if (incomplete) {
        setBlockProject(incomplete);
        return;
      }
    }
    setShowCreate(true);
  };

  const handleBlockContinue = async () => {
    if (!blockProject) return;
    try {
      await switchTo(blockProject.id);
      setBlockProject(null);
      onSectionChange('technical-plan');
    } catch (err) {
      showToast(`切换失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleBlockDelete = async () => {
    if (!blockProject) return;
    setBlockBusy(true);
    try {
      await deleteProject(blockProject.id);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
      setBlockProject(null);
      showToast('已删除未完成项目，可继续新建', 'success');
      setShowCreate(true);
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBlockBusy(false);
    }
  };

  const handleDelete = async (p: Project) => {
    if (!window.confirm(`确认删除项目「${p.name}」？其工作区数据将被清空，此操作不可撤销。`)) return;
    try {
      await deleteProject(p.id);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
      showToast('项目已删除', 'success');
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const startRename = (p: Project) => {
    setEditingId(p.id);
    setEditingName(p.name);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingName('');
  };

  const commitRename = async (p: Project) => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      showToast('项目名称不能为空', 'error');
      setEditingId(null);
      setEditingName('');
      return;
    }
    if (trimmed === p.name) {
      setEditingId(null);
      setEditingName('');
      return;
    }
    try {
      await updateProject(p.id, { name: trimmed });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
      showToast('项目名称已更新', 'success');
    } catch (err) {
      showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setEditingId(null);
      setEditingName('');
    }
  };

  const cards = [
    { label: '项目总数', value: stats?.total ?? 0, hint: '全部项目' },
    { label: '进行中任务', value: stats?.runningTasks ?? 0, hint: '当前运行中的生成任务' },
    { label: '本月新增', value: stats?.thisMonth ?? 0, hint: '本月新建项目' },
    { label: '完成率', value: `${stats?.completionRate ?? 0}%`, hint: '已完成项目占比' },
  ];

  return (
    <div className="dashboard-page">
      <div className="dashboard-shell">
        <header className="dashboard-head">
          <div className="dashboard-head-text">
            <span className="section-kicker">项目仪表盘</span>
            <h2>项目总览与统计</h2>
            <p>查看全部项目、运行中的生成任务与完成进度，新建或进入项目工作区。</p>
          </div>
          <button type="button" className="primary-action" onClick={handleNewClick}>
            + 新建项目
          </button>
        </header>

        {/* 统计卡片 */}
        <div className="dashboard-stats">
          {cards.map((c) => (
            <article key={c.label} className="dashboard-stat">
              <span className="dashboard-stat-label">{c.label}</span>
              <span className="dashboard-stat-value">{c.value}</span>
              <span className="dashboard-stat-hint">{c.hint}</span>
            </article>
          ))}
        </div>

        {/* 资质到期提醒（无临期/已到期时不渲染） */}
        <AssetExpiryWidget onSectionChange={onSectionChange} />

        {/* 工具栏 */}
        <div className="dashboard-toolbar">
          <input
            type="text"
            className="dashboard-input"
            placeholder="搜索项目编号或名称"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="dashboard-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="draft">草稿</option>
            <option value="active">进行中</option>
            <option value="submitted">已提交</option>
            <option value="completed">已完成</option>
          </select>
        </div>

        {/* 项目表 */}
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>编号</th>
              <th>项目名称</th>
              <th>创建人</th>
              <th>状态</th>
              <th>进度</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="dashboard-empty">
                  {projects.length === 0 ? '暂无项目，点击右上角「新建项目」开始' : '无匹配项目'}
                </td>
              </tr>
            )}
            {filtered.map((p) => {
              const meta = STATUS_META[p.status] ?? STATUS_META.draft;
              return (
                <tr key={p.id}>
                  <td><code>{p.projectCode}</code></td>
                  <td className="col-name">
                    {editingId === p.id ? (
                      <input
                        type="text"
                        className="dashboard-rename-input"
                        value={editingName}
                        autoFocus
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void commitRename(p); }
                          else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                        }}
                        onBlur={() => void commitRename(p)}
                      />
                    ) : (
                      <strong onDoubleClick={() => startRename(p)} title="双击编辑">{p.name}</strong>
                    )}
                    {p.description ? <small>{p.description}</small> : null}
                  </td>
                  <td>{p.ownerName || '—'}</td>
                  <td>
                    <span
                      className="dashboard-pill"
                      style={{ color: meta.color, background: `${meta.color}1f` }}
                    >
                      {meta.label}
                    </span>
                  </td>
                  <td>
                    <div className="dashboard-progress">
                      <span className="dashboard-progress-track">
                        <span
                          className="dashboard-progress-fill"
                          style={{ width: `${p.progress ?? 0}%` }}
                        />
                      </span>
                      <span className="dashboard-progress-value">{p.progress ?? 0}%</span>
                    </div>
                  </td>
                  <td>{formatDate(p.updatedAt)}</td>
                  <td>
                    <div className="dashboard-row-actions">
                      <button type="button" className="text-button" onClick={() => void handleOpen(p)}>查看</button>
                      <button type="button" className="text-button is-danger" onClick={() => void handleDelete(p)}>删除</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <CreateProjectModal
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreate={async (name, description) => {
          try {
            await createAndSwitch(name, description);
          } catch (err) {
            // 后端守卫兜底：列表过期/竞态下 POST 仍可能 409，带冲突编号则弹阻断框。
            const ex = err as { response?: { status?: number; data?: { conflictingProjectCode?: string } } };
            if (ex.response?.status === 409 && ex.response.data?.conflictingProjectCode) {
              const conflicting = projects.find((p) => p.projectCode === ex.response!.data!.conflictingProjectCode);
              if (conflicting) {
                setShowCreate(false);
                setBlockProject(conflicting);
                return;
              }
            }
            throw err;
          }
          await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
          setShowCreate(false);
          showToast('项目已创建', 'success');
          onSectionChange('technical-plan');
        }}
        onError={(msg) => showToast(msg, 'error')}
      />

      <BlockCreateProjectDialog
        open={!!blockProject}
        conflictingProject={blockProject}
        busy={blockBusy}
        onContinue={() => { void handleBlockContinue(); }}
        onDelete={() => { void handleBlockDelete(); }}
        onCancel={() => setBlockProject(null)}
      />
    </div>
  );
}



export default DashboardPage;
