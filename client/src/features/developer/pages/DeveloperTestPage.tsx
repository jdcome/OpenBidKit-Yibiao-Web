import { useState } from 'react';
import { aiClient } from '../../../shared/ai/aiClient';
import { requestOutlineGeneration } from '../../technical-plan/services/outlineWorkflow';

type RunningMode = 'text' | 'json' | null;

const sampleTenderContent = `# 金盾测试项目招标文件

项目名称：金盾测试项目。
项目编号：YB-TEST-001。
项目类型：软件服务。
项目预算：100 万元。
项目地址：北京市海淀区。

技术评分要求：
1. 技术方案完整性，满分 30 分，要求章节完整、实施路径清晰。
2. 项目实施计划，满分 20 分，要求进度安排合理、风险控制明确。
3. 运维服务能力，满分 15 分，要求说明响应时效和服务保障。`;

const sampleOutlineInput = {
  overview: '金盾测试项目，软件服务类采购，预算 100 万元，实施地点北京市海淀区。',
  requirements: '技术方案完整性 30 分；项目实施计划 20 分；运维服务能力 15 分。',
};

// 开发者测试固定复用 projectInfo 任务（JSON 抽取）。提示词来源已迁移到 DB（提示词管理），
// 此处只保留这一个测试夹具，不再依赖旧的客户端同源镜像 bidAnalysisWorkflow。
function jsonTask(title: string, goals: string, outputJson: string) {
  return `任务：${title}

目标：${goals}

约束：
1. 输出格式必须为 JSON。
2. 严格按照以下 JSON 格式输出，只修改 value，禁止修改 key 和结构。
3. 原文中没有的字段填充“没有提及”。

JSON 格式：
${outputJson}

仅输出 JSON，不要输出其他内容。`;
}

const textTask = {
  id: 'projectInfo',
  label: '项目信息',
  output: 'json' as const,
  buildTaskPrompt: () => jsonTask('提取项目信息', '提取项目名称、项目编号、项目类型、项目预算、项目地址。', `{
  "project_name": "项目名称",
  "project_number": "项目编号",
  "project_type": "项目类型",
  "project_budget": "项目预算",
  "project_address": "项目地址"
}`),
};

const textSystemPrompt = `你是专业的招标文件分析助手。请严格基于用户提供的招标文件原文完成提取和总结。

通用要求：
1. 保持信息全面、准确，尽量使用原文内容，不要自行编造。
2. 如果原文没有提及，明确写“没有提及”或“原文未提及”。
3. 只输出最终结果，不输出过程、提示语或客套话。
4. 始终使用简体中文。`;

function DeveloperTestPage() {
  const [runningMode, setRunningMode] = useState<RunningMode>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [result, setResult] = useState('');

  const appendEvent = (message: string) => {
    setEvents((prev) => [...prev, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`]);
  };

  const resetOutput = () => {
    setEvents([]);
    setContent('');
    setResult('');
  };

  const runTextTest = async () => {
    if (!textTask) {
      appendEvent('未找到项目中的 JSON 招标文件解析任务。');
      return;
    }

    resetOutput();
    setRunningMode('text');
    appendEvent(`调用通用 AI 文本请求：aiClient.chat(${textTask.label})。`);

    try {
      const nextContent = await aiClient.chat({
        messages: [
          { role: 'system', content: textSystemPrompt },
          { role: 'user', content: `以下是完整招标文件 Markdown 原文。后续任务必须仅基于这份原文完成：\n\n${sampleTenderContent}` },
          { role: 'user', content: textTask.buildTaskPrompt() },
        ],
        temperature: 0.1,
        response_format: textTask.output === 'json' ? { type: 'json_object' } : undefined,
        logTitle: `开发者测试-${textTask.label}`,
      });
      setContent(nextContent);
      appendEvent('文本请求完成。');
    } catch (error) {
      appendEvent(`文本请求错误：${error instanceof Error ? error.message : 'AI 文本请求失败'}`);
    } finally {
      setRunningMode(null);
    }
  };

  const runJsonTest = async () => {
    resetOutput();
    setRunningMode('json');
    appendEvent('调用项目真实 JSON 请求：requestOutlineGeneration。');

    try {
      const outline = await requestOutlineGeneration({
        ...sampleOutlineInput,
        onProgress: appendEvent,
      });
      setResult(JSON.stringify(outline, null, 2));
      appendEvent('JSON 请求完成。');
    } catch (error) {
      appendEvent(`JSON 请求错误：${error instanceof Error ? error.message : 'AI JSON 请求失败'}`);
    } finally {
      setRunningMode(null);
    }
  };

  const running = runningMode !== null;

  return (
    <div className="page-stack developer-test-page">
      <section className="panel developer-test-hero">
        <div className="hero-copy">
          <span className="eyebrow">JSON Request Lab</span>
          <h2>Json请求测试</h2>
          <p>
            这里复用项目真实业务请求来复现 response_format 兼容问题：文本按钮使用招标文件解析任务，Json 按钮使用目录生成任务。
          </p>
          <div className="developer-test-actions">
            <button type="button" className="primary-action" onClick={runTextTest} disabled={running || !textTask}>
              {runningMode === 'text' ? '文本请求中...' : '测试文本请求'}
            </button>
            <button type="button" className="primary-action" onClick={runJsonTest} disabled={running}>
              {runningMode === 'json' ? 'JSON 请求中...' : '测试 JSON 请求'}
            </button>
          </div>
        </div>
      </section>

      <div className="developer-test-grid">
        <section className="panel developer-test-panel">
          <div className="settings-section-title">
            <span />
            <strong>文本复用入口</strong>
          </div>
          <pre>{JSON.stringify({ service: 'aiClient.chat', task: textTask?.id, sample: sampleTenderContent }, null, 2)}</pre>
        </section>

        <section className="panel developer-test-panel">
          <div className="settings-section-title">
            <span />
            <strong>JSON 复用入口</strong>
          </div>
          <pre>{JSON.stringify({ service: 'requestOutlineGeneration', input: sampleOutlineInput }, null, 2)}</pre>
        </section>

        <section className="panel developer-test-panel is-wide">
          <div className="settings-section-title">
            <span />
            <strong>事件日志</strong>
          </div>
          <pre>{events.length ? events.join('\n') : '尚未开始请求。'}</pre>
        </section>

        <section className="panel developer-test-panel is-wide">
          <div className="settings-section-title">
            <span />
            <strong>返回内容</strong>
          </div>
          <pre>{content || result || '暂无内容。'}</pre>
        </section>
      </div>
    </div>
  );
}

export default DeveloperTestPage;
