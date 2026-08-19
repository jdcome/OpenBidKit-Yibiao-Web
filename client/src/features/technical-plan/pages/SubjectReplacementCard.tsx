// 代称替换表编辑卡（STEP 04）。
// 受控外观：接收当前 value，编辑后内部草稿 + 600ms 防抖，再 emit onChange。
// 透传给父级（GlobalFactsPage → TechnicalPlanHome）做 PATCH 落库。
import { useEffect, useRef, useState } from 'react';
import type { SubjectReplacement } from '../../../shared/api/projects';

interface SubjectReplacementCardProps {
  value: SubjectReplacement[];
  onChange: (next: SubjectReplacement[]) => void;
  onConfirmIdentity?: () => void;
}

function createId(): string {
  return `sr_${window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function withIds(list: SubjectReplacement[]): Array<SubjectReplacement & { _id: string }> {
  return list.map((item) => ({ ...item, _id: createId() }));
}

function stripIds(list: Array<SubjectReplacement & { _id: string }>): SubjectReplacement[] {
  return list.map(({ _id: _omit, ...rest }) => {
    const trimmed = rest.fullname.trim();
    const synonyms = Array.from(new Set(rest.synonyms.map((s) => s.trim()).filter(Boolean)));
    return { fullname: trimmed, synonyms };
  });
}

function samePayload(a: SubjectReplacement[], b: SubjectReplacement[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((group, i) => {
    const other = b[i];
    if (!other) return false;
    if (group.fullname.trim() !== other.fullname.trim()) return false;
    const sa = group.synonyms.map((s) => s.trim()).filter(Boolean);
    const sb = other.synonyms.map((s) => s.trim()).filter(Boolean);
    return sa.length === sb.length && sa.every((s, j) => s === sb[j]);
  });
}

function SubjectReplacementCard({ value, onChange, onConfirmIdentity }: SubjectReplacementCardProps) {
  const [draft, setDraft] = useState<Array<SubjectReplacement & { _id: string }>>(() => withIds(value));
  const lastEmittedRef = useRef<SubjectReplacement[]>(value);
  const [newSynonymInputs, setNewSynonymInputs] = useState<Record<string, string>>({});

  // 外部 value 变化（如自动播种、刷新回显）→ 回填 draft，前提是与上次 emit 不同。
  useEffect(() => {
    if (samePayload(value, stripIds(draft))) return;
    lastEmittedRef.current = value;
    setDraft(withIds(value));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 草稿变更 → 防抖 emit。
  useEffect(() => {
    const payload = stripIds(draft);
    if (samePayload(payload, lastEmittedRef.current)) return;
    const timer = setTimeout(() => {
      lastEmittedRef.current = payload;
      onChange(payload);
    }, 600);
    return () => clearTimeout(timer);
  }, [draft, onChange]);

  const updateFullname = (id: string, fullname: string) => {
    setDraft((prev) => prev.map((group) => (group._id === id ? { ...group, fullname } : group)));
  };

  const removeSynonym = (id: string, synIndex: number) => {
    setDraft((prev) => prev.map((group) => (
      group._id === id ? { ...group, synonyms: group.synonyms.filter((_, i) => i !== synIndex) } : group
    )));
  };

  const commitSynonym = (id: string) => {
    const raw = (newSynonymInputs[id] || '').trim();
    if (!raw) return;
    setDraft((prev) => prev.map((group) => {
      if (group._id !== id) return group;
      if (group.synonyms.some((s) => s.trim() === raw)) return group;
      return { ...group, synonyms: [...group.synonyms, raw] };
    }));
    setNewSynonymInputs((prev) => ({ ...prev, [id]: '' }));
  };

  const addGroup = () => {
    const created = { _id: createId(), fullname: '', synonyms: [] as string[] };
    setDraft((prev) => [...prev, created]);
  };

  const removeGroup = (id: string) => {
    setDraft((prev) => prev.filter((group) => group._id !== id));
  };

  return (
    <section className="subject-replacement-card">
      <div className="subject-replacement-head">
        <span className="section-kicker">代称替换表 · {draft.length} 组</span>
        <strong>投标主体身份替换</strong>
        <p>正文落库前会按本表把「代称」确定性替换为「公司全称」。投标是响应不是复述：中标人/供应商/我方 → 我方全称；采购人/招标人/甲方 → 采购人全称。</p>
      </div>

      <div className="subject-replacement-rows">
            {draft.length === 0 && (
              <div className="subject-replacement-empty">
                <strong>暂无替换组</strong>
                <p>在 STEP 04 确认投标主体后可自动生成；或点击下方新增一组。</p>
              </div>
            )}
            {draft.map((group) => (
              <div className="subject-replacement-row" key={group._id}>
                <div className="subject-replacement-fullname">
                  <label>
                    <span>公司全称</span>
                    <input
                      type="text"
                      value={group.fullname}
                      onChange={(event) => updateFullname(group._id, event.target.value)}
                      placeholder="如：湖南金盾信息评估中心有限公司"
                      autoComplete="off"
                    />
                  </label>
                </div>
                <div className="subject-replacement-synonyms">
                  <span className="subject-replacement-synonyms-label">替换代称</span>
                  <div className="subject-replacement-synonyms-body">
                    {group.synonyms.map((synonym, synIndex) => (
                      <span className="subject-replacement-chip" key={`${synonym}-${synIndex}`}>
                        {synonym}
                        <button
                          type="button"
                          className="subject-replacement-chip-remove"
                          onClick={() => removeSynonym(group._id, synIndex)}
                          aria-label={`移除代称 ${synonym}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      className="subject-replacement-synonym-input"
                      value={newSynonymInputs[group._id] || ''}
                      onChange={(event) => setNewSynonymInputs((prev) => ({ ...prev, [group._id]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitSynonym(group._id);
                        }
                      }}
                      onBlur={() => commitSynonym(group._id)}
                      placeholder="+ 加代称"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="danger-action subject-replacement-remove"
                  onClick={() => removeGroup(group._id)}
                >
                  删除组
                </button>
              </div>
            ))}
          </div>

      <div className="subject-replacement-actions">
        {onConfirmIdentity && (
          <button type="button" className="secondary-action" onClick={onConfirmIdentity}>确认主体与代称</button>
        )}
        <button type="button" className="secondary-action" onClick={addGroup}>+ 新增一组</button>
      </div>
    </section>
  );
}

export default SubjectReplacementCard;
