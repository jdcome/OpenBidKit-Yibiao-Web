// 项目汇总页（只读）：仪表盘「查看」已完成全流程项目时进入。复用 useTechnicalPlanWorkflow()
// hydrate 当前激活项目的状态，渲染三块纯只读内容：招标文件解析核心信息 / 全局事实设定 / 技术方案正文。
// 无任何编辑控件；顶部「返回仪表盘」回到 dashboard。
import { MarkdownRenderer } from '../../../shared/ui';
import { useTechnicalPlanWorkflow } from '../../technical-plan/hooks/useTechnicalPlanWorkflow';
import type { SectionId } from '../../../shared/types/navigation';
import type { OutlineItem } from '../../../shared/types';

interface ProjectSummaryPageProps {
  onSectionChange: (section: SectionId) => void;
}

function OutlineNode({ item, depth }: { item: OutlineItem; depth: number }) {
  const hasChildren = !!item.children?.length;
  return (
    <div className="project-summary-outline-node" style={{ marginLeft: depth > 1 ? (depth - 1) * 18 : 0 }}>
      <strong className="project-summary-outline-title">{item.title}</strong>
      {!hasChildren && item.content?.trim() && (
        <div className="project-summary-outline-content">
          <MarkdownRenderer>{item.content ?? ''}</MarkdownRenderer>
        </div>
      )}
      {hasChildren && item.children!.map((child) => (
        <OutlineNode key={child.id} item={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function ProjectSummaryPage({ onSectionChange }: ProjectSummaryPageProps) {
  const { hydrated, state } = useTechnicalPlanWorkflow();

  if (!hydrated) {
    return (
      <div className="dashboard-page">
        <div className="dashboard-shell">
          <p className="dashboard-empty">加载项目数据中…</p>
        </div>
      </div>
    );
  }

  const bidItems = Object.values(state.bidAnalysisTasks || {}).filter((task) => task.content?.trim());
  const outline = state.outlineData?.outline || [];
  const projectName = state.outlineData?.project_name || '技术方案';

  return (
    <div className="dashboard-page project-summary-page">
      <div className="dashboard-shell">
        <header className="dashboard-head">
          <div className="dashboard-head-text">
            <span className="section-kicker">项目汇总</span>
            <h2>{projectName}</h2>
            <p>已完成标书生成全流程，以下为核心内容。如需修改大纲/正文或重新选模板导出，点击右上角「进入技术方案编辑」。</p>
          </div>
          <div className="dashboard-head-actions">
            <button type="button" className="primary-action" onClick={() => onSectionChange('technical-plan')}>
              进入技术方案编辑
            </button>
            <button type="button" className="secondary-action" onClick={() => onSectionChange('dashboard')}>
              返回仪表盘
            </button>
          </div>
        </header>

        <section className="project-summary-block">
          <h3>招标文件解析（核心信息）</h3>
          {state.projectOverview?.trim() && (
            <div className="project-summary-field">
              <h4>项目概述</h4>
              <MarkdownRenderer>{state.projectOverview}</MarkdownRenderer>
            </div>
          )}
          {state.techRequirements?.trim() && (
            <div className="project-summary-field">
              <h4>技术要求</h4>
              <MarkdownRenderer>{state.techRequirements}</MarkdownRenderer>
            </div>
          )}
          {bidItems.length > 0 && (
            <div className="project-summary-field">
              <h4>核心解析项</h4>
              <div className="project-summary-biditems">
                {bidItems.map((item) => (
                  <div key={item.id} className="project-summary-biditem">
                    <strong>{item.label}</strong>
                    <MarkdownRenderer>{item.content}</MarkdownRenderer>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!state.projectOverview?.trim() && !state.techRequirements?.trim() && bidItems.length === 0 && (
            <p className="project-summary-empty">暂无招标文件解析数据</p>
          )}
        </section>

        <section className="project-summary-block">
          <h3>全局事实设定</h3>
          {state.globalFacts.length > 0 ? (
            state.globalFacts.map((group) => (
              <div key={group.id} className="project-summary-field">
                <h4>{group.title}</h4>
                <MarkdownRenderer>{group.content}</MarkdownRenderer>
              </div>
            ))
          ) : (
            <p className="project-summary-empty">暂无全局事实设定</p>
          )}
        </section>

        <section className="project-summary-block">
          <h3>技术方案正文</h3>
          {outline.length > 0 ? (
            <div className="project-summary-outline">
              {outline.map((node) => (
                <OutlineNode key={node.id} item={node} depth={1} />
              ))}
            </div>
          ) : (
            <p className="project-summary-empty">暂无技术方案正文</p>
          )}
        </section>
      </div>
    </div>
  );
}
