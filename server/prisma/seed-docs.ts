// 一次性种子：把 13 篇文档 md 导入 docs_articles。
// 运行：在 server 目录执行 npx tsx prisma/seed-docs.ts
// 幂等：upsert by id。update 只刷 title+content，不动 sortOrder（保留管理员的手动排序）。
//   id 固定：usage-01..08 / config-01..04 / faq；管理员新建的走 cuid。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, 'seed-docs');

type Section = 'usage' | 'config' | 'faq';
const SEED: { id: string; section: Section; title: string; file: string; sortOrder: number }[] = [
  { id: 'usage-01', section: 'usage', title: '生成技术方案', file: '使用/01-生成技术方案.md', sortOrder: 1 },
  { id: 'usage-02', section: 'usage', title: '已有方案扩写', file: '使用/02-已有方案扩写.md', sortOrder: 2 },
  { id: 'usage-03', section: 'usage', title: '知识库使用教程', file: '使用/03-使用文档知识库.md', sortOrder: 3 },
  { id: 'usage-04', section: 'usage', title: '标书查重', file: '使用/04-标书查重.md', sortOrder: 4 },
  { id: 'usage-05', section: 'usage', title: '废标项检查', file: '使用/05-废标项检查.md', sortOrder: 5 },
  { id: 'usage-06', section: 'usage', title: '问题FAQ使用教程', file: '使用/07-问题FAQ.md', sortOrder: 6 },
  { id: 'usage-07', section: 'usage', title: '用户管理使用教程', file: '使用/08-用户管理.md', sortOrder: 7 },
  { id: 'usage-08', section: 'usage', title: '提示词管理使用教程', file: '使用/09-提示词管理.md', sortOrder: 8 },
  { id: 'faq', section: 'faq', title: '常见问题', file: '使用/06-常见问题.md', sortOrder: 1 },
  { id: 'config-01', section: 'config', title: '配置文本模型', file: '配置/01-配置文本模型.md', sortOrder: 1 },
  { id: 'config-02', section: 'config', title: '配置生图模型', file: '配置/02-配置生图模型.md', sortOrder: 2 },
  { id: 'config-03', section: 'config', title: '选择文件解析方式', file: '配置/03-选择文件解析方式.md', sortOrder: 3 },
  { id: 'config-04', section: 'config', title: '智能体配置', file: '配置/04-智能体配置.md', sortOrder: 4 },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    for (const s of SEED) {
      const content = fs.readFileSync(path.join(SEED_DIR, s.file), 'utf8');
      await prisma.docsArticle.upsert({
        where: { id: s.id },
        create: { id: s.id, section: s.section, title: s.title, content, sortOrder: s.sortOrder },
        update: { section: s.section, title: s.title, content },
      });
      console.log('seeded', s.id, s.title);
    }
    console.log('done:', SEED.length, 'articles');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
