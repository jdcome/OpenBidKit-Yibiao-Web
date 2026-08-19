// 按用户隔离的工作区磁盘路径层（移植自 client/electron/utils/paths.cjs）。
// 桌面用 app.getPath('userData')/workspace/；Web 用 <dataDir>/<userId>/workspace/ 镜像同一棵树。
// DB 列（tenderMarkdownPath/markdownPath/filePath/contentPath）存 **相对 workspace 的相对路径**，
// 读时 join(workspaceDir, rel) 还原绝对路径——这样 dataDir 迁移不破坏数据。
import path from 'node:path';

export function getDataDir(): string {
  return process.env.YIBIAO_DATA_DIR || path.resolve(process.cwd(), 'data');
}

// OpenCode agent 运行时目录（移植自桌面 client/electron/utils/paths.cjs getAgentRuntimeDir/getAgentCacheDir）。
// 进程级单例 sidecar（非按用户隔离），与 shared/ 和 <userId>/ 平级，置于 dataDir 下。
// 布局：<dataDir>/agent-runtime/{service/{workspace,home/.local/share/opencode/opencode.json},tasks/<taskId>/workspace}
export function getAgentRuntimeDir(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'agent-runtime');
}

export function getAgentServiceDir(dataDir: string = getDataDir()): string {
  return path.join(getAgentRuntimeDir(dataDir), 'service');
}

export function getAgentServiceWorkspaceDir(dataDir: string = getDataDir()): string {
  return path.join(getAgentServiceDir(dataDir), 'workspace');
}

export function getAgentServiceHomeDir(dataDir: string = getDataDir()): string {
  return path.join(getAgentServiceDir(dataDir), 'home');
}

export function getAgentTasksRoot(dataDir: string = getDataDir()): string {
  return path.join(getAgentRuntimeDir(dataDir), 'tasks');
}

export function getAgentTaskDir(taskId: string, dataDir: string = getDataDir()): string {
  return path.join(getAgentTasksRoot(dataDir), taskId);
}

export function getAgentCacheDir(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'agent-cache');
}

export interface AgentPiLayout {
  runtimeRoot: string;
  serviceRoot: string;
  workspaceDir: string;
  tasksRoot: string;
  homeDir: string;
  agentDir: string;
  tempDir: string;
}

// Pi 运行时目录布局（移植自桌面 electron/services/pi/piEnvironment.cjs createPiEnvironmentLayout）。
// 与 opencode 的 service/ 平级，置于 agent-runtime/pi/ 下；两 runtime 共存互不干扰（env YIBIAO_AGENT_RUNTIME 选择）。
// 布局：<dataDir>/agent-runtime/pi/{service/{workspace,home/.pi/agent,tmp}, tasks/<taskKey>/{workspace,sessions}}
export function getAgentPiLayout(dataDir: string = getDataDir()): AgentPiLayout {
  const runtimeRoot = path.join(getAgentRuntimeDir(dataDir), 'pi');
  const serviceRoot = path.join(runtimeRoot, 'service');
  const homeDir = path.join(serviceRoot, 'home');
  return {
    runtimeRoot,
    serviceRoot,
    workspaceDir: path.join(serviceRoot, 'workspace'),
    tasksRoot: path.join(runtimeRoot, 'tasks'),
    homeDir,
    agentDir: path.join(homeDir, '.pi', 'agent'),
    tempDir: path.join(serviceRoot, 'tmp'),
  };
}

// 知识库全公司共享（无 userId 隔离），独立于按用户隔离的 workspace 树。
// DB 的 document_dir/source_path/markdown_path 存 **相对 kbRoot 的相对路径**（与桌面一致）。
export interface KnowledgeBasePaths {
  kbRoot: string;
  resolve: (relativePath: string) => string;
  relativize: (absolutePath: string) => string;
  documentDir: (folderId: string, documentId: string) => string;
}

export function getSharedKnowledgeBaseDir(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'shared', 'knowledge-base');
}

export function getAiDiagnosticsRoot(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'ai-diagnostics');
}

// 资产/资质库（工具/公司/人员）全公司共享，独立于 workspace 树。文件落 <dataDir>/shared/asset-library/<library>/<itemId>/<fileId><ext>。
export function getAssetLibraryDir(dataDir: string = getDataDir(), library: string): string {
  return path.join(dataDir, 'shared', 'asset-library', library);
}

export function getAssetItemDir(dataDir: string = getDataDir(), library: string, itemId: string): string {
  return path.join(getAssetLibraryDir(dataDir, library), itemId);
}

export function getAssetFilePath(
  dataDir: string = getDataDir(),
  library: string,
  itemId: string,
  fileId: string,
  ext: string,
): string {
  return path.join(getAssetItemDir(dataDir, library, itemId), `${fileId}${ext || ''}`);
}

// 人员资质库（一人多证）全公司共享。文件落 <dataDir>/shared/personnel/<profileId>/<certId>/<fileId><ext>。
export function getPersonnelProfileDir(dataDir: string = getDataDir(), profileId: string): string {
  return path.join(dataDir, 'shared', 'personnel', profileId);
}

export function getPersonnelCertFile(
  dataDir: string = getDataDir(),
  profileId: string,
  certId: string,
  fileId: string,
  ext: string,
): string {
  return path.join(getPersonnelProfileDir(dataDir, profileId), certId, `${fileId}${ext || ''}`);
}

export function createKnowledgeBasePaths(dataDir: string = getDataDir()): KnowledgeBasePaths {
  const kbRoot = getSharedKnowledgeBaseDir(dataDir);
  const resolve = (relativePath: string): string =>
    path.resolve(kbRoot, String(relativePath || ''));
  const relativize = (absolutePath: string): string => path.relative(kbRoot, absolutePath);
  return {
    kbRoot,
    resolve,
    relativize,
    documentDir: (folderId, documentId) =>
      path.join(kbRoot, 'folders', folderId, 'documents', documentId),
  };
}

export interface WorkspacePaths {
  userId: number;
  dataDir: string;
  workspaceDir: string;
  technicalPlanDir: string;
  technicalPlanTenderMarkdownPath: string;
  technicalPlanTenderOriginalMarkdownPath: string;
  technicalPlanOriginalPlanMarkdownPath: string;
  technicalPlanTenderFilesDir: string;
  duplicateCheckDir: string;
  duplicateCheckSourcesDir: string;
  duplicateCheckContentDir: string;
  rejectionCheckDir: string;
  rejectionCheckTenderMarkdownPath: string;
  knowledgeBaseDir: string;
  knowledgeBaseDocumentDir: (folderId: string, documentId: string) => string;
  rejectionCheckDocumentMarkdownPath: (role: string, documentId: string) => string;
  /** resolve a DB-stored relative path to absolute */
  resolve: (relativePath: string) => string;
  /** compute relative path for DB storage */
  relativize: (absolutePath: string) => string;
}

export function createWorkspacePaths(userId: number, dataDir: string = getDataDir()): WorkspacePaths {
  const workspaceDir = path.join(dataDir, String(userId), 'workspace');
  const technicalPlanDir = path.join(workspaceDir, 'technical-plan');
  const duplicateCheckDir = path.join(workspaceDir, 'duplicate-check');
  const rejectionCheckDir = path.join(workspaceDir, 'rejection-check');
  const knowledgeBaseDir = path.join(workspaceDir, 'knowledge-base');

  const resolve = (relativePath: string): string =>
    path.resolve(workspaceDir, String(relativePath || ''));
  const relativize = (absolutePath: string): string => path.relative(workspaceDir, absolutePath);

  return {
    userId,
    dataDir,
    workspaceDir,
    technicalPlanDir,
    technicalPlanTenderMarkdownPath: path.join(technicalPlanDir, 'tender.md'),
    technicalPlanTenderOriginalMarkdownPath: path.join(technicalPlanDir, 'tender-original.md'),
    technicalPlanOriginalPlanMarkdownPath: path.join(technicalPlanDir, 'original-plan.md'),
    technicalPlanTenderFilesDir: path.join(technicalPlanDir, 'tender-files'),
    duplicateCheckDir,
    duplicateCheckSourcesDir: path.join(duplicateCheckDir, 'sources'),
    duplicateCheckContentDir: path.join(duplicateCheckDir, 'contents'),
    rejectionCheckDir,
    rejectionCheckTenderMarkdownPath: path.join(rejectionCheckDir, 'tender.md'),
    knowledgeBaseDir,
    knowledgeBaseDocumentDir: (folderId, documentId) =>
      path.join(knowledgeBaseDir, 'folders', folderId, 'documents', documentId),
    rejectionCheckDocumentMarkdownPath: (role, documentId) => {
      if (role === 'bid') {
        const safe = String(documentId || 'bid').replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(rejectionCheckDir, 'bids', `${safe}.md`);
      }
      const id = String(documentId || '').trim();
      if (id && id !== 'tender') {
        const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(rejectionCheckDir, 'tenders', `${safe}.md`);
      }
      return path.join(rejectionCheckDir, 'tender.md');
    },
    resolve,
    relativize,
  };
}
