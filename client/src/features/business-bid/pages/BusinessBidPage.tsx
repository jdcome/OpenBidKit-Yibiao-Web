const responseItems = [
  { label: '报价得分', status: '待计算', detail: '录入报价与基准价规则后自动换算' },
  { label: '技术得分', status: '待录入', detail: '按技术评分项逐项填写评审分值' },
  { label: '商务得分', status: '待复核', detail: '资质、业绩、服务承诺等评分项统一汇总' },
  { label: '最终得分', status: '待生成', detail: '综合报价、技术、商务三类标准输出总分' },
];

const workflowSteps = [
  { title: '录入评分标准', text: '整理报价、技术、商务评分细则和权重。' },
  { title: '填写投标数据', text: '录入投标报价、技术响应和商务资格得分。' },
  { title: '计算最终得分', text: '按评审规则汇总并生成可复核的得分表。' },
];

function BusinessBidPage() {
  return (
    <div className="demo-coming-page business-bid-demo">
      <div className="feature-under-development-overlay" role="status" aria-live="polite">
        <strong>正在开发中，敬请期待</strong>
        <span>此功能尚未完成，请先不要使用。</span>
      </div>
      <section className="demo-hero-card">
        <div className="demo-hero-copy">
          <span className="section-kicker">投标计算器</span>
          <h2>综合报价、技术、商务评分标准计算标书最终得分</h2>
          <p>这里会用于录入评审办法、投标报价和各项评分结果，辅助形成可复核的投标得分测算。</p>
          <div className="demo-hero-actions">
            <button type="button" className="primary-action" disabled>录入评分标准</button>
          </div>
        </div>
        <div className="demo-metric-stack" aria-label="投标计算器示例指标">
          <article>
            <span>报价分</span>
            <strong>42.6</strong>
            <small>价格评审</small>
          </article>
          <article>
            <span>技术分</span>
            <strong>38.0</strong>
            <small>技术评分</small>
          </article>
          <article>
            <span>总分</span>
            <strong>91.8</strong>
            <small>综合测算</small>
          </article>
        </div>
      </section>

      <div className="demo-content-grid">
        <section className="demo-panel">
          <div className="demo-panel-head">
            <div>
              <span className="section-kicker">响应流程</span>
              <h3>计划中的投标得分测算路径</h3>
            </div>
            <span className="demo-soft-pill">Demo 预览</span>
          </div>
          <div className="demo-step-list">
            {workflowSteps.map((step, index) => (
              <article key={step.title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="demo-panel demo-table-panel">
          <div className="demo-panel-head">
            <div>
              <span className="section-kicker">条款矩阵</span>
              <h3>评分项示例</h3>
            </div>
          </div>
          <div className="demo-table-list">
            {responseItems.map((item) => (
              <article key={item.label}>
                <strong>{item.label}</strong>
                <span className={`demo-status-pill ${item.status === '已响应' ? 'is-ok' : item.status === '待确认' ? 'is-warn' : 'is-danger'}`}>{item.status}</span>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <aside className="demo-preview-card">
          <span className="section-kicker">输出预览</span>
          <h3>投标得分测算表</h3>
          <div className="demo-document-preview">
            <strong>综合得分测算.xlsx</strong>
            <span>报价评分明细.xlsx</span>
            <span>技术评分依据.docx</span>
            <span>商务评分依据.docx</span>
          </div>
          <p>功能上线后会把评分标准、录入数据和最终测算结果集中管理。</p>
        </aside>
      </div>
    </div>
  );
}

export default BusinessBidPage;
