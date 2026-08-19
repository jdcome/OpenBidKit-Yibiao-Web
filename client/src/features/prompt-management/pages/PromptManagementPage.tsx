// 提示词管理页（admin-only）：编辑招标解析/废标检查的提示词来源。
// 把硬编码常量改为 DB 驱动（带兜底）。列表按 模块(runnerKey) → 分组(groupName) 聚合；
// 系统提示词与内置项可编辑正文/恢复默认，自定义项可增删改。禁用优先于必填。
import { useMemo, useState } from 'react';
import { usePromptCatalog, useUpdatePrompt, useResetAllPrompts, type PromptCatalogItem, type PromptRunnerKey } from '../api/prompts';
import { useToast } from '../../../shared/ui';
import PromptEditDialog from '../components/PromptEditDialog';
import CreatePromptDialog from '../components/CreatePromptDialog';

const RUNNER_LABEL: Record<PromptRunnerKey, string> = {
  'bid-analysis': '招标解析',
  'rejection-check': '废标检查',
  'mirror-procurement': '镜像采购需求',
};

const GROUP_ORDER = ['关键项', '采购与响应', '投标流程', '评审要求', '主体与合同'];

function groupKey(groupName: string): string {
  const idx = GROUP_ORDER.indexOf(groupName);
  return idx === -1 ? `~${groupName}` : String(idx).padStart(2, '0');
}

interface ItemRowProps {
  item: PromptCatalogItem;
  onEdit: (id: string) => void;
  onToggleEnabled: (item: PromptCatalogItem, next: boolean) => void;
}

function ItemRow({ item, onEdit, onToggleEnabled }: ItemRowProps) {
  const requireLocked = item.builtin && item.required;
  return (
    <tr className={`prompt-row${item.enabled ? '' : ' is-disabled'}`}>
      <td className="prompt-row-label">
        <strong>{item.label}</strong>
        {item.isSystem && <span className="prompt-pill is-system">系统</span>}
        {item.builtin ? <span className="prompt-pill is-builtin">内置</span> : <span className="prompt-pill is-custom">自定义</span>}
        {item.required && <span className="prompt-pill is-required">必填</span>}
      </td>
      <td className="prompt-row-key">{item.itemKey}</td>
      <td className="prompt-row-output">{item.output.toUpperCase()}</td>
      <td className="prompt-row-toggle">
        <label className="prompt-switch">
          <input
            type="checkbox"
            checked={item.enabled}
            onChange={(e) => onToggleEnabled(item, e.target.checked)}
          />
          <span className="prompt-switch-track"><span className="prompt-switch-thumb" /></span>
        </label>
      </td>
      <td className="prompt-row-actions">
        <button type="button" className="text-button" onClick={() => onEdit(item.id)}>编辑</button>
      </td>
    </tr>
  );
}

function PromptManagementPage() {
  const { showToast } = useToast();
  const { data: items, isLoading } = usePromptCatalog();
  const updateMut = useUpdatePrompt();
  const resetAllMut = useResetAllPrompts();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createRunner, setCreateRunner] = useState<PromptRunnerKey>('bid-analysis');

  // 按 runnerKey → groupName 聚合。system 项单列置顶（groupName=''）。
  const grouped = useMemo(() => {
    const byRunner: Record<string, PromptCatalogItem[]> = {};
    for (const it of items ?? []) {
      (byRunner[it.runnerKey] ??= []).push(it);
    }
    const result: Array<{ runnerKey: PromptRunnerKey; system?: PromptCatalogItem; groups: Array<{ name: string; items: PromptCatalogItem[] }> }> = [];
    for (const runnerKey of ['bid-analysis', 'rejection-check', 'mirror-procurement'] as PromptRunnerKey[]) {
      const list = (byRunner[runnerKey] ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
      const system = list.find((it) => it.isSystem);
      const rest = list.filter((it) => !it.isSystem);
      const groupMap = new Map<string, PromptCatalogItem[]>();
      for (const it of rest) {
        const name = it.groupName || '其他';
        (groupMap.get(name) ?? groupMap.set(name, []).get(name)!).push(it);
      }
      const groups = Array.from(groupMap.entries())
        .map(([name, gItems]) => ({ name, items: gItems }))
        .sort((a, b) => groupKey(a.name).localeCompare(groupKey(b.name)));
      result.push({ runnerKey, system, groups });
    }
    return result;
  }, [items]);

  const handleToggleEnabled = async (item: PromptCatalogItem, next: boolean) => {
    // 关闭内置必填项会让该项不进目录/必填校验，需二次确认。
    if (!next && item.builtin && item.required) {
      if (!window.confirm(`关闭必填项「${item.label}」后，该项将不再参与招标解析与必填校验。确定？`)) return;
    }
    try {
      await updateMut.mutateAsync({ id: item.id, patch: { enabled: next } });
      showToast(next ? '已启用' : '已禁用', 'success');
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      showToast(`操作失败：${anyErr.response?.data?.error || (err instanceof Error ? err.message : String(err))}`, 'error');
    }
  };

  const handleResetAll = async () => {
    if (!window.confirm('恢复全部内置提示词为默认正文？所有内置项的正文编辑将被覆盖（自定义项与元数据保留）。')) return;
    try {
      const res = await resetAllMut.mutateAsync();
      showToast(`已恢复 ${res.count} 项默认正文`, 'success');
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      showToast(`恢复失败：${anyErr.response?.data?.error || (err instanceof Error ? err.message : String(err))}`, 'error');
    }
  };

  const busy = updateMut.isPending || resetAllMut.isPending;

  return (
    <div className="prompt-mgmt-page">
      <div className="prompt-mgmt-shell">
        <header className="prompt-mgmt-head">
          <div className="prompt-mgmt-head-text">
            <span className="section-kicker">提示词管理</span>
            <h2>招标解析与废标检查提示词</h2>
            <p>编辑招标解析（18 项 + 系统提示词）与废标检查的提示词正文。内置项可恢复默认，可新增自定义项。解析管线不变。</p>
          </div>
          <div className="prompt-mgmt-head-actions">
            <button type="button" className="secondary-action" onClick={() => void handleResetAll()} disabled={busy}>恢复全部默认</button>
            <button type="button" className="primary-action" onClick={() => { setCreateRunner('bid-analysis'); setCreateOpen(true); }}>新建自定义</button>
          </div>
        </header>

        {isLoading && <div className="prompt-mgmt-empty">加载中…</div>}
        {!isLoading && (items?.length ?? 0) === 0 && <div className="prompt-mgmt-empty">暂无提示词（未 seed？runner 将走硬编码兜底）。</div>}

        {grouped.map((section) => (
          <section key={section.runnerKey} className="prompt-section">
            <h3 className="prompt-section-title">{RUNNER_LABEL[section.runnerKey]}</h3>

            {section.system && (
              <table className="prompt-table prompt-table-system">
                <tbody>
                  <ItemRow item={section.system} onEdit={setEditingId} onToggleEnabled={handleToggleEnabled} />
                </tbody>
              </table>
            )}

            {section.groups.map((group) => (
              <div key={group.name} className="prompt-group">
                <h4 className="prompt-group-title">{group.name}</h4>
                <table className="prompt-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>itemKey</th>
                      <th>输出</th>
                      <th>启用</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((it) => (
                      <ItemRow key={it.id} item={it} onEdit={setEditingId} onToggleEnabled={handleToggleEnabled} />
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {section.groups.length === 0 && !section.system && (
              <div className="prompt-mgmt-empty">该模块暂无提示词。</div>
            )}
          </section>
        ))}
      </div>

      <PromptEditDialog promptId={editingId} onClose={() => setEditingId(null)} />
      <CreatePromptDialog open={createOpen} defaultRunnerKey={createRunner} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

export default PromptManagementPage;
