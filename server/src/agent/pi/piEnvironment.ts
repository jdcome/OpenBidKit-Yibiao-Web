// Pi 运行环境准备（移植自桌面 electron/services/pi/piEnvironment.cjs）。
// 桌面用 Electron app.getPath；web 用 dataDir（getAgentPiLayout）。
// ensureAgentToolEnvironment/applyAgentToolEnvironment 复用 web 的 toolEnvironment.ts（与 opencode 同语义）。

import fs from 'node:fs';
import path from 'node:path';
import { getAgentPiLayout, type AgentPiLayout } from '../../document/paths';
import {
  AGENTS_MD_CONTENT,
  applyOpenCodeToolEnvironment,
  ensureOpenCodeToolEnvironment,
  type OpenCodeToolEnvironment,
} from '../toolEnvironment';

export interface PreparedPiEnvironment {
  layout: AgentPiLayout;
  env: Record<string, string | undefined>;
  shellPath: string;
  shellCommandPrefix: string;
  toolEnvironment: OpenCodeToolEnvironment;
  /** 写入每个 per-task staging 工作区的约定文本（AGENTS.md 内容） */
  instructions: string;
}

// 创建 Pi 运行所需目录和共享命令环境。
// 桌面 preparePiEnvironment(app) → web preparePiEnvironment(dataDir)。
export function preparePiEnvironment(dataDir?: string): PreparedPiEnvironment {
  const layout = getAgentPiLayout(dataDir);
  for (const directory of Object.values(layout)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const toolEnvironment = ensureOpenCodeToolEnvironment({
    workspaceDir: layout.workspaceDir,
    logger: (msg: string) => console.warn(`[pi-env] ${msg}`),
  });
  const env = applyOpenCodeToolEnvironment(
    {
      ...process.env,
      HOME: layout.homeDir,
      USERPROFILE: layout.homeDir,
      TEMP: layout.tempDir,
      TMP: layout.tempDir,
      TMPDIR: layout.tempDir,
    },
    toolEnvironment,
  );
  const shellPath =
    process.platform === 'win32'
      ? path.join(
          process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        )
      : '/bin/sh';
  const shellCommandPrefix =
    process.platform === 'win32'
      ? [
          "@('cat', 'cp', 'ls', 'mkdir', 'mv', 'pwd', 'rm', 'sort') | ForEach-Object { Remove-Item -LiteralPath \"Alias:$_\" -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath \"Function:$_\" -Force -ErrorAction SilentlyContinue }",
          '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
          '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        ].join('\n')
      : '';
  return {
    layout,
    env,
    shellPath,
    shellCommandPrefix,
    toolEnvironment,
    instructions: AGENTS_MD_CONTENT,
  };
}
