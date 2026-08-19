import type { AppMenuItem, SectionId } from '../shared/types/navigation';
import { canAccessSection } from '../shared/permissions';

export const appMenuItems: AppMenuItem[] = [
  {
    id: 'dashboard',
    label: '仪表盘',
    description: '项目总览与统计',
  },
  {
    id: 'bid-generation',
    label: '标书生成',
    description: '技术方案、投标计算器与响应偏离表编制',
    children: [
      {
        id: 'technical-plan',
        label: '生成技术方案',
        description: '根据招标文件重头编写一份标书',
        icon: 'document',
      },
      {
        id: 'existing-plan-expansion',
        label: '已有方案扩写',
        description: '解决人写技术方案太薄的问题，上传写好的方案，进行优化和扩充，遵从原方案真实可落地，又能扩写出厚厚的标书',
        icon: 'expand',
      },
      {
        id: 'business-bid',
        label: '投标计算器',
        description: '综合报价、技术、商务评分标准计算标书最终得分',
        icon: 'briefcase',
        notice: { message: '正在开发中，敬请期待。' },
      },
      {
        id: 'response-deviation-table',
        label: '响应与偏离表工作台',
        description: '复用招标原文，生成技术响应与偏离表并人工填写响应。',
        icon: 'compare',
      },
    ],
  },
  {
    id: 'template-settings',
    label: '格式管理',
    description: '标书导出模板与排版配置',
    children: [
      {
        id: 'my-templates',
        label: '我的模板',
        description: '管理已保存的标书导出模板',
        icon: 'document',
      },
      {
        id: 'new-template',
        label: '新建模板',
        description: '配置 Word 文档排版与编号格式',
        icon: 'export',
      },
    ],
  },
  {
    id: 'knowledge-base',
    label: '知识库',
    description: '素材、模板和资质',
    children: [
      {
        id: 'document-knowledge-base',
        label: '方案模板库',
        description: '管理文档资料、案例素材和可复用知识条目',
        icon: 'document',
      },
      {
        id: 'tool-asset-library',
        label: '工具模板库',
        description: '工具功能截图、软著、采购证明等资产',
        icon: 'file',
      },
      {
        id: 'company-qualification-library',
        label: '公司资质库',
        description: '公司资质证书、认证证书，支持到期提醒',
        icon: 'shield',
      },
      {
        id: 'personnel-qualification-library',
        label: '人员资质库',
        description: '人员资质证书、认证证书，支持到期提醒',
        icon: 'briefcase',
      },
    ],
  },
  {
    id: 'bid-check',
    label: '标书检查',
    description: '查重、废标项与合规检查',
    children: [
      {
        id: 'duplicate-check',
        label: '标书查重',
        description: '相似度与重复表达检测',
        icon: 'compare',
      },
      {
        id: 'rejection-check',
        label: '废标项检查',
        description: '硬性条款与响应完整性',
        icon: 'shield',
      },
    ],
  },
  {
    id: 'docs',
    label: '使用文档',
    description: '使用教程与配置说明',
    children: [
      {
        id: 'docs-usage',
        label: '使用',
        description: '功能使用教程',
        icon: 'document',
      },
      {
        id: 'docs-config',
        label: '配置',
        description: '模型与系统配置说明',
        icon: 'document',
      },
    ],
  },
  {
    id: 'faq',
    label: '问题FAQ',
    description: '问题反馈与解答',
  },
  {
    id: 'user-management',
    label: '用户管理',
    description: '账号审批与权限',
  },
  {
    id: 'prompt-management',
    label: '提示词管理',
    description: '编辑招标解析与废标检查提示词',
  },
];

const developerMenuItems: AppMenuItem[] = [
  {
    id: 'developer-test',
    label: '测试页',
    description: '开发者验证与问题复现',
    children: [
      {
        id: 'developer-json-test',
        label: 'Json请求测试',
        description: '复用项目真实目录生成链路，验证模型 JSON 响应和修复流程。',
        icon: 'code',
      },
      {
        id: 'developer-prompt-lab',
        label: 'Prompt调试台',
        description: '集中观察 Prompt 版本、变量注入和输出约束，便于后续调参。',
        icon: 'prompt',
      },
      {
        id: 'developer-parser-sandbox',
        label: '文件解析沙盘',
        description: '模拟本地解析、MinerU 解析和图片资产入库的调试入口。',
        icon: 'file',
      },
      {
        id: 'developer-export-preview',
        label: '导出链路预演',
        description: '预览 Word、Markdown、Mermaid 图片转换的导出检查路径。',
        icon: 'export',
      },
      {
        id: 'developer-expansion-replace-test',
        label: '扩写替换测试',
        description: '使用真实扩写 patch 应用逻辑，复现 replace 锚点未命中后的追加问题。',
        icon: 'tool',
      },
      {
        id: 'developer-opencode-agent-test',
        label: 'OpenCode Agent测试',
        description: '验证常驻 OpenCode Server、OpenCode AI proxy、agentService 的完整链路。',
        icon: 'tool',
      },
    ],
  },
];

// 菜单可见性：管理员见全部；普通用户按 canAccessSection（默认开放 + 已授予模块）过滤。
// user-management 仅管理员可见（canAccessSection 已覆盖）。普通用户的模块权限由 modules 决定。
// 未传 role/modules（结构查询场景：getAppMenuItemById/getSectionOrder）返回全量菜单。
export function getAppMenuItems(developerMode: boolean, role?: string, modules?: string[]): AppMenuItem[] {
  const base = developerMode ? [...appMenuItems, ...developerMenuItems] : appMenuItems;
  if (role === undefined && modules === undefined) return base;
  return base
    .map((item) => {
      if (!item.children) {
        return canAccessSection(role, modules, item.id) ? item : null;
      }
      const children = item.children.filter((child) => canAccessSection(role, modules, child.id));
      // 父项自身可访问（默认开放/已授予模块）或仍有可见子项则保留。
      if (children.length > 0 || canAccessSection(role, modules, item.id)) {
        return { ...item, children };
      }
      return null;
    })
    .filter((item): item is AppMenuItem => item !== null);
}

export function getSectionOrder(developerMode: boolean): SectionId[] {
  return getAppMenuItems(developerMode).flatMap((item) => [item.id, ...(item.children?.map((child) => child.id) ?? [])]);
}

export function getAppMenuItemById(id: SectionId, developerMode: boolean): AppMenuItem | undefined {
  return getAppMenuItems(developerMode).find((item) => item.id === id);
}

export function getParentMenuItemBySection(section: SectionId, developerMode: boolean): AppMenuItem | undefined {
  return getAppMenuItems(developerMode).find((item) => item.id === section || item.children?.some((child) => child.id === section));
}
