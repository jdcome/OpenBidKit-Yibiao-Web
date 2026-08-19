import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { authRoutes, meRoutes } from './routes/auth';
import { projectRoutes } from './routes/projects';
import { userRoutes } from './routes/users';
import { configRoutes } from './routes/config';
import { systemSettingsPublicRoutes, systemSettingsAdminRoutes } from './routes/system-settings';
import { aiRoutes } from './routes/ai';
import { templateRoutes } from './routes/templates';
import { technicalPlanRoutes } from './routes/technical-plan';
import { knowledgeBaseRoutes } from './routes/knowledge-base';
import { assetLibraryRoutes } from './routes/asset-library';
import { personnelRoutes } from './routes/personnel';
import { duplicateCheckRoutes } from './routes/duplicate-check';
import { rejectionCheckRoutes } from './routes/rejection-check';
import { documentRoutes } from './routes/documents';
import { exportRoutes } from './routes/export';
import { eventRoutes } from './routes/events';
import { taskRoutes } from './routes/tasks';
import { feedbackRoutes } from './routes/feedback';
import { docsRoutes } from './routes/docs';
import { promptReadRoutes, promptAdminRoutes } from './routes/prompts';
import { agentRoutes } from './routes/agent';
import { verifyToken, createRequireAdmin, createRequireProject } from './auth/middleware';
import { createRequireModule } from './auth/permissions';
import { getAiService } from './ai/service';
import { createTechnicalPlanStore } from './technical-plan/store';
import { createDuplicateCheckStore } from './duplicate-check/store';
import { createRejectionCheckStore } from './rejection-check/store';
import { createKnowledgeBaseStore } from './knowledge-base/store';
import { TaskService } from './tasks/service';
import { registerTaskRunners } from './tasks/runners';
import { createOpenCodeRuntimeService } from './agent/runtimeService';
import { createPiRuntimeService } from './agent/piRuntimeService';
import type { AgentService } from './agent/types';
import { eventBus } from './events/bus';
import { primeAppConfigCache, getLiveAgentAiConfig } from './config/store';
import { createAiDiagnosticStorage } from './ai-diagnostics/storage';
import { createAiDiagnosticsService } from './ai-diagnostics/service';
import { aiDiagnosticRoutes } from './ai-diagnostics/routes';
import { getAiDiagnosticsRoot } from './document/paths';
import { createProjectTenderSourceService } from './response-deviation/tenderSource';
import { createResponseDeviationStore } from './response-deviation/store';
import { responseDeviationRoutes } from './routes/response-deviation';

const prisma = new PrismaClient({
  // 默认交互事务超时 5s → 30s：正文落库会逐行写大纲/章节，大目录 + 高并发下顶破 5s
  // 会抛 "Transaction already closed"。根治（saveOutlineData 批量化）后正常路径远低于此，此值仅作安全垫。
  transactionOptions: { timeout: 30_000 },
});

// 任务引擎单例：跨请求共享 activeTasks 内存 + aiService 队列。
// runner 注册表此时为空（L3）；L4 调 taskService.registerRunner 落入 9 个真实 runner。
// 崩溃恢复按用户懒触发（getActiveTasks 时跑），不在 boot 全量扫描——与桌面 getActiveTasks 语义一致。
// technicalPlanStore 返回具体 TechnicalPlanState，engine 内部按 loose Record 处理，故此处收窄类型。
const technicalPlanStore = createTechnicalPlanStore(prisma);
const tenderSourceService = createProjectTenderSourceService(prisma, technicalPlanStore);
const responseDeviationStore = createResponseDeviationStore(prisma);
const aiDiagnostics = createAiDiagnosticsService({
  prisma,
  storage: createAiDiagnosticStorage(getAiDiagnosticsRoot()),
  logger: { error: (error) => console.error('[ai-diagnostics]', error) },
});
// Agent 运行时（进程级单例）。YIBIAO_AGENT_RUNTIME 选 'pi'（默认：进程内 ESM SDK，零原生依赖）
// 或 'opencode'（M1-P7 sidecar 二进制回退，需 YIBIAO_OPENCODE_BIN）。两者共享同一 AI Proxy
// （复用平台 key）与 AgentService 契约，runner 无感切换。boot 失败（SDK 缺失 / 平台 AI key 未设）
// 被吞 → phase stopped/unhealthy；runner 既有 agent 守卫（if (!agentService?.runTask) / busy 哨兵 / 抛错）
// 据此降级——outline 走 LLM 兜底、content 软降级——不崩主服务。配置每请求经 getLiveAgentAiConfig live 读。
const agentRuntime = (process.env.YIBIAO_AGENT_RUNTIME || 'pi').toLowerCase();
const agentService: AgentService =
  agentRuntime === 'opencode'
    ? createOpenCodeRuntimeService({ binPath: process.env.YIBIAO_OPENCODE_BIN, loadConfig: getLiveAgentAiConfig })
    : createPiRuntimeService({ loadConfig: getLiveAgentAiConfig });
// pi ask-user：提问挂起/清除时，按 question.project_id 路由到对应项目的 SSE agent-question 通道。
// opencode 回退不实现 onQuestion（undefined），守卫跳过；project_id 缺省（V1 一次性任务）时前端退化为轮询。
agentService.onQuestion?.((question) => {
  if (question?.project_id != null) {
    eventBus.emit(String(question.project_id), 'agent-question', question);
  }
});
const taskService = new TaskService({
  prisma,
  aiService: getAiService(),
  agentService,
  technicalPlanStore: technicalPlanStore as unknown as {
    loadTechnicalPlan(projectId: number): Promise<Record<string, unknown>>;
    updateTechnicalPlan(projectId: number, partial: Record<string, unknown>): Promise<Record<string, unknown>>;
    readTenderMarkdown(projectId: number): Promise<string>;
    readOriginalTenderMarkdown(projectId: number): Promise<string>;
    readOriginalPlanMarkdown(projectId: number): Promise<string>;
    prepareBidSectionExtraction(projectId: number): Promise<Record<string, unknown>>;
  },
  rejectionCheckStore: createRejectionCheckStore(prisma),
  duplicateCheckStore: createDuplicateCheckStore(prisma),
  responseDeviationStore,
  tenderSourceService,
  knowledgeBaseService: createKnowledgeBaseStore(prisma),
  aiDiagnostics,
});

// L4：注册已移植的 task runner（首个：rejection-items-extraction）。
// 未注册的 type 走 start-* 的 501 "执行器尚未注册" 兜底。
registerTaskRunners(taskService);

const app = Fastify({ logger: true });

// 暴露 prisma + taskService + agentService 给路由：app.prisma / app.taskService / app.agentService
app.decorate('prisma', prisma);
app.decorate('taskService', taskService);
app.decorate('agentService', agentService);
app.decorate('aiDiagnostics', aiDiagnostics);
app.decorate('responseDeviationStore', responseDeviationStore);
app.decorate('tenderSourceService', tenderSourceService);
void aiDiagnostics.cleanupExpired();

await app.register(cors, {
  origin: true, // dev 放开；prod 收紧到前端域名
  credentials: true,
  // 必须显式声明：默认 preflight 只回 GET/HEAD/POST，会导致浏览器侧所有 PUT/DELETE/PATCH
  // 在预检后被静默拦截（net::ERR_FAILED，请求根本不到服务端）。配置保存、模板改删等均受影响。
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
});

// multipart：文件上传（P4）。fileSize 上限 100MB（招标文件/标书可能较大）；
// 单文件流式 toBuffer 落临时文件后交 parseDocument。P4-2/3 各域上传路由复用。
await app.register(multipart, {
  limits: { fileSize: 100 * 1024 * 1024 },
});

// 公开路由
await app.register(authRoutes, { prefix: '/api' });
await app.register(systemSettingsPublicRoutes, { prefix: '/api' });

// 受保护路由（统一 onRequest 鉴权）
await app.register(
  async (protectedApp) => {
    protectedApp.addHook('onRequest', verifyToken);

    // /me：当前用户最新信息（权限即时生效的拉取端点，前端窗口聚焦/60s 定时调）。
    await protectedApp.register(meRoutes, { prefix: '/api' });

    // 非项目作用域：配置/系统设置/AI/文档/项目 CRUD/事件 SSE。
    await protectedApp.register(configRoutes, { prefix: '/api' });
    await protectedApp.register(systemSettingsAdminRoutes, { prefix: '/api' });
    await protectedApp.register(aiRoutes, { prefix: '/api' });
    await protectedApp.register(documentRoutes, { prefix: '/api' });
    await protectedApp.register(projectRoutes, { prefix: '/api' });
    await protectedApp.register(eventRoutes, { prefix: '/api' });
    // 提示词目录只读：任何登录用户可读（招标解析页需拉任务列表）。promptText 正文见 admin 路由。
    await protectedApp.register(promptReadRoutes, { prefix: '/api' });
    // Agent sidecar 运维：status 登录可读，self-check/restart 路由内 admin 校验。
    await protectedApp.register(agentRoutes, { prefix: '/api' });
    // 模块门禁：使用文档。普通用户需 modules 含 docs。
    await protectedApp.register(async (docsApp) => {
      docsApp.addHook('onRequest', createRequireModule(prisma, 'docs'));
      await docsApp.register(docsRoutes, { prefix: '/api' });
    });

    // 模块门禁：问题FAQ（反馈问答）。普通用户需 modules 含 faq。
    await protectedApp.register(async (faqApp) => {
      faqApp.addHook('onRequest', createRequireModule(prisma, 'faq'));
      await faqApp.register(feedbackRoutes, { prefix: '/api' });
    });

    // 模块门禁：格式管理（ExportTemplate CRUD）。普通用户需 modules 含 template-settings。
    await protectedApp.register(async (formatApp) => {
      formatApp.addHook('onRequest', createRequireModule(prisma, 'template-settings'));
      await formatApp.register(templateRoutes, { prefix: '/api' });
    });

    // 模块门禁：方案模版（知识库管理）+ 资产/资质库 + 人员资质库。普通用户需 modules 含 knowledge-base。
    await protectedApp.register(async (kbApp) => {
      kbApp.addHook('onRequest', createRequireModule(prisma, 'knowledge-base'));
      await kbApp.register(knowledgeBaseRoutes, { prefix: '/api' });
      await kbApp.register(assetLibraryRoutes, { prefix: '/api' });
      await kbApp.register(personnelRoutes, { prefix: '/api' });
    });

    // 管理员专属：用户管理（注册审批/停用/编辑/删除）+ 提示词管理（编辑招标/废标 prompt）。
    // verifyToken 之后叠加 requireAdmin。
    const requireAdmin = createRequireAdmin();
    await protectedApp.register(async (adminApp) => {
      adminApp.addHook('onRequest', requireAdmin);
      await adminApp.register(userRoutes, { prefix: '/api' });
      await adminApp.register(promptAdminRoutes, { prefix: '/api' });
      await adminApp.register(aiDiagnosticRoutes, { prefix: '/api' });
    });

    // 项目作用域：technical-plan/export/tasks（标书生成基础设施，默认开放）。
    // 标书检查（duplicate-check/rejection-check）叠加模块门禁 bid-check。
    const requireProject = createRequireProject(prisma);
    const requireBidCheck = createRequireModule(prisma, 'bid-check');
    await protectedApp.register(async (projectApp) => {
      projectApp.addHook('onRequest', requireProject);
      await projectApp.register(technicalPlanRoutes, { prefix: '/api' });
      await projectApp.register(exportRoutes, { prefix: '/api' });
      await projectApp.register(taskRoutes, { prefix: '/api' });
      await projectApp.register(responseDeviationRoutes, { prefix: '/api' });
      await projectApp.register(async (bidCheckApp) => {
        bidCheckApp.addHook('onRequest', requireBidCheck);
        await bidCheckApp.register(duplicateCheckRoutes, { prefix: '/api' });
        await bidCheckApp.register(rejectionCheckRoutes, { prefix: '/api' });
      });
    });
  },
);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`yibiao-server listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// 预暖平台配置缓存，使 agent sidecar boot 时 getLiveAgentAiConfig 立即可读；
// 随后非阻塞拉起 sidecar（失败仅 warn：runner 守卫据此降级，不崩主服务）。
void primeAppConfigCache(prisma)
  .then(() => agentService.boot())
  .catch((err) => app.log.warn({ err }, 'agent sidecar boot failed'));

// 优雅关闭：SIGTERM/SIGINT 先停 agent sidecar（abort 活动任务 + 关 opencode/proxy），再关 HTTP。
// server 原先无 signal handler，PM2 reload / docker stop 会直接 SIGTERM → 进程即时退出、
// agent sidecar 子进程残留。这里保证 sidecar 与主进程同生共死。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`received ${signal}, shutting down`);
  try {
    await agentService.close();
  } catch (err) {
    app.log.warn({ err }, 'agent sidecar close failed');
  }
  try {
    await app.close();
  } catch (err) {
    app.log.warn({ err }, 'app close failed');
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
