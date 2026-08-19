import type { SectionId } from './types/navigation';

// 可授予的功能模块（用户管理矩阵展示用）。user-management 仅管理员可用，不可授予普通用户。
// 与 server/src/auth/permissions.ts ASSIGNABLE_MODULE_IDS 保持同源。
export interface AssignableModule {
  id: SectionId;
  label: string;
}

export const ASSIGNABLE_MODULES: AssignableModule[] = [
  { id: 'template-settings', label: '格式管理' },
  { id: 'knowledge-base', label: '知识库' },
  { id: 'bid-check', label: '标书检查' },
  { id: 'resources', label: '资源下载' },
  { id: 'docs', label: '使用文档' },
  { id: 'faq', label: '问题FAQ' },
  { id: 'user-management', label: '用户管理' },
];

// 普通用户实际可被授予的模块（排除 user-management）。
export const GRANTABLE_MODULE_IDS: SectionId[] = [
  'template-settings',
  'knowledge-base',
  'bid-check',
  'resources',
  'docs',
  'faq',
];

// 默认对所有登录用户开放的模块（不进授予集）。
const DEFAULT_OPEN_MODULES: SectionId[] = ['dashboard', 'bid-generation'];

// 子路由 → 所属模块映射（用于判定深链/子页面归属）。
const SECTION_TO_MODULE: Partial<Record<SectionId, SectionId>> = {
  // 格式管理
  'my-templates': 'template-settings',
  'new-template': 'template-settings',
  'export-format': 'template-settings',
  // 知识库
  'document-knowledge-base': 'knowledge-base',
  'tool-asset-library': 'knowledge-base',
  'company-qualification-library': 'knowledge-base',
  'personnel-qualification-library': 'knowledge-base',
  // 标书检查
  'duplicate-check': 'bid-check',
  'rejection-check': 'bid-check',
  // 使用文档（faq 顶层 id 经 ASSIGNABLE_MODULES 回退解析，无需在此映射）
  'docs-usage': 'docs',
  'docs-config': 'docs',
};

// 返回 section 所属的可授予模块 id；null 表示默认开放/非模块门禁（如 dashboard/标书生成/settings）。
export function getModuleForSection(section: SectionId): SectionId | null {
  if (SECTION_TO_MODULE[section]) return SECTION_TO_MODULE[section] as SectionId;
  const assignable = ASSIGNABLE_MODULES.find((m) => m.id === section);
  return assignable ? assignable.id : null;
}

// 判定某 section 对给定用户是否可访问。
// admin → 全部；user-management → 仅 admin；默认开放 → 全员；否则需 modules 含所属模块。
export function canAccessSection(
  role: string | undefined,
  modules: string[] | undefined,
  section: SectionId,
): boolean {
  if (role === 'admin') return true;
  if (section === 'user-management') return false;
  if (section === 'prompt-management') return false;
  if ((DEFAULT_OPEN_MODULES as string[]).includes(section)) return true;
  const mod = getModuleForSection(section);
  if (mod === null) return true; // settings 等非门禁项默认放行
  return Boolean(modules?.includes(mod));
}
