// 文档 tab 类型。运行时文档内容由 DB（DocsArticle，section=usage/config/faq）驱动，
// 见 client/src/features/docs/api/docs.ts； DocsPage/FeedbackPage 不再读静态 md。
// 下面的 DOCS_SECTIONS 仅作「初始结构参考」（实际种子映射在 server/prisma/seed-docs.ts）。

export interface DocNavItem {
  id: string;
  title: string;
  file: string;
}

export interface DocSection {
  id: 'usage' | 'config';
  label: string;
  items: DocNavItem[];
}

export const DOCS_SECTIONS: DocSection[] = [
  {
    id: 'usage',
    label: '使用',
    items: [
      { id: 'usage-01', title: '生成技术方案', file: '/docs/使用/01-生成技术方案.md' },
      { id: 'usage-02', title: '已有方案扩写', file: '/docs/使用/02-已有方案扩写.md' },
      { id: 'usage-03', title: '知识库使用教程', file: '/docs/使用/03-使用文档知识库.md' },
      { id: 'usage-04', title: '标书查重', file: '/docs/使用/04-标书查重.md' },
      { id: 'usage-05', title: '废标项检查', file: '/docs/使用/05-废标项检查.md' },
      { id: 'usage-06', title: '问题FAQ使用教程', file: '/docs/使用/07-问题FAQ.md' },
      { id: 'usage-07', title: '用户管理使用教程', file: '/docs/使用/08-用户管理.md' },
      { id: 'usage-08', title: '提示词管理使用教程', file: '/docs/使用/09-提示词管理.md' },
    ],
  },
  {
    id: 'config',
    label: '配置',
    items: [
      { id: 'config-01', title: '配置文本模型', file: '/docs/配置/01-配置文本模型.md' },
      { id: 'config-02', title: '配置生图模型', file: '/docs/配置/02-配置生图模型.md' },
      { id: 'config-03', title: '选择文件解析方式', file: '/docs/配置/03-选择文件解析方式.md' },
      { id: 'config-04', title: '智能体配置', file: '/docs/配置/04-智能体配置.md' },
    ],
  },
];

// 反馈 tab 的常见问题现为 DB 文章（section='faq'），由 FeedbackPage 经 useDocs/useDoc 渲染。

export type DocsTab = 'usage' | 'config' | 'feedback';
