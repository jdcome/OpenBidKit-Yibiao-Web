// OpenCode 工作区工具环境（精简移植自桌面 client/electron/services/opencode/opencodeToolEnvironment.cjs）。
// 桌面版把 22 个 unix 命令做成 node shim + 打包 rg/fd/jq 二进制（974 行），因为 Electron 运行时
// 不保证系统有这些工具。Web 服务端由部署者安装 ripgrep/fd/jq，Linux 通常自带 ls/cat/grep/find/sed/...
// 故只移植两件事：① 把 AGENTS.md（工作区约定）写入每个 staging workspace；② 软校验系统工具
// 存在（缺失只 warn，不阻塞——agent 仍可用其余命令）。PATH 无需 prepend（系统工具已在 PATH 上）。

import fs from 'node:fs';
import path from 'node:path';

export const AGENTS_MD_CONTENT = `# 易标 OpenCode 智能体工作区

你在易标客户端创建的临时工作区内工作。

可用命令：rg、fd、jq、node、ls、cat、pwd、head、tail、wc、sort、uniq、mkdir、cp、mv、rm、touch、basename、dirname、realpath、cut、tr、du、stat、grep、find、sed。

约定：
- 只读写当前工作区内的文件。
- 不要访问当前工作区外的路径。
- 不要联网。
- 复杂文本处理或 JSON 处理优先使用 node 小脚本，避免依赖不同平台 shell 行为。
- 需要输出结果时，严格写入任务要求的输出文件。
`;

// opencode 通过它识别工作区根（agent 读/写都以此为边界）。
export const AGENTS_MD_FILENAME = 'AGENTS.md';

// 桌面版打包的 3 个二进制；服务端改为系统安装，启动时软校验。
export const SYSTEM_TOOL_COMMANDS = ['rg', 'fd', 'jq'];

function writeFileIfChanged(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf-8');
    if (current === content) return;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function writeOpenCodeAgentsFile(workspaceDir: string): string {
  if (!workspaceDir) return '';
  const targetPath = path.join(workspaceDir, AGENTS_MD_FILENAME);
  writeFileIfChanged(targetPath, AGENTS_MD_CONTENT);
  return targetPath;
}

// 软校验系统工具：缺哪个记一条 warn，不抛错（agent 仍可降级用其余命令）。
// 返回缺失列表供 selfCheck/诊断展示。
export function verifySystemTools(logger?: (msg: string) => void): string[] {
  const missing: string[] = [];
  for (const command of SYSTEM_TOOL_COMMANDS) {
    try {
      const { spawnSync } = require('node:child_process');
      const result = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 5000 });
      if (result.error || result.status !== 0) missing.push(command);
    } catch {
      missing.push(command);
    }
  }
  if (missing.length && logger) {
    logger(`OpenCode 系统工具缺失（agent 将降级）：${missing.join(', ')}。建议 apt-get install ripgrep jq fd-find`);
  }
  return missing;
}

export interface OpenCodeToolEnvironment {
  agentsPath: string;
  /** 服务端用系统工具，无需 prepend PATH；保留字段以对齐桌面 handle 形状 */
  pathEntries: string[];
  missingTools: string[];
}

export function ensureOpenCodeToolEnvironment(input: {
  workspaceDir: string;
  logger?: (msg: string) => void;
}): OpenCodeToolEnvironment {
  const agentsPath = writeOpenCodeAgentsFile(input.workspaceDir);
  const missingTools = verifySystemTools(input.logger);
  return { agentsPath, pathEntries: [], missingTools };
}

// 对齐桌面 applyOpenCodeToolEnvironment：服务端系统工具已在 PATH，直接透传 env。
export function applyOpenCodeToolEnvironment(
  env: Record<string, string | undefined>,
  _toolEnvironment: OpenCodeToolEnvironment,
): Record<string, string | undefined> {
  return env;
}
