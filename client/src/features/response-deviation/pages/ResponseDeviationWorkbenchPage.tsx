import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProject } from '../../../app/ProjectContext';
import { responseDeviationApi } from '../../../shared/api/response-deviation';
import MarkdownRenderer from '../../../shared/ui/MarkdownRenderer';
import { useToast } from '../../../shared/ui';
import type {
  ResponseDeviationAvailability,
  ResponseDeviationExportValidation,
  ResponseDeviationProjectFields,
  ResponseDeviationRow,
  ResponseDeviationWorkspace,
} from '../types';
import { consumeResponseDeviationIntent } from '../utils/navigationIntent';

const reasonText: Record<string, string> = {
  'no-tender': '当前项目还没有招标文件，请先进入“生成技术方案”上传并解析。',
  'package-required': '当前文件包含多个标段，请先在 STEP 02 选择标段。',
  'no-template': '未识别到技术类响应与偏离表模板。',
  'business-only': '仅识别到独立商务条款偏离表，当前版本暂不生成商务表。',
  'no-technical-source': '未识别到当前标段的采购需求、服务需求或技术要求章节。',
};

const fieldLabels: Array<[keyof ResponseDeviationProjectFields, string]> = [
  ['projectName', '项目名称'],
  ['projectNumber', '项目编号'],
  ['procurementNumber', '政府采购编号'],
  ['packageName', '包名称'],
  ['packageNumber', '包号'],
];

const defaultTemplateColumns = ['序号', '招标文件条目号', '招标文件要求', '投标文件应答', '响应与偏离', '偏离说明'];

type ResponseDeviationColumnRole = 'sequence' | 'clause' | 'requirement' | 'response' | 'deviation' | 'explanation' | 'notes';

function normalizeColumnText(column: string): string {
  return String(column || '').replace(/\s+/g, '');
}

function columnRole(column: string): ResponseDeviationColumnRole {
  const text = normalizeColumnText(column);
  if (/^(序号|编号)$/u.test(text) || /序号/u.test(text)) return 'sequence';
  if (/条目号|条款号|章节号|依据条款/u.test(text)) return 'clause';
  if (/偏离|偏差/u.test(text)) return 'deviation';
  if (/说明|备注/u.test(text)) return 'explanation';
  if (/响应文件|投标文件|参选文件|应答|响应内容|响应条款/u.test(text)) return 'response';
  if (/招标文件|磋商文件|比选文件|采购文件|采购规格|商务条款|技术要求|对应的?内容|要求|内容/u.test(text)) return 'requirement';
  return 'notes';
}

function columnWidth(role: ResponseDeviationColumnRole): number {
  if (role === 'sequence') return 72;
  if (role === 'clause') return 190;
  if (role === 'requirement') return 620;
  if (role === 'response') return 230;
  if (role === 'deviation') return 150;
  if (role === 'explanation') return 230;
  return 180;
}

function fieldValue(workspace: ResponseDeviationWorkspace | null, key: keyof ResponseDeviationProjectFields): string {
  return workspace?.projectFieldsJson?.[key]?.value || '';
}

function validationLabel(validation: ResponseDeviationExportValidation | null): { title: string; tone: string; hint: string } {
  if (!validation) return { title: '模板校验待运行', tone: 'empty', hint: '生成偏离表后系统会自动校验导出模板。' };
  if (validation.status === 'error') return { title: '模板校验需处理', tone: 'error', hint: '存在会破坏导出的格式问题，处理后才能导出 Word。' };
  if (validation.status === 'warning') return { title: '模板校验有提醒', tone: 'warning', hint: '可以导出，但建议先核对未识别字段或模板边界。' };
  return { title: '模板校验通过', tone: 'ok', hint: '表头、字段区、说明区和脏字符检查均已通过。' };
}

function fieldStatus(workspace: ResponseDeviationWorkspace | null, key: keyof ResponseDeviationProjectFields): string {
  const field = workspace?.projectFieldsJson?.[key];
  if (!field?.value) return '留空';
  if (field.source === 'manual') return '人工';
  if (field.source === 'package') return '当前包';
  if (field.source === 'step02') return 'STEP02';
  if (field.source === 'markdown') return '招标文件';
  return '已填';
}

function aggregationLabel(row: ResponseDeviationRow): string {
  if (row.aggregation === 'principles') return '原则整章聚合';
  if (row.aggregation === 'assessment-objects') return '测评对象整表聚合';
  if (row.aggregation === 'method-content') return '方法内容整章聚合';
  if (row.aggregation === 'unnumbered-section') return '无编号段落';
  return '编号条款';
}

export default function ResponseDeviationWorkbenchPage() {
  const { activeProject } = useProject();
  const { showToast } = useToast();
  const [availability, setAvailability] = useState<ResponseDeviationAvailability | null>(null);
  const [workspace, setWorkspace] = useState<ResponseDeviationWorkspace | null>(null);
  const [validation, setValidation] = useState<ResponseDeviationExportValidation | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState('');
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});
  const [validationOpen, setValidationOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [a, w, v] = await Promise.all([
      responseDeviationApi.availability(),
      responseDeviationApi.workspace(),
      responseDeviationApi.exportValidation(),
    ]);
    setAvailability(a);
    setWorkspace(w);
    setValidation(v);
    setFieldDrafts({
      projectName: fieldValue(w, 'projectName'),
      projectNumber: fieldValue(w, 'projectNumber'),
      procurementNumber: fieldValue(w, 'procurementNumber'),
      packageName: fieldValue(w, 'packageName'),
      packageNumber: fieldValue(w, 'packageNumber'),
    });
    if (!selectedRowId && w.rows?.[0]) setSelectedRowId(w.rows[0].id);
  }, [selectedRowId]);

  const generate = useCallback(async (force = false) => {
    setGenerating(true);
    try {
      const result = await responseDeviationApi.generate(force);
      if (result.reused) {
        setWorkspace(result.workspace);
        await refresh();
        return;
      }
      for (let i = 0; i < 120; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const next = await responseDeviationApi.workspace();
        setWorkspace(next);
        const status = next.generationTaskJson?.status;
        if (status === 'success') {
          await refresh();
          showToast('技术响应与偏离表草稿已生成', 'success');
          return;
        }
        if (status === 'error') throw new Error(next.generationTaskJson?.error || '偏离表生成失败');
      }
      throw new Error('偏离表生成超时，请稍后刷新查看');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '偏离表生成失败', 'error');
    } finally {
      setGenerating(false);
    }
  }, [refresh, showToast]);

  useEffect(() => {
    if (!activeProject?.id) return;
    let alive = true;
    setLoading(true);
    void refresh()
      .then(() => {
        if (!alive) return;
        const intent = consumeResponseDeviationIntent(activeProject.id);
        if (intent) void generate(false);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : '读取偏离表失败', 'error'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [activeProject?.id]);

  const selectedRow = useMemo(
    () => workspace?.rows.find((row) => row.id === selectedRowId) || workspace?.rows[0] || null,
    [workspace, selectedRowId],
  );
  const templateColumns = useMemo(() => {
    const columns = validation?.columns?.length ? validation.columns : workspace?.templateSchemaJson?.columns || [];
    return columns.length ? columns : defaultTemplateColumns;
  }, [validation?.columns, workspace?.templateSchemaJson?.columns]);
  const templateColumnRoles = useMemo(() => templateColumns.map(columnRole), [templateColumns]);
  const task = workspace?.generationTaskJson;
  const validationMeta = validationLabel(validation);
  const errorIssues = validation?.issues.filter((issue) => issue.level === 'error') || [];
  const warningIssues = validation?.issues.filter((issue) => issue.level === 'warning') || [];

  const saveField = async (key: keyof ResponseDeviationProjectFields) => {
    const previous = workspace?.projectFieldsJson?.[key];
    await responseDeviationApi.patchProjectFields({ [key]: { ...(previous || {}), value: fieldDrafts[key] || '', source: 'manual' } });
    await refresh();
  };

  const updateRowDraft = (row: ResponseDeviationRow, key: string, value: string) => {
    setWorkspace((prev) => (prev ? {
      ...prev,
      rows: prev.rows.map((item) => (item.id === row.id ? { ...item, [key]: value } : item)),
    } : prev));
  };

  const persistRow = async (row: ResponseDeviationRow, key: string, value: string) => {
    try {
      await responseDeviationApi.patchRow(row.id, { [key]: value });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error');
      await refresh();
    }
  };

  const renderRowCell = (row: ResponseDeviationRow, role: ResponseDeviationColumnRole, key: string) => {
    if (role === 'sequence') return <td key={key}>{row.sequenceNo}</td>;
    if (role === 'clause') return <td key={key}>{row.clauseNo}</td>;
    if (role === 'requirement') return <td key={key}><div className="rd-requirement"><MarkdownRenderer>{row.requirementMarkdown}</MarkdownRenderer></div></td>;
    if (role === 'response') {
      return (
        <td key={key}>
          <textarea value={row.responseText || ''} onChange={(e) => updateRowDraft(row, 'responseText', e.target.value)} onBlur={(e) => void persistRow(row, 'responseText', e.target.value)} />
        </td>
      );
    }
    if (role === 'deviation') {
      return (
        <td key={key}>
          <select
            value={row.deviationStatus || ''}
            onChange={(e) => {
              updateRowDraft(row, 'deviationStatus', e.target.value);
              void persistRow(row, 'deviationStatus', e.target.value);
            }}
          >
            <option value="">请选择</option>
            <option>无偏离</option>
            <option>正偏离</option>
            <option>负偏离</option>
          </select>
        </td>
      );
    }
    if (role === 'explanation') {
      return (
        <td key={key}>
          <textarea value={row.deviationExplanation || ''} onChange={(e) => updateRowDraft(row, 'deviationExplanation', e.target.value)} onBlur={(e) => void persistRow(row, 'deviationExplanation', e.target.value)} />
        </td>
      );
    }
    return (
      <td key={key}>
        <textarea value={row.notes || ''} onChange={(e) => updateRowDraft(row, 'notes', e.target.value)} onBlur={(e) => void persistRow(row, 'notes', e.target.value)} />
      </td>
    );
  };

  const exportWord = async () => {
    if (validation?.status === 'error') {
      setValidationOpen(true);
      showToast('模板校验未通过，请先处理红色问题。', 'error');
      return;
    }
    try {
      await responseDeviationApi.exportWord();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出失败', 'error');
    }
  };

  if (!activeProject) {
    return <div className="rd-empty-page"><strong>请先选择项目</strong><span>工作台按项目复用招标文件和分析结果。</span></div>;
  }

  return (
    <div className="rd-workbench">
      <header className="rd-hero">
        <div>
          <span className="section-kicker">响应与偏离表</span>
          <h1>技术响应与偏离表工作台</h1>
          <p>复用“生成技术方案”中的招标原文、当前标段与 STEP 02 分析结果，不需要重复上传。</p>
        </div>
        <div className="rd-hero-actions">
          <span className={`rd-status rd-status-${workspace?.status || 'empty'}`}>
            {workspace?.status === 'confirmed' ? '已确认' : workspace?.status === 'stale' ? '来源已变化' : workspace?.rows?.length ? '待确认' : '未生成'}
          </span>
          <button className="secondary-action" type="button" disabled={generating || !availability?.available} onClick={() => void generate(Boolean(workspace?.rows?.length))}>
            {generating ? '正在识别…' : workspace?.rows?.length ? '重新识别' : '开始识别'}
          </button>
          <button
            className="secondary-action"
            type="button"
            disabled={!workspace?.rows?.length || workspace.status === 'confirmed'}
            onClick={() => void responseDeviationApi.confirm().then(refresh).then(() => showToast('招标侧内容已确认', 'success')).catch((e) => showToast(e.message, 'error'))}
          >
            确认招标侧内容
          </button>
          <button className="primary-action" type="button" disabled={workspace?.status !== 'confirmed' || validation?.status === 'error'} onClick={() => void exportWord()}>
            导出 Word
          </button>
        </div>
      </header>

      {loading ? <div className="rd-inline-notice">正在读取当前项目招标源…</div> : null}
      {!loading && availability && !availability.available ? (
        <div className="rd-inline-notice is-warning"><strong>暂不能生成</strong><span>{reasonText[availability.reason] || '当前招标文件暂不满足生成条件。'}</span></div>
      ) : null}
      {generating && task ? (
        <div className="rd-task-strip"><strong>{task.logs?.at(-1) || '正在识别'}</strong><span>{task.progress || 0}%</span><i><b style={{ width: `${task.progress || 0}%` }} /></i></div>
      ) : null}

      <div className="rd-grid">
        <aside className="rd-side-card">
          <span className="section-kicker">识别摘要</span>
          <h2>{availability?.templateTitle || workspace?.templateTitle || '等待识别表单'}</h2>
          <dl>
            <div><dt>当前项目</dt><dd>{activeProject.name}</dd></div>
            <div><dt>当前标段</dt><dd>{workspace?.selectedSectionTitle || '单标段'}</dd></div>
            <div><dt>来源章节</dt><dd>{availability?.sourceChapterTitle || workspace?.sourceScopeJson?.title || '—'}</dd></div>
            <div><dt>生成行数</dt><dd>{workspace?.rows?.length || 0}</dd></div>
          </dl>

          <section className={`rd-validation-card rd-validation-${validationMeta.tone}`}>
            <div>
              <strong>{validationMeta.title}</strong>
              <span>{validationMeta.hint}</span>
            </div>
            <div className="rd-validation-pills">
              <span>表头 {validation?.summary.columnsCount || templateColumns.length} 列</span>
              <span>填值 {validation?.summary.autoFilledCount || 0} 项</span>
              <span>{errorIssues.length ? `${errorIssues.length} 个阻断` : `${warningIssues.length} 个提醒`}</span>
            </div>
            <button type="button" className="secondary-action" onClick={() => setValidationOpen(true)}>查看并确认模板</button>
          </section>

          <div className="rd-field-box">
            <strong>项目字段</strong>
            {fieldLabels.map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  value={fieldDrafts[key] || ''}
                  onChange={(e) => setFieldDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                  onBlur={() => void saveField(key)}
                />
              </label>
            ))}
          </div>
        </aside>

        <main className="rd-table-card">
          <div className="rd-card-head">
            <div><span className="section-kicker">招标原文拆分结果</span><h2>技术响应与偏离表</h2></div>
            <small>表头严格复制招标原表；人工列按原字段名称填写并自动保存</small>
          </div>
          <div className="rd-table-scroll">
            <table>
              <thead>
                <tr>
                  {templateColumns.map((column, index) => (
                    <th key={`${column}-${index}`} className={`rd-col-${templateColumnRoles[index]}`} style={{ width: columnWidth(templateColumnRoles[index]) }}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(workspace?.rows || []).map((row) => (
                  <tr key={row.id} className={selectedRow?.id === row.id ? 'is-selected' : ''} onClick={() => setSelectedRowId(row.id)}>
                    {templateColumnRoles.map((role, index) => renderRowCell(row, role, `${row.id}-${templateColumns[index]}-${index}`))}
                  </tr>
                ))}
                {!workspace?.rows?.length ? (
                  <tr><td colSpan={templateColumns.length}><div className="rd-table-empty">点击“开始识别”，系统会按招标原文编号拆分，项目原则和测评对象按整块聚合。</div></td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </main>

        <aside className="rd-evidence-card">
          <span className="section-kicker">原文证据</span>
          <h2>{selectedRow?.clauseNo || '请选择一行'}</h2>
          {selectedRow ? (
            <>
              <div className="rd-evidence-meta">
                <span>{aggregationLabel(selectedRow)}</span>
                <span>{selectedRow.confidence === 'high' ? '规则识别' : '待复核'}</span>
              </div>
              <div className="rd-evidence-content"><MarkdownRenderer>{selectedRow.requirementMarkdown}</MarkdownRenderer></div>
            </>
          ) : <p>选择中间表格中的一行，可查看逐字复制的招标原文和完整表格。</p>}
        </aside>
      </div>

      {validationOpen ? (
        <div className="rd-dialog-backdrop" role="presentation" onMouseDown={() => setValidationOpen(false)}>
          <div className="rd-validation-dialog" role="dialog" aria-modal="true" aria-label="偏离表模板校验详情" onMouseDown={(event) => event.stopPropagation()}>
            <div className="rd-dialog-head">
              <div>
                <span className="section-kicker">模板校验</span>
                <h2>查看并确认偏离表模板</h2>
                <p>系统只在招标文件原模板位置填值，不改写表头、字段区和说明签章区。</p>
              </div>
              <button type="button" className="secondary-action" onClick={() => setValidationOpen(false)}>关闭</button>
            </div>

            <section className="rd-dialog-section">
              <h3>原始表头</h3>
              <div className="rd-column-preview">
                {(validation?.columns || workspace?.templateSchemaJson?.columns || []).map((column, index) => <span key={`${column}-${index}`}>{column}</span>)}
              </div>
            </section>

            <section className="rd-dialog-section">
              <h3>项目字段填充</h3>
              <div className="rd-field-confirm-grid">
                {fieldLabels.map(([key, label]) => (
                  <div key={key}>
                    <span>{label}</span>
                    <strong>{fieldValue(workspace, key) || '留空'}</strong>
                    <em>{fieldStatus(workspace, key)}</em>
                  </div>
                ))}
              </div>
            </section>

            <section className="rd-dialog-section">
              <h3>模板附加内容</h3>
              <div className="rd-retention-row">
                <span className={validation?.summary.retainedPrefix ? 'is-ok' : 'is-warning'}>{validation?.summary.retainedPrefix ? '已保留字段区' : '未识别字段区'}</span>
                <span className={validation?.summary.retainedSuffix ? 'is-ok' : 'is-warning'}>{validation?.summary.retainedSuffix ? '已保留说明/签章区' : '未识别说明/签章区'}</span>
              </div>
            </section>

            <section className="rd-dialog-section">
              <h3>校验结论</h3>
              {validation?.issues.length ? (
                <div className="rd-issue-list">
                  {validation.issues.map((issue) => (
                    <article className={`rd-issue rd-issue-${issue.level}`} key={`${issue.code}-${issue.message}`}>
                      <strong>{issue.level === 'error' ? '阻断' : '提醒'} · {issue.message}</strong>
                      {issue.evidence ? <small>证据：{issue.evidence}</small> : null}
                    </article>
                  ))}
                </div>
              ) : <p className="rd-ok-note">未发现需要处理的问题，可以导出 Word。</p>}
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
