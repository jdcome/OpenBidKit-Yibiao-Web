// 用户管理：注册审批 + 状态切换 + 编辑账号 + 删除（禁删自己）。对标 92 Users.vue。
// 视觉沿用应用设计令牌与既有面板/表格/弹窗词汇，不再使用内联深色样式。
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveUser,
  deleteUser,
  disableUser,
  enableUser,
  fetchUsers,
  updateUser,
  type SystemUser,
  type UserUpdatePatch,
} from '../../../shared/api/users';
import { useAuth } from '../../../shared/api/auth';
import { useToast } from '../../../shared/ui';
import { ASSIGNABLE_MODULES, GRANTABLE_MODULE_IDS } from '../../../shared/permissions';

type TabKey = 'all' | 'pending' | 'active' | 'disabled';

const TABS: { key: TabKey; label: string; status?: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待审批', status: 'pending' },
  { key: 'active', label: '正常', status: 'active' },
  { key: 'disabled', label: '停用', status: 'disabled' },
];

const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '普通用户' };
const MODULE_LABEL: Record<string, string> = Object.fromEntries(
  ASSIGNABLE_MODULES.map((m) => [m.id, m.label]),
);
const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '待审批', color: '#f28a00' },
  active: { label: '正常', color: '#168a4a' },
  disabled: { label: '已停用', color: '#98a2b3' },
};

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function UserManagementPage() {
  const { user: me } = useAuth();
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>('all');
  const [editing, setEditing] = useState<SystemUser | null>(null);

  const activeTab = TABS.find((t) => t.key === tab)!;
  const { data, isLoading } = useQuery({
    queryKey: ['users', tab],
    queryFn: () => fetchUsers(activeTab.status),
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['users'] });
  };

  const wrap = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await invalidate();
      showToast(`${label}成功`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const anyErr = err as { response?: { data?: { error?: string } } };
      showToast(`${label}失败：${anyErr.response?.data?.error || msg}`, 'error');
    }
  };

  const handleDelete = async (u: SystemUser) => {
    if (!window.confirm(`确认删除账号「${u.displayName || u.phone || u.username}」？此操作不可撤销。`)) return;
    await wrap('删除', () => deleteUser(u.id));
  };

  return (
    <div className="user-mgmt-page">
      <div className="user-mgmt-shell">
        <header className="user-mgmt-head">
          <div className="user-mgmt-head-text">
            <span className="section-kicker">用户管理</span>
            <h2>账号审批与权限</h2>
            <p>审批手机号注册申请，管理账号状态、角色与模板/格式权限。</p>
          </div>
          {data?.pendingCount ? (
            <span className="user-mgmt-pending-badge">{data.pendingCount} 个账号待审批</span>
          ) : null}
        </header>

        {/* Tabs */}
        <div className="user-mgmt-tabs">
          {TABS.map((t) => {
            const badge = t.key === 'pending' && data?.pendingCount ? ` (${data.pendingCount})` : '';
            return (
              <button
                key={t.key}
                type="button"
                className={`user-mgmt-tab${tab === t.key ? ' is-active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}{badge}
              </button>
            );
          })}
        </div>

        {/* 表 */}
        <table className="user-mgmt-table">
          <thead>
            <tr>
              <th>手机号</th>
              <th>姓名</th>
              <th>部门</th>
              <th>角色</th>
              <th>权限</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={8} className="user-mgmt-empty">加载中…</td></tr>
            )}
            {!isLoading && data?.users.length === 0 && (
              <tr><td colSpan={8} className="user-mgmt-empty">暂无用户</td></tr>
            )}
            {data?.users.map((u) => {
              const meta = STATUS_META[u.status] ?? STATUS_META.disabled;
              const isSelf = me?.id === u.id;
              return (
                <tr key={u.id}>
                  <td>{u.phone || u.username}</td>
                  <td>{u.displayName || '—'}</td>
                  <td>{u.department || '—'}</td>
                  <td>{ROLE_LABEL[u.role] ?? u.role}</td>
                  <td className="user-mgmt-perm">
                    {u.role === 'admin'
                      ? '全部'
                      : u.modules.length === 0
                        ? '默认'
                        : u.modules.map((m) => MODULE_LABEL[m] ?? m).join('、')}
                  </td>
                  <td>
                    <span
                      className="user-mgmt-pill"
                      style={{ color: meta.color, background: `${meta.color}1f` }}
                    >
                      {meta.label}
                    </span>
                  </td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>
                    <div className="user-mgmt-row-actions">
                      {u.status === 'pending' && (
                        <button type="button" className="text-button is-success" onClick={() => void wrap('审批', () => approveUser(u.id))}>审批</button>
                      )}
                      {u.status === 'active' && !isSelf && (
                        <button type="button" className="text-button" onClick={() => void wrap('停用', () => disableUser(u.id))}>停用</button>
                      )}
                      {u.status === 'disabled' && (
                        <button type="button" className="text-button is-success" onClick={() => void wrap('启用', () => enableUser(u.id))}>启用</button>
                      )}
                      <button type="button" className="text-button" onClick={() => setEditing(u)}>编辑</button>
                      {!isSelf && (
                        <button type="button" className="text-button is-danger" onClick={() => void handleDelete(u)}>删除</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <EditUserModal
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await invalidate();
          setEditing(null);
          showToast('已保存', 'success');
        }}
        onError={(msg) => showToast(msg, 'error')}
      />
    </div>
  );
}

interface EditUserModalProps {
  target: SystemUser | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onError: (msg: string) => void;
}

function EditUserModal({ target, onClose, onSaved, onError }: EditUserModalProps) {
  return (
    <Dialog.Root
      open={Boolean(target)}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        {target ? (
          <EditUserForm key={target.id} target={target} onClose={onClose} onSaved={onSaved} onError={onError} />
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface EditUserFormProps {
  target: SystemUser;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onError: (msg: string) => void;
}

function EditUserForm({ target, onClose, onSaved, onError }: EditUserFormProps) {
  const [displayName, setDisplayName] = useState(target.displayName ?? '');
  const [department, setDepartment] = useState(target.department ?? '');
  const [role, setRole] = useState(target.role);
  const [modules, setModules] = useState<string[]>(target.modules ?? []);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const toggleModule = (id: string) => {
    setModules((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const submit = async () => {
    const patch: UserUpdatePatch = {};
    if (displayName !== (target.displayName ?? '')) patch.displayName = displayName;
    if (department !== (target.department ?? '')) patch.department = department;
    if (role !== target.role) patch.role = role;
    // 角色为管理员时 modules 无意义（管理员拥有全部权限），仅普通用户下发 modules。
    if (role === 'user') {
      const orig = (target.modules ?? []).slice().sort().join(',');
      const next = modules.slice().sort().join(',');
      if (orig !== next) patch.modules = modules;
    }
    if (password) patch.password = password;
    if (Object.keys(patch).length === 0) {
      onError('无待更新字段');
      return;
    }
    setBusy(true);
    try {
      await updateUser(target.id, patch);
      await onSaved();
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      const msg = err instanceof Error ? err.message : String(err);
      onError(`保存失败：${anyErr.response?.data?.error || msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Content className="edit-user-dialog">
      <Dialog.Title>编辑账号</Dialog.Title>
      <Dialog.Description className="sr-only">编辑账号的姓名、部门、角色、模块权限或重置密码。</Dialog.Description>
      <p className="edit-user-dialog-sub">手机号：{target.phone || target.username}（不可修改）</p>
      <div className="edit-user-dialog-body">
        <label className="user-mgmt-field">
          姓名
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="user-mgmt-field">
          部门
          <input type="text" value={department} onChange={(e) => setDepartment(e.target.value)} />
        </label>
        <label className="user-mgmt-field">
          角色
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="admin">管理员</option>
            <option value="user">普通用户</option>
          </select>
        </label>

        <div className="user-mgmt-checkbox-group">
          <span className="user-mgmt-checkbox-title">功能模块权限</span>
          {role === 'admin' ? (
            <p className="user-mgmt-checkbox-hint">管理员拥有全部功能模块权限。</p>
          ) : (
            ASSIGNABLE_MODULES.map((m) => {
              const grantable = (GRANTABLE_MODULE_IDS as string[]).includes(m.id);
              const checked = grantable && modules.includes(m.id);
              return (
                <label
                  key={m.id}
                  className={`user-mgmt-checkbox${grantable ? '' : ' is-disabled'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!grantable}
                    onChange={() => grantable && toggleModule(m.id)}
                  />
                  {m.label}
                  {!grantable ? <small>（仅管理员）</small> : null}
                </label>
              );
            })
          )}
        </div>

        <label className="user-mgmt-field">
          重置密码（留空不改，至少 8 位）
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </label>
      </div>
      <div className="user-mgmt-dialog-actions">
        <Dialog.Close asChild>
          <button type="button" className="secondary-action">取消</button>
        </Dialog.Close>
        <button type="button" className="primary-action" onClick={() => void submit()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </Dialog.Content>
  );
}

export default UserManagementPage;
